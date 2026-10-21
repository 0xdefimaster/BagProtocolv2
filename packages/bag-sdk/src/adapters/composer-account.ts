import { keccak256 } from 'viem';
import type { ExecutionTrustPolicy } from '../execution';
import type { Hex } from '../types';

export interface ComposerDeployment {
  chainId: number;
  /** Independently reviewed factory, never copied from a compile response. */
  factory: Hex;
  /** Independently pinned runtime hash of that factory on this chain. */
  factoryCodeHash: Hex;
}

export interface ComposerAccountClient {
  getChainId(): Promise<number>;
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null }>;
  getCode(args: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber: bigint }): Promise<unknown>;
}

export interface ComposerAccount {
  readonly chainId: number;
  readonly signer: Hex;
  readonly factory: Hex;
  readonly factoryCodeHash: Hex;
  readonly proxy: Hex;
  readonly proxyDeployed: boolean;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly trust: Readonly<ExecutionTrustPolicy>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const CODE = /^0x(?:[0-9a-fA-F]{2})*$/;
const nonzero = (address: unknown): address is Hex => typeof address === 'string' && ADDRESS.test(address) && !/^0x0{40}$/i.test(address);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const ABI = [
  { type: 'function', name: 'predictProxyAddress', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** Resolve per-wallet trust from a caller-pinned factory, without a Composer API response. */
export async function resolveLifiComposerAccount(options: { chainId: number; signer: Hex; deployment: ComposerDeployment; client: ComposerAccountClient }): Promise<ComposerAccount> {
  const { chainId, signer, deployment, client } = options;
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !nonzero(signer) || !deployment || deployment.chainId !== chainId ||
      !nonzero(deployment.factory) || !HASH.test(deployment.factoryCodeHash) || /^0x0{64}$/i.test(deployment.factoryCodeHash)) throw new Error('Composer account: invalid chain, signer or independently pinned deployment.');
  if (await client.getChainId() !== chainId) throw new Error('Composer account: RPC chain mismatch.');
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  if (typeof blockNumber !== 'bigint' || blockNumber < BigInt(0)) throw new Error('Composer account: invalid block number.');
  const block = await client.getBlock({ blockNumber });
  if (!block.hash || !HASH.test(block.hash)) throw new Error('Composer account: missing canonical block hash.');
  const factoryCode = await client.getCode({ address: deployment.factory, blockNumber });
  if (!factoryCode || factoryCode === '0x' || !CODE.test(factoryCode) || !same(keccak256(factoryCode), deployment.factoryCodeHash)) throw new Error('Composer account: factory runtime does not match the independently pinned hash.');
  const predicted = await client.readContract({ address: deployment.factory, abi: ABI, functionName: 'predictProxyAddress', args: [signer], blockNumber });
  if (!nonzero(predicted) || same(predicted, signer) || same(predicted, deployment.factory)) throw new Error('Composer account: invalid predicted proxy.');
  const proxy = predicted.toLowerCase() as Hex;
  const code = await client.getCode({ address: proxy, blockNumber });
  if (code !== undefined && !CODE.test(code)) throw new Error('Composer account: invalid proxy runtime.');
  const proxyDeployed = code !== undefined && code !== '0x';
  if (proxyDeployed) {
    const [owner, factory] = await Promise.all([
      client.readContract({ address: proxy, abi: ABI, functionName: 'owner', blockNumber }),
      client.readContract({ address: proxy, abi: ABI, functionName: 'factory', blockNumber }),
    ]);
    if (!same(owner, signer) || !same(factory, deployment.factory)) throw new Error('Composer account: deployed proxy owner or factory mismatch.');
  }
  const finalBlock = await client.getBlock({ blockNumber });
  if (!same(finalBlock.hash, block.hash)) throw new Error('Composer account: canonical inclusion changed during reads.');
  return Object.freeze({
    chainId, signer: signer.toLowerCase() as Hex, factory: deployment.factory.toLowerCase() as Hex,
    factoryCodeHash: deployment.factoryCodeHash.toLowerCase() as Hex, proxy, proxyDeployed, blockNumber, blockHash: block.hash,
    trust: Object.freeze({ chainId,
      allowedTransactionTargets: Object.freeze([proxyDeployed ? proxy : deployment.factory.toLowerCase()]),
      // Direct-deposit approval belongs to the predicted proxy, including first use.
      allowedApprovalSpenders: Object.freeze([proxy]),
    }),
  });
}
