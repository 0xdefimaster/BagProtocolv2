import { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import { readBalancesAtBlock } from '@/lib/server/wallet-balances';
import { verifyRedeemExecution } from '@/lib/server/redeem-execution';
import { settleUnsettledPurchasesForUser } from '@/lib/server/purchase-execution';
import { listUnsettledRedeemIntentsForUser } from '@/lib/server/redeem-intent-repo';
import { settleOpenRebalances } from '@/lib/server/rebalance-execution';
import { recordNavSnapshot } from '@/lib/server/bag-nav-snapshots';

// -----------------------------------------------------------------------------
// Accounting V2 / A2 — wallet reconciliation (docs/ACCOUNTING_V2_DESIGN.md §5).
//
// Reads, from the chain, what a user's wallet holds of every asset BAG tracks
// for them, at ONE block, and hands each balance to apply_wallet_observation
// (migration 0049), which records drift, books confirmed outflows as ledger
// events, and resolves drift that went away.
//
// Fails closed: a balance that could not be read is skipped, never treated as
// zero (a zero would look like the user sold everything). Pending purchases
// and redemptions are settled first, so a sale in flight is not mistaken for
// an external exit. Callers (page visit, scheduled pass, webhook) only ever
// trigger a read; nothing they send is trusted as a balance.
// -----------------------------------------------------------------------------

export interface TrackedAsset {
  chain: string;
  address: string;
  decimals: number | null;
}

export type ObservationStatus = 'OK' | 'DRIFT' | 'CONFIRMED_OUTFLOW' | 'RESOLVED' | 'SKIPPED' | 'UNREADABLE';

export interface WalletReconcileResult {
  userId: string;
  blockNumber: string | null;
  assets: { chain: string; address: string; status: ObservationStatus; observedRaw: string | null; shortfallRaw?: string }[];
}

/** Only Robinhood Chain is reconciled today (the chain BAG executes on). */
const RECONCILED_CHAIN = 'robinhood';

export { readBalancesAtBlock };

async function settlePendingFor(admin: SupabaseClient, userId: string, walletAddress: string): Promise<void> {
  const session = { userId, walletAddress } as Parameters<typeof settleUnsettledPurchasesForUser>[1];
  await settleUnsettledPurchasesForUser(admin, session).catch(() => undefined);
  const pending = await listUnsettledRedeemIntentsForUser(admin, userId, 5).catch(() => []);
  for (const intent of pending) {
    await verifyRedeemExecution(admin, session as never, intent.id).catch(() => undefined);
  }
  await settleOpenRebalances(admin, { userId }).catch(() => undefined);
}

export async function reconcileWallet(
  admin: SupabaseClient,
  client: PublicClient,
  user: { userId: string; walletAddress: string; assets: TrackedAsset[] }
): Promise<WalletReconcileResult> {
  const assets = user.assets.filter((a) => a.chain === RECONCILED_CHAIN && /^0x[0-9a-fA-F]{40}$/.test(a.address));
  if (assets.length === 0) return { userId: user.userId, blockNumber: null, assets: [] };

  await settlePendingFor(admin, user.userId, user.walletAddress);

  const blockNumber = await client.getBlockNumber();
  const balances = await readBalancesAtBlock(client, user.walletAddress, assets, blockNumber);

  const out: WalletReconcileResult['assets'] = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const observed = balances[i];
    if (observed === null) {
      out.push({ chain: a.chain, address: a.address, status: 'UNREADABLE', observedRaw: null });
      continue;
    }
    const { data, error } = await admin.rpc('apply_wallet_observation', {
      p_user_id: user.userId,
      p_chain: a.chain,
      p_address: a.address,
      p_block_number: Number(blockNumber),
      p_observed_raw: observed.toString(),
    });
    if (error) throw new Error(`apply_wallet_observation failed: ${error.message}`);
    const r = (data ?? {}) as { status?: ObservationStatus; shortfallRaw?: string };
    out.push({ chain: a.chain, address: a.address, status: r.status ?? 'OK', observedRaw: observed.toString(), ...(r.shortfallRaw ? { shortfallRaw: r.shortfallRaw } : {}) });
  }

  const { error: markError } = await admin.rpc('mark_wallet_reconciled', { p_user_id: user.userId, p_block_number: Number(blockNumber) });
  if (markError) throw new Error(`mark_wallet_reconciled failed: ${markError.message}`);

  // A confirmed outflow lowered what the Bags hold: price them again now, so a listing's TVL (the latest snapshot)
  // shows it right away instead of after the next hourly pass.
  const outflows = out.filter((a) => a.status === 'CONFIRMED_OUTFLOW').map((a) => a.address);
  if (outflows.length > 0) await refreshNavForOutflows(admin, user.userId, outflows);

  return { userId: user.userId, blockNumber: blockNumber.toString(), assets: out };
}

