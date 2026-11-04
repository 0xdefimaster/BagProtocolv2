import { isNativeToken, normalizeAddress } from '../chains';
import { BagSdkError } from '../errors';
import type { BagChain } from '../chains';
import type { ContractReader } from '../registry';
import type { BagDefinition } from '../types';
import type { TokenInfo } from '../validate';
export { withReceiptEvidence, type ReceiptEvidenceOptions } from './receipt-rpc';

// -----------------------------------------------------------------------------
// Chain adapter: token facts for `validateBag(bag, { tokens })`. The caller
// passes its own viem client per chain; the SDK has no RPC.
// -----------------------------------------------------------------------------

const ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

/** Reads ERC-20 decimals and resolves native ETH's known 18 decimals without calling decimals() on address(0). */
export async function readTokenDecimals(definition: BagDefinition, clientFor: (chain: BagChain) => ContractReader): Promise<TokenInfo[]> {
  return Promise.all(
    definition.assets.map(async (a) => ({
      chain: a.chain,
      address: a.address,
      decimals: isNativeToken(a.address)
        ? 18
        : Number(await clientFor(a.chain).readContract({ address: a.address as `0x${string}`, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })),
    }))
  );
}

// -----------------------------------------------------------------------------
// Dynamic token recognition by chain id + address. READ ONLY.
//
// ERC20 means: the address has code and answers decimals() (0–36), totalSupply() and balanceOf(). symbol()/name()
// are read when available (some tokens return bytes32 or nothing). Recognition is NOT a safety or swappability
// verdict: transfer restrictions, issuer gates, liquidity and price sources are checked elsewhere
// (asset-capabilities.ts, the provider's route, the price source).
// -----------------------------------------------------------------------------

export interface TokenInspectionClient {
  getChainId(): Promise<number>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export type TokenInspection =
  | { kind: 'NATIVE'; chainId: number; address: string; decimals: 18 }
  | { kind: 'ERC20'; chainId: number; address: string; decimals: number; symbol: string | null; name: string | null; totalSupply: bigint }
  | { kind: 'NOT_A_CONTRACT'; chainId: number; address: string }
  | { kind: 'NOT_ERC20'; chainId: number; address: string; failed: ('decimals' | 'totalSupply' | 'balanceOf')[] };

const ERC20_INSPECT_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

export async function inspectToken(input: { chainId: number; address: string; client: TokenInspectionClient }): Promise<TokenInspection> {
  const { chainId, client } = input;
  if (!ADDRESS_RE.test(input.address)) throw new BagSdkError('INVALID_ARGUMENT', 'inspectToken: address must be a 20-byte hex address.');
  const address = normalizeAddress(input.address);
  if (isNativeToken(address)) return { kind: 'NATIVE', chainId, address, decimals: 18 };
  let live: number;
  try {
    live = Number(await client.getChainId());
  } catch {
    throw new BagSdkError('RPC_READ_FAILED');
  }
  if (live !== chainId) throw new BagSdkError('CHAIN_MISMATCH', `inspectToken: client is on chain ${live}, the token is on ${chainId}.`);
  let code: string | undefined;
  try {
    code = await client.getCode({ address: address as `0x${string}` });
  } catch {
    throw new BagSdkError('RPC_READ_FAILED');
  }
  if (!code || code === '0x') return { kind: 'NOT_A_CONTRACT', chainId, address };

  const read = async (functionName: string, args?: readonly unknown[]): Promise<{ ok: true; value: unknown } | { ok: false }> => {
    try {
      return { ok: true, value: await client.readContract({ address: address as `0x${string}`, abi: ERC20_INSPECT_ABI, functionName, args }) };
    } catch {
      return { ok: false };
    }
  };
  const [decimals, totalSupply, balance, symbol, name] = await Promise.all([read('decimals'), read('totalSupply'), read('balanceOf', [ZERO]), read('symbol'), read('name')]);
  const failed: ('decimals' | 'totalSupply' | 'balanceOf')[] = [];
  const dec = decimals.ok ? Number(decimals.value) : NaN;
  if (!decimals.ok || !Number.isInteger(dec) || dec < 0 || dec > 36) failed.push('decimals');
  if (!totalSupply.ok || typeof totalSupply.value !== 'bigint') failed.push('totalSupply');
  if (!balance.ok || typeof balance.value !== 'bigint') failed.push('balanceOf');
  if (failed.length > 0) return { kind: 'NOT_ERC20', chainId, address, failed };
  const str = (r: { ok: true; value: unknown } | { ok: false }) => (r.ok && typeof r.value === 'string' && r.value.length > 0 && r.value.length <= 64 ? r.value : null);
  return { kind: 'ERC20', chainId, address, decimals: dec, symbol: str(symbol), name: str(name), totalSupply: (totalSupply as { ok: true; value: bigint }).value };
}
