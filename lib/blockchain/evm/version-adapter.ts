import { decodeEventLog, encodeFunctionData, type Hex, type PublicClient } from 'viem';
import { ChainId } from '@/types/basket-protocol';
import { EvmChainConfig, getEvmChainConfig } from './config';
import { createEvmPublicClient } from './client';
import { bagFactoryAbi } from './factory-abi';
import { bagAbi } from './bag-abi';
import { waitForConfirmedReceipt } from './receipt-confirmation';

// -----------------------------------------------------------------------------
// Mutable-Bag versioning on-chain — the version-update sibling of adapter.ts
// (deployment). Same USER-SIGNED model and the same shape: a pure calldata
// encoder plus a READ-ONLY verifier. This module never sends a transaction and
// holds no key; the creator's own wallet calls
// `BagFactory.recordBagVersion(offChainRef, expectedCurrentVersion, hash, uri)`.
//
// Verification checklist (every item enforced):
//   1. the transaction exists (else PENDING)
//   2. mined, successful, required confirmations (bounded wait, else PENDING)
//   3. sent TO the configured BagFactory, FROM the expected creator wallet
//   4. exactly one BagVersionRecorded from the factory, whose
//      bagId / creator / bag / version / compositionHash / metadataURI all equal
//      the SERVER's expectations (never the client's)
//   5. exactly one CompositionUpdated from THAT Bag, agreeing with (4)
// -----------------------------------------------------------------------------

export class BagVersionPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BagVersionPendingError';
  }
}
export class BagVersionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BagVersionVerificationError';
  }
}

export interface PrepareRecordVersionParams {
  offChainRef: Hex;
  expectedCurrentVersion: number;
  compositionHash: Hex;
  metadataURI: string;
}

export interface VerifyRecordVersionParams {
  txHash: string;
  expectedCreator: Hex;
  expectedOnChainBagId: Hex;
  expectedBagAddress: Hex;
  expectedNewVersion: number;
  expectedCompositionHash: Hex;
  expectedMetadataURI: string;
}

export interface VerifiedRecordVersion {
  txHash: Hex;
  blockNumber: number;
  newVersion: number;
}

export interface LocatedVersion {
  txHash: Hex;
  compositionHash: Hex;
  metadataURI: string;
}