/** Records a fresh NAV snapshot for every Bag in which this user held one of `addresses`. Never fails the reconciliation. */
async function refreshNavForOutflows(admin: SupabaseClient, userId: string, addresses: string[]): Promise<void> {
  try {
    const { data, error } = await admin.from('bag_investor_holdings').select('bag_id, address').eq('user_id', userId);
    if (error) return;
    const left = new Set(addresses.map((a) => a.toLowerCase()));
    const rows = (data ?? []) as { bag_id: string; address: string }[];
    const bagIds = [...new Set(rows.filter((r) => left.has(r.address.toLowerCase())).map((r) => r.bag_id))];
    for (const bagId of bagIds) await recordNavSnapshot(admin, bagId, { minIntervalMs: 0 }).catch(() => undefined);
  } catch {
    // The hourly snapshot pass still catches up.
  }
}

export const WALLET_RECONCILE_BATCH = 20;

/** The scheduled safety pass: the least recently checked users first. */
export async function reconcileDueWallets(admin: SupabaseClient, client: PublicClient, limit = WALLET_RECONCILE_BATCH) {
  const { data, error } = await admin.rpc('wallet_reconciliation_due', { p_limit: limit });
  if (error) throw new Error(error.message);
  const users = (data ?? []) as { user_id: string; wallet_address: string; assets: TrackedAsset[] }[];
  const summary = { checked: 0, drift: 0, confirmedOutflows: 0, unreadable: 0, failed: 0 };
  for (const u of users) {
    try {
      const r = await reconcileWallet(admin, client, { userId: u.user_id, walletAddress: u.wallet_address, assets: u.assets });
      summary.checked++;
      summary.drift += r.assets.filter((a) => a.status === 'DRIFT').length;
      summary.confirmedOutflows += r.assets.filter((a) => a.status === 'CONFIRMED_OUTFLOW').length;
      summary.unreadable += r.assets.filter((a) => a.status === 'UNREADABLE').length;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}

/** Tracked assets of one user (for event-driven and on-visit reconciliation). */
export async function trackedAssetsForUser(admin: SupabaseClient, userId: string): Promise<TrackedAsset[]> {
  const { data, error } = await admin.from('bag_investor_holdings').select('chain, address, decimals, quantity_raw').eq('user_id', userId);
  if (error) throw new Error(error.message);
  const seen = new Map<string, TrackedAsset>();
  for (const r of (data ?? []) as { chain: string; address: string; decimals: number; quantity_raw: string }[]) {
    if (!/^\d+$/.test(r.quantity_raw) || BigInt(r.quantity_raw) === BigInt(0)) continue;
    seen.set(`${r.chain}:${r.address.toLowerCase()}`, { chain: r.chain, address: r.address, decimals: r.decimals });
  }
  return [...seen.values()];
}

/** A wallet that connects is checked again only when its last full check is at least this old. */
export const RECONCILE_ON_CONNECT_MIN_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Right after a trade from this app (Swap, wallet sweep) the wallet is checked again sooner. An outflow is only
 * booked when a shortfall is seen twice, at least `reconciliation_confirm_after()` (2 minutes) apart, so the
 * client asks once right away and once more after that window (lib/wallet-recheck.ts).
 */
export const RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS = 30 * 1000;

export type ConnectReconcileOutcome =
  | { status: 'checked'; blockNumber: string | null }
  | { status: 'recent' }
  | { status: 'nothing-tracked' };

/**
 * The on-connect check: the signed-in user's own wallet, at most once per RECONCILE_ON_CONNECT_MIN_INTERVAL_MS. This is
 * what keeps a returning user's positions current without a pass every few minutes for everyone. Their pending
 * purchases and sales settle first (inside reconcileWallet).
 */
export async function reconcileWalletOnConnect(
  admin: SupabaseClient,
  client: PublicClient,
  session: { userId: string; walletAddress: string },
  now: number = Date.now(),
  minIntervalMs: number = RECONCILE_ON_CONNECT_MIN_INTERVAL_MS
): Promise<ConnectReconcileOutcome> {
  const { data, error } = await admin
    .from('wallet_reconciliation_state')
    .select('last_checked_at')
    .eq('user_id', session.userId)
    .maybeSingle<{ last_checked_at: string | null }>();
  if (error) throw new Error(error.message);
  const last = data?.last_checked_at ? Date.parse(data.last_checked_at) : NaN;
  if (Number.isFinite(last) && now - last < minIntervalMs) return { status: 'recent' };

  const assets = await trackedAssetsForUser(admin, session.userId);
  if (assets.length === 0) return { status: 'nothing-tracked' };
  const result = await reconcileWallet(admin, client, { userId: session.userId, walletAddress: session.walletAddress, assets });
  return { status: 'checked', blockNumber: result.blockNumber };
}
