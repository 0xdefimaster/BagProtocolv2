import crypto from 'node:crypto';
import { decodeFunctionData, type Hex } from 'viem';
import {
  BagCreationPendingError,
  BagCreationVerificationError,
  BagDeploymentAdapter,
  PrepareBagCreationParams,
  PreparedBagCreationTx,
  VerifyBagCreationParams,
  VerifiedBagCreation,
} from '@/lib/blockchain/adapter';
import { deriveOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { encodeFunctionData } from 'viem';
import { bagFactoryAbi } from '@/lib/blockchain/evm/factory-abi';

// -----------------------------------------------------------------------------
// TEST DOUBLE — NOT a blockchain and NOT the production adapter. It lives under
// __tests__/ so no production module can import it (there is deliberately no
// mock fallback in lib/server/deploy-bag.ts). It only decides what "the chain"
// answers so the ORCHESTRATION + DATABASE behaviour of prepare/confirm can be
// tested against a real Postgres. The real adapter's verification logic is
// covered by lib/blockchain/evm/__tests__/adapter.test.ts (mocked viem client)
// and by bag-deployment-local-evm.integration.test.ts (a real local EVM).
// -----------------------------------------------------------------------------

export const FAKE_FACTORY = '0xfac70fac70fac70fac70fac70fac70fac70fac70' as Hex;
export const FAKE_CHAIN_ID = 4663;

interface FakeTx {
  from: string;
  to: string;
  status: 'success' | 'reverted';
  mined: boolean;
  offChainRef: Hex;
  compositionHash: Hex;
  block: number;
}

export class FakeChain implements BagDeploymentAdapter {
  readonly name = 'fake-chain (TEST DOUBLE)';
  readonly isLive = false;
  readonly factoryAddress: string = FAKE_FACTORY;
  readonly txs = new Map<string, FakeTx>();
  private nextBlock = 5000;
  verifyCalls = 0;

  /** Simulates a wallet sending `createBag`. Returns the tx hash the wallet would hand back. */
  submit(o: { from: string; offChainRef: Hex; compositionHash: Hex; to?: string; status?: 'success' | 'reverted'; mined?: boolean }): Hex {
    const hash = `0x${crypto.randomBytes(32).toString('hex')}` as Hex;
    this.txs.set(hash, {
      from: o.from,
      to: o.to ?? FAKE_FACTORY,
      status: o.status ?? 'success',
      mined: o.mined ?? true,
      offChainRef: o.offChainRef,
      compositionHash: o.compositionHash,
      block: this.nextBlock++,
    });
    return hash;
  }
  mine(hash: string) {
    const tx = this.txs.get(hash.toLowerCase());
    if (tx) tx.mined = true;
  }

  async prepareBagCreation(p: PrepareBagCreationParams): Promise<PreparedBagCreationTx> {
    return {
      to: FAKE_FACTORY,
      data: encodeFunctionData({ abi: bagFactoryAbi, functionName: 'createBag', args: [p.offChainRef, p.compositionHash, p.metadataURI, p.isMutable] }),
      chainId: FAKE_CHAIN_ID,
      value: '0',
    };
  }

  async hasBagOnChain(creator: `0x${string}`, offChainRef: `0x${string}`): Promise<boolean> {
    return [...this.txs.values()].some((t) => t.status === 'success' && t.mined && t.from.toLowerCase() === creator.toLowerCase() && t.offChainRef === offChainRef);
  }

  async verifyBagCreation(p: VerifyBagCreationParams): Promise<VerifiedBagCreation> {
    this.verifyCalls++;
    const tx = this.txs.get(p.txHash.toLowerCase());
    if (!tx || !tx.mined) throw new BagCreationPendingError(`tx ${p.txHash} not mined yet`);
    if (tx.to.toLowerCase() !== p.expectedFactoryAddress.toLowerCase()) throw new BagCreationVerificationError('wrong target');
    if (tx.from.toLowerCase() !== p.expectedCreator.toLowerCase()) throw new BagCreationVerificationError('wrong sender');
    if (tx.status !== 'success') throw new BagCreationVerificationError('reverted');
    if (tx.offChainRef !== p.expectedOffChainRef) throw new BagCreationVerificationError('wrong offChainRef');
    if (tx.compositionHash !== p.expectedCompositionHash) throw new BagCreationVerificationError('wrong compositionHash');
    return {
      contractAddress: `0x${crypto.createHash('sha256').update(p.txHash.toLowerCase()).digest('hex').slice(0, 40)}`,
      txHash: p.txHash.toLowerCase(),
      blockNumber: tx.block,
      onChainBagId: deriveOnChainBagId(tx.from, tx.offChainRef).toLowerCase() as Hex,
      creatorAddress: tx.from.toLowerCase() as Hex,
      offChainRef: tx.offChainRef,
    };
  }
}

/** Decodes prepare()'s calldata so tests can assert exactly what a wallet would be asked to sign. */
export function decodeCreateBag(data: Hex) {
  const decoded = decodeFunctionData({ abi: bagFactoryAbi, data });
  const [offChainRef, compositionHash, metadataURI, isMutable] = decoded.args as unknown as [Hex, Hex, string, boolean];
  return { functionName: decoded.functionName, offChainRef, compositionHash, metadataURI, isMutable };
}