export interface BagVersionAdapter {
  factoryAddress: Hex;
  chainId: number;
  /** `Bag.version()` read from the chain — the authority for the next update's `expectedCurrentVersion`. */
  readBagVersion(bagAddress: Hex): Promise<number>;
  /** The chain head: stored with a proposal at prepare, since its transaction cannot be mined earlier. */
  readBlockNumber(): Promise<bigint>;
  /**
   * The transaction that made `bagAddress` reach `version`, located by its `CompositionUpdated` log (`version` is an
   * indexed topic, and a Bag reaches each version exactly once), searched from `fromBlock` to the head. Only a locator:
   * the caller must still verify that transaction's receipt (verifyRecordVersion). Null when no such log exists.
   */
  findVersionTransaction(bagAddress: Hex, version: number, fromBlock: bigint): Promise<LocatedVersion | null>;
  prepareRecordVersion(params: PrepareRecordVersionParams): { to: Hex; data: Hex; chainId: number };
  verifyRecordVersion(params: VerifyRecordVersionParams): Promise<VerifiedRecordVersion>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** Log search window when an RPC refuses one query over the whole range. */
export const LOG_SEARCH_CHUNK = BigInt(50_000);
/** Beyond this many windows the search gives up (the caller reports it; it never guesses). */
export const LOG_SEARCH_MAX_CHUNKS = 200;
const compositionUpdatedEvent = bagAbi.find((x) => x.type === 'event' && x.name === 'CompositionUpdated') as Extract<(typeof bagAbi)[number], { type: 'event'; name: 'CompositionUpdated' }>;

export function createEvmBagVersionAdapter(config: EvmChainConfig, client?: PublicClient): BagVersionAdapter {
  const rpc = () => client ?? createEvmPublicClient(config);

  return {
    factoryAddress: config.factoryAddress,
    chainId: config.viemChain.id,

    async readBagVersion(bagAddress) {
      return Number(await rpc().readContract({ address: bagAddress, abi: bagAbi, functionName: 'version' }));
    },

    async readBlockNumber() {
      return rpc().getBlockNumber();
    },

    async findVersionTransaction(bagAddress, version, fromBlock) {
      const c = rpc();
      const head = await c.getBlockNumber();
      if (fromBlock > head) return null;
      const query = (from: bigint, to: bigint) =>
        c.getLogs({ address: bagAddress, event: compositionUpdatedEvent, args: { version: BigInt(version) }, fromBlock: from, toBlock: to, strict: true });
      type Found = { transactionHash: Hex | null; removed?: boolean; args: { compositionHash?: Hex; metadataURI?: string } };
      const pick = (logs: Found[]): LocatedVersion | null => {
        const live = logs.filter((l) => !l.removed && l.transactionHash);
        if (live.length > 1) throw new BagVersionVerificationError(`Bag ${bagAddress} reports version ${version} ${live.length} times.`);
        if (live.length === 0) return null;
        const { compositionHash, metadataURI } = live[0].args;
        if (!compositionHash || typeof metadataURI !== 'string') throw new BagVersionVerificationError(`Undecodable CompositionUpdated log for version ${version}.`);
        return { txHash: live[0].transactionHash as Hex, compositionHash, metadataURI };
      };
      try {
        return pick((await query(fromBlock, head)) as Found[]);
      } catch (err) {
        if (err instanceof BagVersionVerificationError) throw err;
        // Many RPCs cap the block range of one query: search in windows instead.
      }
      let chunks = 0;
      for (let from = fromBlock; from <= head; from += LOG_SEARCH_CHUNK) {
        if (++chunks > LOG_SEARCH_MAX_CHUNKS) throw new Error(`Searched ${LOG_SEARCH_MAX_CHUNKS} log windows from block ${fromBlock} without reaching the head.`);
        const to = from + LOG_SEARCH_CHUNK - BigInt(1) < head ? from + LOG_SEARCH_CHUNK - BigInt(1) : head;
        const found = pick((await query(from, to)) as Found[]);
        if (found) return found;
      }
      return null;
    },

    prepareRecordVersion(p) {
      const data = encodeFunctionData({
        abi: bagFactoryAbi,
        functionName: 'recordBagVersion',
        args: [p.offChainRef, BigInt(p.expectedCurrentVersion), p.compositionHash, p.metadataURI],
      });
      return { to: config.factoryAddress, data, chainId: config.viemChain.id };
    },

    async verifyRecordVersion(p) {
      const fail = (m: string): never => {
        throw new BagVersionVerificationError(m);
      };
      if (!TX_HASH_RE.test(p.txHash)) fail(`"${p.txHash}" is not a valid transaction hash.`);
      const txHash = p.txHash.toLowerCase() as Hex;
      const c = rpc();

      let tx;
      try {
        tx = await c.getTransaction({ hash: txHash });
      } catch (err) {
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
        if (name === 'TransactionNotFoundError') throw new BagVersionPendingError(`No transaction found for ${txHash} yet.`);
        throw err;
      }
      // `tx.to` may be a smart-account router rather than the factory (see adapter.ts); the factory-emitted
      // BagVersionRecorded below, with this Bag's id and creator, is what binds the update.
      if (!tx.to) fail(`Transaction ${txHash} is a contract creation, not a call that reaches the BagFactory.`);
      if (!same(tx.from, p.expectedCreator)) fail(`Transaction ${txHash} was sent from ${tx.from}, not the Bag's creator wallet ${p.expectedCreator}.`);

      const confirmation = await waitForConfirmedReceipt(c, { hash: txHash, confirmations: config.confirmations, timeoutMs: config.receiptTimeoutMs });
      if (confirmation.status === 'NOT_MINED') throw new BagVersionPendingError(`Transaction ${txHash} is not yet mined — retry shortly.`);
      if (confirmation.status === 'INSUFFICIENT_DEPTH') {
        throw new BagVersionPendingError(`Transaction ${txHash} has ${confirmation.depth} of ${config.confirmations} required confirmation(s).`);
      }
      const { receipt } = confirmation;
      if (receipt.status !== 'success') fail(`Transaction ${txHash} reverted — no version was recorded.`);

      const decode = <A extends typeof bagFactoryAbi | typeof bagAbi>(abi: A, log: (typeof receipt.logs)[number]) => {
        try {
          return decodeEventLog({ abi, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      };
      const recorded = receipt.logs
        .filter((l) => same(l.address, config.factoryAddress))
        .map((l) => decode(bagFactoryAbi, l))
        .filter((e): e is NonNullable<typeof e> & { eventName: 'BagVersionRecorded' } => e?.eventName === 'BagVersionRecorded');
      if (recorded.length !== 1) fail(`Transaction ${txHash} has ${recorded.length} BagVersionRecorded events from the factory (expected exactly 1).`);
      const ev = recorded[0].args as { bagId: Hex; creator: Hex; bag: Hex; version: bigint; compositionHash: Hex; metadataURI: string };

      if (!same(ev.bagId, p.expectedOnChainBagId)) fail(`BagVersionRecorded.bagId ${ev.bagId} is not this Bag's on-chain id ${p.expectedOnChainBagId}.`);
      if (!same(ev.bag, p.expectedBagAddress)) fail(`BagVersionRecorded.bag ${ev.bag} is not this Bag's deployed address ${p.expectedBagAddress}.`);
      if (!same(ev.creator, p.expectedCreator)) fail(`BagVersionRecorded.creator ${ev.creator} is not the creator wallet ${p.expectedCreator}.`);
      if (Number(ev.version) !== p.expectedNewVersion) fail(`BagVersionRecorded.version ${ev.version} is not the expected ${p.expectedNewVersion} (stale or out-of-order update).`);
      if (!same(ev.compositionHash, p.expectedCompositionHash)) fail(`BagVersionRecorded.compositionHash ${ev.compositionHash} does not match the new recipe's ${p.expectedCompositionHash}.`);
      if (ev.metadataURI !== p.expectedMetadataURI) fail(`BagVersionRecorded.metadataURI "${ev.metadataURI}" does not match "${p.expectedMetadataURI}".`);

      const updated = receipt.logs
        .filter((l) => same(l.address, p.expectedBagAddress))
        .map((l) => decode(bagAbi, l))
        .filter((e): e is NonNullable<typeof e> & { eventName: 'CompositionUpdated' } => e?.eventName === 'CompositionUpdated');
      if (updated.length !== 1) fail(`Transaction ${txHash} has ${updated.length} CompositionUpdated events from the Bag (expected exactly 1).`);
      const u = updated[0].args as { version: bigint; compositionHash: Hex; metadataURI: string };
      if (u.version !== ev.version || !same(u.compositionHash, ev.compositionHash) || u.metadataURI !== ev.metadataURI) {
        fail(`Bag.CompositionUpdated disagrees with BagVersionRecorded (tx ${txHash}).`);
      }

      return { txHash, blockNumber: Number(receipt.blockNumber), newVersion: Number(ev.version) };
    },
  };
}

export function createBagVersionAdapter(chain: ChainId): BagVersionAdapter {
  return createEvmBagVersionAdapter(getEvmChainConfig(chain));
}
