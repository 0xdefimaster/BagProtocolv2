import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing';
import { planRebalance, type RebalancePlanBuy, type RebalancePlanSell } from '@/lib/server/rebalance-quote';
import { findActiveRedeemIntentForBag } from '@/lib/server/redeem-intent-repo';
import { TX_HASH_RE } from '@/lib/server/intent-tx-claims';
import { trackComposerTransaction } from '@/lib/blockchain/composer-status';
import { findComposerTransactionFromWallet, type FindComposerTransactionInput } from '@/lib/blockchain/composer-tx-search';

// -----------------------------------------------------------------------------
// R3 — a user-signed rebalance of one position (migration 0056).
//
//   create  planRebalance (R2's live Composer route from the position's effective
//           holdings at one block) recorded as a READY intent with the exact
//           transaction and approvals; only then is the transaction handed to the
//           wallet. One open rebalance per position, none while a sale is open.
//   verify  the reported hash must BE that transaction (sender, target, calldata,
//           value; a wallet batch carrying it counts, composer-status.ts). From the
//           receipt: what each sold token really left the wallet (net of unspent
//           input returned) and what each bought token really brought in. Then
//           apply_rebalance_execution books it: no realized P&L, no fee, the basis
//           moves from the sold to the bought legs (position-pnl.ts).
//   settle  an intent whose report never arrived (tab closed) is found from the
//           wallet's Transfer logs (composer-tx-search.ts) and verified the same way;
//           otherwise it expires. Run by the hourly pass and when the wallet connects.
//
// The backend never signs. Nothing the client sends is trusted except a hash to look up.
// -----------------------------------------------------------------------------

/** How long a planned rebalance may wait for the wallet: the quote goes stale fast. */
export const REBALANCE_INTENT_TTL_MS = 5 * 60 * 1000;

export type RebalanceIntentStatus = 'READY' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export interface RebalanceIntent {
  id: string;
  userId: string;
  walletAddress: string;
  bagId: string;
  targetVersion: number;
  status: RebalanceIntentStatus;
  sells: RebalancePlanSell[];
  buys: RebalancePlanBuy[];
  composerTransaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    approvals: { token: string; spender: string; amountRaw: string }[];
  };
  txHash: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  result: { sold: { address: string; quantityRaw: string }[]; bought: { address: string; quantityRaw: string }[] } | null;
  expiresAt: string;
  createdAt: string;
}

interface Row {
  id: string;
  user_id: string;
  wallet_address: string;
  bag_id: string;
  target_version: number;
  status: RebalanceIntentStatus;
  sells: RebalancePlanSell[];
  buys: RebalancePlanBuy[];
  composer_transaction: RebalanceIntent['composerTransaction'];
  tx_hash: string | null;
  failure_code: string | null;
  failure_message: string | null;
  result: RebalanceIntent['result'];
  expires_at: string;
  created_at: string;
}

