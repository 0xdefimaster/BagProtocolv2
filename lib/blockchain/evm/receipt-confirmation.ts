import type { Hex, PublicClient, TransactionReceipt } from 'viem';

// -----------------------------------------------------------------------------
// Bounded, per-call receipt + confirmation-depth check for Bag deployment
// verification (lib/blockchain/evm/adapter.ts, checklist item 2).
//
// WHY THIS EXISTS INSTEAD OF viem's `waitForTransactionReceipt({ confirmations })`:
// viem (verified against the installed 2.56.0 source,
// `actions/public/waitForTransactionReceipt.js` + `utils/observe.js`) dedupes
// concurrent waits for the same `(client.uid, hash)` through a shared
// "observer". When the first caller's receipt arrives it resolves every
// caller registered AT THAT MOMENT, but only unregisters ITSELF — the other
// callers' listeners stay in the shared cache until each one's own `timeout`
// timer fires. Any wait for the same hash that starts inside that window sees
// a non-empty listener list, attaches to an observer whose work already
// finished, and is never resolved: it rejects with
// `WaitForTransactionReceiptTimeoutError` even though the transaction has
// been mined all along. `confirmBagDeployment()` turned that into a spurious
// `PENDING` — which is exactly the intermittent failure of the local-EVM
// "CONCURRENT confirms" test (8 staggered requests for one hash on one
// shared client), and the same would happen in production to a double-clicked
// or retried confirm hitting a warm server process.
//
// This helper keeps NO state outside its own stack frame (no observers, no
// caches, no shared timers), so concurrent calls for the same hash cannot
// interfere. It is deliberately simple:
//   - re-reads the receipt on EVERY poll (never trusts a receipt seen earlier:
//     if a reorg drops or moves the transaction, the next poll sees that);
//   - measures depth against a FRESH head (`getBlockNumber({ cacheTime: 0 })`
//     — viem otherwise serves a per-client cached block number for up to
//     `pollingInterval` ms, which would under-count confirmations);
//   - is bounded by `timeoutMs` (at most ceil(timeoutMs / pollIntervalMs) + 1
//     polls), then reports PENDING rather than hanging the HTTP request;
//   - treats ONLY "receipt not found" as "not mined yet"; any other RPC error
//     propagates unchanged (an outage is not PENDING).
//
// Deliberately NOT carried over from viem: its "replacement" detection, which
// would resolve with the receipt of a DIFFERENT (speed-up/cancel) transaction
// under the original hash. For deployment verification that is wrong — the
// person must confirm with the hash that actually mined, which is verified on
// its own merits. A replaced transaction therefore just stays PENDING here.
// -----------------------------------------------------------------------------

export const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 1_000;

export type ReceiptConfirmationClient = Pick<PublicClient, 'getTransactionReceipt' | 'getBlockNumber'>;

export type ReceiptConfirmationResult =
  | { status: 'CONFIRMED'; receipt: TransactionReceipt; depth: bigint }
  /** No receipt within the bounded wait: not mined yet (or dropped/replaced). */
  | { status: 'NOT_MINED' }
  /** Mined, but fewer than the required confirmations by the end of the bounded wait. */
  | { status: 'INSUFFICIENT_DEPTH'; receipt: TransactionReceipt; depth: bigint };

export interface WaitForConfirmedReceiptOptions {
  hash: Hex;
  /** Required depth; 1 = "mined in the current canonical chain". */
  confirmations: number;
  /** Upper bound on the total wait. */
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Injectable for deterministic unit tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isReceiptNotFound(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError';
}

async function readReceipt(client: ReceiptConfirmationClient, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return (await client.getTransactionReceipt({ hash })) ?? null;
  } catch (err) {
    if (isReceiptNotFound(err)) return null;
    throw err;
  }
}

export async function waitForConfirmedReceipt(
  client: ReceiptConfirmationClient,
  opts: WaitForConfirmedReceiptOptions
): Promise<ReceiptConfirmationResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? DEFAULT_RECEIPT_POLL_INTERVAL_MS);
  const required = BigInt(Math.max(1, opts.confirmations));
  const hash = opts.hash.toLowerCase() as Hex;
  const deadline = now() + Math.max(0, opts.timeoutMs);

  for (;;) {
    let result: ReceiptConfirmationResult = { status: 'NOT_MINED' };
    const receipt = await readReceipt(client, hash);
    if (receipt) {
      if (receipt.transactionHash.toLowerCase() !== hash) {
        // A node answering for a different transaction is malformed, not "pending".
        throw new Error(`RPC returned a receipt for ${receipt.transactionHash} when asked for ${hash}.`);
      }
      // A receipt from the node means the tx is in its current canonical chain: depth >= 1 by definition.
      let depth = BigInt(1);
      if (required > BigInt(1)) {
        const head = await client.getBlockNumber({ cacheTime: 0 });
        depth = head >= receipt.blockNumber ? head - receipt.blockNumber + BigInt(1) : BigInt(0);
      }
      if (depth >= required) return { status: 'CONFIRMED', receipt, depth };
      result = { status: 'INSUFFICIENT_DEPTH', receipt, depth };
    }

    const remaining = deadline - now();
    if (remaining <= 0) return result;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
