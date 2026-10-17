import { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import type { RedeemIntent } from '@/types/redeem-intent';

// -----------------------------------------------------------------------------
// A sale that wallet reconciliation already took off the position as an unknown outflow (EXTERNAL_OUTFLOW) is booked
// as the sale it was, without counting its tokens twice (migration 0057):
//
//   1. classify_outflow_for_redeem gives back, per sold asset, the part of each confirmed outflow the sale explains
//      (only outflows whose observation window contains the sale's block). OUTFLOW_CLASSIFIED ledger events, tracked
//      holdings back up on every Bag the outflow was spread over.
//   2. apply_redeem_execution then books the whole sale, proceeds and realized P&L included, as usual.
//
// Outflows recorded before 0057 have no window and cannot be classified. A recovered sale overlapping one is not
// booked (recoveryGate → LEGACY_OUTFLOW): it is closed as before, with nothing booked, and logged for review.
// -----------------------------------------------------------------------------

export type RecoveryGate = 'OK' | 'LEGACY_OUTFLOW';

/**
 * Whether a sale found on chain by recovery may be booked automatically: LEGACY_OUTFLOW when an outflow recorded
 * before 0057 (no window) may already hold this sale's tokens. (That the transaction is this intent's alone is checked
 * at verification, intent_tx_claims.)
 */
export async function recoveryGate(admin: SupabaseClient, intentId: string): Promise<RecoveryGate> {
  const legacy = await admin.rpc('legacy_outflow_overlaps', { p_redeem_intent_id: intentId });
  if (legacy.error) throw new Error(legacy.error.message);
  return legacy.data === true ? 'LEGACY_OUTFLOW' : 'OK';
}

export interface SoldLeg {
  chain: string;
  address: string;
  quantityRaw: bigint;
  txHash: string;
}

/**
 * Runs step 1 for every sold leg of `intent`, before its accounting is applied. A no-op (and no chain read) unless
 * this user has a classifiable confirmed outflow recorded since the sale was created. Throws when a receipt cannot
 * be read: the sale is then booked on the next verification, never booked without the check.
 */
export async function classifyOutflowsForSale(admin: SupabaseClient, client: Pick<PublicClient, 'getTransactionReceipt' | 'getBlock'>, intent: RedeemIntent, legs: SoldLeg[]): Promise<bigint> {
  if (legs.length === 0) return BigInt(0);
  const candidates = await admin
    .from('reconciliation_records')
    .select('id')
    .eq('user_id', intent.userId)
    .eq('status', 'CONFIRMED_OUTFLOW')
    .not('prev_block_number', 'is', null)
    .gte('created_at', intent.createdAt)
    .limit(1);
  if (candidates.error) throw new Error(candidates.error.message);
  if ((candidates.data ?? []).length === 0) return BigInt(0);

  const mined = new Map<string, { block: bigint; time: string }>();
  let classified = BigInt(0);
  for (const leg of legs) {
    const hash = leg.txHash.toLowerCase();
    let at = mined.get(hash);
    if (!at) {
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      at = { block: receipt.blockNumber, time: new Date(Number(block.timestamp) * 1000).toISOString() };
      mined.set(hash, at);
    }
    const { data, error } = await admin.rpc('classify_outflow_for_redeem', {
      p_redeem_intent_id: intent.id,
      p_chain: leg.chain,
      p_address: leg.address,
      p_sold_raw: leg.quantityRaw.toString(),
      p_sale_block: at.block.toString(),
      p_sale_time: at.time,
    });
    if (error) throw new Error(`classify_outflow_for_redeem failed: ${error.message}`);
    const raw = (data as { classifiedRaw?: string } | null)?.classifiedRaw;
    if (raw && /^\d+$/.test(raw)) classified += BigInt(raw);
  }
  return classified;
}