const fromRow = (r: Row): RebalanceIntent => ({
  id: r.id,
  userId: r.user_id,
  walletAddress: r.wallet_address,
  bagId: r.bag_id,
  targetVersion: r.target_version,
  status: r.status,
  sells: r.sells,
  buys: r.buys,
  composerTransaction: r.composer_transaction,
  txHash: r.tx_hash,
  failureCode: r.failure_code,
  failureMessage: r.failure_message,
  result: r.result,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

/** What the client sees: the transaction only while it may still be signed. */
export function publicRebalanceIntent(intent: RebalanceIntent) {
  const { userId: _u, walletAddress: _w, composerTransaction, ...rest } = intent;
  return { ...rest, composerTransaction: intent.status === 'READY' ? composerTransaction : null };
}

async function getIntent(admin: SupabaseClient, id: string): Promise<RebalanceIntent | null> {
  const { data, error } = await admin.from('rebalance_intents').select().eq('id', id).maybeSingle<Row>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

async function update(admin: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('rebalance_intents').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function openRebalanceFor(admin: SupabaseClient, userId: string, bagId: string, now: Date): Promise<RebalanceIntent | null> {
  const { data, error } = await admin
    .from('rebalance_intents')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .in('status', ['READY', 'SUBMITTED'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Row>();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const intent = fromRow(data);
  // A READY intent past its expiry is no longer open for a new plan (the hourly pass settles or expires it).
  return intent.status === 'READY' && Date.parse(intent.expiresAt) <= now.getTime() ? null : intent;
}

/** Whether a rebalance of this position is waiting for the wallet or being confirmed (a sale must wait for it). */
export async function hasOpenRebalance(admin: SupabaseClient, userId: string, bagId: string, now: Date = new Date()): Promise<string | null> {
  return (await openRebalanceFor(admin, userId, bagId, now))?.id ?? null;
}

export type CreateRebalanceOutcome = { ok: true; intent: RebalanceIntent } | { ok: false; status: number; error: string };

export async function createRebalanceIntent(
  admin: SupabaseClient,
  client: PublicClient,
  priceProvider: PriceProvider,
  session: { userId: string; walletAddress: string },
  bagId: string,
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch; now?: Date }
): Promise<CreateRebalanceOutcome> {
  const now = options.now ?? new Date();
  if (await openRebalanceFor(admin, session.userId, bagId, now)) {
    return { ok: false, status: 409, error: 'A rebalance of this position is already waiting for your wallet or being confirmed.' };
  }
  if (await findActiveRedeemIntentForBag(admin, session.userId, bagId)) {
    return { ok: false, status: 409, error: 'A sale of this position is in progress; rebalance once it has settled.' };
  }
  const plan = await planRebalance(admin, client, priceProvider, session, bagId, options);
  if (!plan.ok) return { ok: false, status: plan.status, error: plan.error };

  const { data, error } = await admin
    .from('rebalance_intents')
    .insert({
      user_id: session.userId,
      wallet_address: session.walletAddress,
      bag_id: bagId,
      target_version: plan.targetVersion,
      status: 'READY',
      sells: plan.planSells,
      buys: plan.planBuys,
      composer_transaction: { ...plan.transaction, approvals: plan.approvals },
      expires_at: new Date(now.getTime() + REBALANCE_INTENT_TTL_MS).toISOString(),
    })
    .select()
    .single<Row>();
  if (error) throw new Error(error.message);
  return { ok: true, intent: fromRow(data) };
}

export type VerifyRebalanceOutcome = { ok: true; intent: RebalanceIntent } | { ok: false; status: number; error: string };

/** What the receipt shows, checked against the intent: net sold per sell leg, received per buy leg. */
export function rebalanceFillsFromReceipt(
  intent: Pick<RebalanceIntent, 'sells' | 'buys'>,
  received: Record<string, string>,
  sent: Record<string, string>
): { ok: true; sold: { leg: RebalancePlanSell; quantityRaw: bigint }[]; bought: { leg: RebalancePlanBuy; quantityRaw: bigint }[] } | { ok: false; message: string } {
  const amount = (m: Record<string, string>, address: string) => BigInt(m[address.toLowerCase()] ?? '0');
  const sold = intent.sells.map((leg) => ({ leg, quantityRaw: amount(sent, leg.address) - amount(received, leg.address) }));
  for (const s of sold) {
    if (s.quantityRaw <= BigInt(0) || s.quantityRaw > BigInt(s.leg.amountRaw)) {
      return { ok: false, message: `${s.leg.symbol}: the transaction moved ${s.quantityRaw} out of the wallet, planned ${s.leg.amountRaw}.` };
    }
  }
  const bought = intent.buys.map((leg) => ({ leg, quantityRaw: amount(received, leg.address) }));
  for (const b of bought) {
    if (b.quantityRaw <= BigInt(0)) return { ok: false, message: `${b.leg.symbol} did not arrive in the wallet.` };
  }
  return { ok: true, sold, bought };
}

/**
 * Records the reported hash (once) and settles the intent from its receipt. Idempotent: a settled intent is returned
 * as it is. `session` must own the intent.
 */
export async function verifyRebalanceExecution(
  admin: SupabaseClient,
  session: { userId: string },
  intentId: string,
  reportedTxHash?: string
): Promise<VerifyRebalanceOutcome> {
  let intent = await getIntent(admin, intentId);
  if (!intent || intent.userId !== session.userId) return { ok: false, status: 404, error: 'Rebalance not found.' };

  if (reportedTxHash !== undefined) {
    if (!TX_HASH_RE.test(reportedTxHash)) return { ok: false, status: 400, error: 'Invalid transaction hash.' };
    if (intent.txHash && intent.txHash.toLowerCase() !== reportedTxHash.toLowerCase()) {
      return { ok: false, status: 409, error: 'A different transaction was already reported for this rebalance.' };
    }
    if (intent.status === 'READY' || intent.status === 'EXPIRED') {
      await update(admin, intent.id, { status: 'SUBMITTED', tx_hash: reportedTxHash, submitted_at: new Date().toISOString(), failure_code: null, failure_message: null });
      intent = { ...intent, status: 'SUBMITTED', txHash: reportedTxHash };
    }
  }
  if (intent.status !== 'SUBMITTED' || !intent.txHash) return { ok: true, intent };

  const outcome = await trackComposerTransaction({
    txHash: intent.txHash,
    chain: 'robinhood',
    recipient: intent.walletAddress,
    expectedTransaction: intent.composerTransaction,
  });
  if (outcome.kind === 'PENDING') return { ok: true, intent };
  if (outcome.kind === 'FAILED') {
    await update(admin, intent.id, { status: 'FAILED', failure_code: outcome.failureCode, failure_message: outcome.message });
    return { ok: true, intent: { ...intent, status: 'FAILED', failureCode: outcome.failureCode, failureMessage: outcome.message } };
  }

  const fills = rebalanceFillsFromReceipt(intent, outcome.receivedAmountsByAddress, outcome.sentAmountsByAddress);
  if (!fills.ok) {
    await update(admin, intent.id, { status: 'FAILED', failure_code: 'VERIFICATION_FAILED', failure_message: fills.message });
    return { ok: true, intent: { ...intent, status: 'FAILED', failureCode: 'VERIFICATION_FAILED', failureMessage: fills.message } };
  }
  const result = {
    sold: fills.sold.map((s) => ({ address: s.leg.address, quantityRaw: s.quantityRaw.toString() })),
    bought: fills.bought.map((b) => ({ address: b.leg.address, quantityRaw: b.quantityRaw.toString() })),
  };
  const { error } = await admin.rpc('apply_rebalance_execution', {
    p_intent_id: intent.id,
    p_user_id: intent.userId,
    p_bag_id: intent.bagId,
    p_sold: fills.sold.map((s) => ({ chain: s.leg.chain, address: s.leg.address, decimals: s.leg.decimals, quantity_raw: s.quantityRaw.toString() })),
    p_bought: fills.bought.map((b) => ({
      chain: b.leg.chain,
      address: b.leg.address,
      decimals: b.leg.decimals,
      quantity_raw: b.quantityRaw.toString(),
      weight_bps: b.leg.weightBps,
    })),
  });
  if (error) {
    // The swap happened but cannot be booked (e.g. the sold tokens were moved out meanwhile): never forced; the
    // wallet reconciliation books what is missing as an outflow.
    await update(admin, intent.id, { status: 'FAILED', failure_code: 'ACCOUNTING_FAILED', failure_message: error.message, result });
    return { ok: true, intent: { ...intent, status: 'FAILED', failureCode: 'ACCOUNTING_FAILED', failureMessage: error.message, result } };
  }
  await update(admin, intent.id, { result });
  return { ok: true, intent: { ...intent, status: 'SUCCEEDED', result } };
}

/** Grace before an expired, unreported intent is searched for: the wallet may still be sending it. */
export const REBALANCE_SEARCH_GRACE_MS = 60_000;

/**
 * Settles one user's open rebalances (or every user's, without `userId`): SUBMITTED ones from their receipt; READY ones
 * past expiry are looked up in the wallet's Transfer logs, verified when found, expired when not.
 */
export async function settleOpenRebalances(
  admin: SupabaseClient,
  options: { userId?: string; now?: Date; limit?: number; search?: (input: FindComposerTransactionInput) => ReturnType<typeof findComposerTransactionFromWallet> } = {}
): Promise<{ checked: number; settled: number; expired: number; failed: number }> {
  const now = options.now ?? new Date();
  let query = admin.from('rebalance_intents').select().in('status', ['READY', 'SUBMITTED']).order('updated_at', { ascending: true }).limit(options.limit ?? 25);
  if (options.userId) query = query.eq('user_id', options.userId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const search = options.search ?? findComposerTransactionFromWallet;
  const summary = { checked: 0, settled: 0, expired: 0, failed: 0 };
  for (const intent of ((data ?? []) as Row[]).map(fromRow)) {
    try {
      if (intent.status === 'READY') {
        if (Date.parse(intent.expiresAt) + REBALANCE_SEARCH_GRACE_MS > now.getTime()) continue; // still signable
        summary.checked++;
        const found = await search({
          chain: 'robinhood',
          wallet: intent.walletAddress,
          soldTokens: intent.sells.map((s) => s.address),
          expected: intent.composerTransaction,
          since: new Date(intent.createdAt),
        });
        if (found.kind === 'NOT_FOUND') {
          await update(admin, intent.id, { status: 'EXPIRED' });
          summary.expired++;
          continue;
        }
        if (found.kind !== 'FOUND') continue; // unknown: keep it, try again later
        const r = await verifyRebalanceExecution(admin, { userId: intent.userId }, intent.id, found.txHash);
        if (r.ok && r.intent.status !== 'SUBMITTED') summary.settled++;
        continue;
      }
      summary.checked++;
      const r = await verifyRebalanceExecution(admin, { userId: intent.userId }, intent.id);
      if (r.ok && r.intent.status !== 'SUBMITTED') summary.settled++;
      else await update(admin, intent.id, {}); // to the back of the queue
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
