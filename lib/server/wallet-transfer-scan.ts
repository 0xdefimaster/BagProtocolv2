import { SupabaseClient } from '@supabase/supabase-js';
import { parseAbiItem, type PublicClient } from 'viem';
import { reconcileWallet, type TrackedAsset } from '@/lib/server/wallet-reconciliation';

// -----------------------------------------------------------------------------
// Every wallet, every 5 minutes, without reading every balance.
//
// A wallet's ledger is verified up to the block of its last full check
// (wallet_reconciliation_state.last_block_number). Holdings can only fall
// short of the ledger through an outgoing Transfer of a tracked token, so:
//
//   1. one eth_getLogs per block range and wallet chunk: Transfer(from = a
//      tracked wallet) of the tracked tokens, since the oldest covered block;
//   2. a wallet with such a transfer after its own last check, or with an
//      outflow still being confirmed (open DRIFT), gets a full reconciliation
//      (balances re-read at one block, apply_wallet_observation);
//   3. every other covered wallet is marked verified at the latest block:
//      nothing left it since its last full check.
//
// A wallet never fully checked, or last checked beyond MAX_SCAN_BLOCKS, is not
// covered here: the round-robin pass (reconcileDueWallets) checks it in full.
// Only Robinhood Chain is reconciled today. Fails closed: a log read that
// fails marks nothing.
// -----------------------------------------------------------------------------

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const CHAIN = 'robinhood';
export const MAX_SCAN_BLOCKS = BigInt(200_000);
export const SCAN_CHUNK_BLOCKS = BigInt(10_000);
export const SCAN_WALLET_CHUNK = 100;
export const SCAN_BUDGET_MS = 8_000;

type ScanClient = Pick<PublicClient, 'getBlockNumber' | 'getLogs'> & PublicClient;

interface TrackedUser {
  userId: string;
  wallet: string;
  assets: TrackedAsset[];
  lastBlock: bigint | null;
}

export interface TransferScanResult {
  wallets: number;
  covered: number;
  scannedFrom: string | null;
  scannedTo: string | null;
  reconciled: number;
  verified: number;
  deferred: number;
  failed: number;
}

/** Users holding anything through BAG on Robinhood Chain, with their tracked assets and last fully checked block. */
async function trackedUsers(admin: SupabaseClient): Promise<TrackedUser[]> {
  const { data, error } = await admin.rpc('wallet_reconciliation_due', { p_limit: 500 });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as { user_id: string; wallet_address: string; assets: TrackedAsset[] }[])
    .map((r) => ({ ...r, assets: r.assets.filter((a) => a.chain === CHAIN && /^0x[0-9a-fA-F]{40}$/.test(a.address)) }))
    .filter((r) => r.assets.length > 0);
  if (rows.length === 0) return [];
  const { data: state, error: stateError } = await admin.from('wallet_reconciliation_state').select('user_id,last_block_number').in('user_id', rows.map((r) => r.user_id));
  if (stateError) throw new Error(stateError.message);
  const last = new Map(((state ?? []) as { user_id: string; last_block_number: number | string | null }[]).map((s) => [s.user_id, s.last_block_number]));
  return rows.map((r) => {
    const b = last.get(r.user_id);
    return { userId: r.user_id, wallet: r.wallet_address, assets: r.assets, lastBlock: b === null || b === undefined ? null : BigInt(b) };
  });
}

/** Users with an outflow still being confirmed: a DRIFT record of the last day that no later record resolved or confirmed. */
async function usersWithOpenDrift(admin: SupabaseClient): Promise<Set<string>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin.from('reconciliation_records').select('id,user_id,status,confirms_record_id').gte('created_at', since);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; user_id: string; status: string; confirms_record_id: string | null }[];
  const closed = new Set(rows.map((r) => r.confirms_record_id).filter((id): id is string => !!id));
  return new Set(rows.filter((r) => r.status === 'DRIFT' && !closed.has(r.id)).map((r) => r.user_id));
}

export async function scanTrackedWalletTransfers(
  admin: SupabaseClient,
  client: ScanClient,
  options: { budgetMs?: number; now?: () => number } = {}
): Promise<TransferScanResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? SCAN_BUDGET_MS;
  const users = await trackedUsers(admin);
  const result: TransferScanResult = { wallets: users.length, covered: 0, scannedFrom: null, scannedTo: null, reconciled: 0, verified: 0, deferred: 0, failed: 0 };
  if (users.length === 0) return result;

  const latest = await client.getBlockNumber();
  const covered = users.filter((u) => u.lastBlock !== null && latest - u.lastBlock <= MAX_SCAN_BLOCKS);
  result.covered = covered.length;
  result.deferred = users.length - covered.length;

  const moved = new Set<string>();
  if (covered.length > 0) {
    const from = covered.reduce((m, u) => (u.lastBlock! < m ? u.lastBlock! : m), latest) + BigInt(1);
    const tokens = [...new Set(covered.flatMap((u) => u.assets.map((a) => a.address.toLowerCase())))] as `0x${string}`[];
    const byWallet = new Map(covered.map((u) => [u.wallet.toLowerCase(), u]));
    const wallets = [...byWallet.keys()] as `0x${string}`[];
    result.scannedFrom = from.toString();
    result.scannedTo = latest.toString();
    // A failed read throws: nothing is marked verified on a partial scan.
    for (let start = from; start <= latest; start += SCAN_CHUNK_BLOCKS) {
      const end = start + SCAN_CHUNK_BLOCKS - BigInt(1) < latest ? start + SCAN_CHUNK_BLOCKS - BigInt(1) : latest;
      for (let i = 0; i < wallets.length; i += SCAN_WALLET_CHUNK) {
        const logs = await client.getLogs({ address: tokens, event: TRANSFER, args: { from: wallets.slice(i, i + SCAN_WALLET_CHUNK) }, fromBlock: start, toBlock: end });
        for (const log of logs) {
          const u = byWallet.get(String(log.args.from ?? '').toLowerCase());
          if (!u || log.blockNumber === null || log.blockNumber <= u.lastBlock!) continue;
          if (u.assets.some((a) => a.address.toLowerCase() === log.address.toLowerCase())) moved.add(u.userId);
        }
      }
    }
  }

  const drifting = await usersWithOpenDrift(admin);
  const toReconcile = users.filter((u) => moved.has(u.userId) || drifting.has(u.userId));
  for (const u of toReconcile) {
    if (now() - started >= budget) break;
    try {
      await reconcileWallet(admin, client, { userId: u.userId, walletAddress: u.wallet, assets: u.assets });
      result.reconciled++;
    } catch {
      result.failed++;
    }
  }

  const reconcileIds = new Set(toReconcile.map((u) => u.userId));
  for (const u of covered) {
    if (reconcileIds.has(u.userId)) continue;
    const { error } = await admin.rpc('mark_wallet_reconciled', { p_user_id: u.userId, p_block_number: Number(latest) });
    if (error) result.failed++;
    else result.verified++;
  }
  return result;
}
