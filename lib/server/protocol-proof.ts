import type { SupabaseClient } from '@supabase/supabase-js';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import {
  ExecutionInput,
  ExecutionSummary,
  ProofBag,
  ProofEvent,
  SettledSaleInput,
  TokenMoney,
  TvlSummary,
  VaultCreditInput,
  VaultRewardType,
  recentEvents,
  summarizeExecutions,
  summarizeMoney,
  summarizeTvl,
} from '@/lib/domain/proof/protocol-proof';
import { getNavSummaries } from '@/lib/server/bag-nav-snapshots';
import { listBags } from '@/lib/server/bag-repo';
import { getBagVerification } from '@/lib/server/bag-verification';
import { EXECUTION_STATUSES, publicOutcome } from '@/lib/server/execution-receipts';
import type { PurchaseIntentStepRecord } from '@/types/purchase-intent';
import type { RedeemSettlementPlan } from '@/types/redeem-intent';

// -----------------------------------------------------------------------------
// GET /api/proof's data: protocol-wide figures anyone can check against the
// chain (lib/domain/proof/protocol-proof.ts). Read-only, public, and never
// names a wallet: only Bags, outcomes, amounts and transaction hashes, which
// are public on-chain anyway. Bags that are not live are shown unnamed.
// -----------------------------------------------------------------------------

/** Executions are counted over this window; fees and exits over all time. */
export const PROOF_WINDOW_DAYS = 30;
/** Rows read per source. A source that reaches it is reported as truncated, never silently cut. */
export const PROOF_ROW_CAP = 2000;
export const PROOF_RECENT_LIMIT = 25;

/** RedeemSettlement and CreatorRewardsVault both live on Robinhood Chain. */
const SETTLEMENT_CHAIN = 'robinhood';

export interface ProofTxLink {
  chain: string;
  txHash: string;
  /** Block explorer link, or null for a chain BAG has no explorer for. */
  url: string | null;
}

export interface ProtocolProof {
  generatedAt: string;
  windowDays: number;
  tvl: TvlSummary;
  bags: (Omit<ProofBag, 'verification'>)[];
  executions: ExecutionSummary;
  money: (TokenMoney & { symbol: string | null })[];
  recent: (ProofEvent & { bagName: string | null; tx: ProofTxLink; symbol?: string | null })[];
  /** Sources that hit PROOF_ROW_CAP: their totals cover the newest PROOF_ROW_CAP rows only. */
  truncated: ('executions' | 'settledSales' | 'vaultCredits')[];
}

export function explorerTxUrl(chain: string, txHash: string): string | null {
  if (!isBagChain(chain)) return null;
  return `${BAG_CHAINS[chain].explorerUrl.replace(/\/$/, '')}/tx/${txHash}`;
}

export function tokenSymbol(token: string): string | null {
  return token.toLowerCase() === ROBINHOOD_REWARD_TOKEN.address.toLowerCase() ? ROBINHOOD_REWARD_TOKEN.symbol : null;
}

interface IntentRow {
  id: string;
  bag_id: string;
  status: string;
  steps: PurchaseIntentStepRecord[] | null;
  created_at: string;
  executed_at: string | null;
}

function executionsFrom(kind: ExecutionInput['kind'], rows: IntentRow[]): ExecutionInput[] {
  const out: ExecutionInput[] = [];
  for (const r of rows) {
    const steps = Array.isArray(r.steps) ? r.steps : [];
    const seen = new Set<string>();
    const txs = [];
    for (const s of steps) {
      for (const h of [s.approvalTxHash, s.txHash]) {
        if (!h || seen.has(h.toLowerCase())) continue;
        seen.add(h.toLowerCase());
        txs.push({ chain: String(s.sourceChain), txHash: h });
      }
    }
    // Same rule as the execution history: an intent without a submitted transaction is not an execution.
    if (!steps.some((s) => s.txHash)) continue;
    out.push({ kind, id: r.id, bagId: r.bag_id, outcome: publicOutcome(r.status), at: r.executed_at ?? r.created_at, txs });
  }
  return out;
}

export async function loadProtocolProof(admin: SupabaseClient, now: number = Date.now()): Promise<ProtocolProof> {
  const since = new Date(now - PROOF_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const statuses = [...EXECUTION_STATUSES];

  const [bags, purchases, redeems, sales, credits] = await Promise.all([
    listBags(admin, { status: 'ACTIVE' }),
    admin
      .from('purchase_intents')
      .select('id,bag_id,status,steps,created_at,executed_at')
      .in('status', statuses)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(PROOF_ROW_CAP),
    admin
      .from('redeem_intents')
      .select('id,bag_id,status,steps,created_at,executed_at')
      .in('status', statuses)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(PROOF_ROW_CAP),
    admin
      .from('redeem_intents')
      .select('id,bag_id,output_asset_address,output_decimals,settlement_plan,executed_at,updated_at')
      .eq('status', 'COMPLETED')
      .not('settlement_plan', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(PROOF_ROW_CAP),
    admin
      .from('creator_reward_settlements')
      .select('id,bag_id,reward_type,reward_amount_token_raw,reward_token_address,reward_token_decimals,onchain_tx_hash,settled_at,updated_at')
      .eq('status', 'CONFIRMED')
      .order('updated_at', { ascending: false })
      .limit(PROOF_ROW_CAP),
  ]);
  for (const r of [purchases, redeems, sales, credits]) if (r.error) throw new Error(r.error.message);

  const bagIds = bags.map((b) => b.id);
  const [navSummaries, verification] = await Promise.all([
    getNavSummaries(admin, bagIds).catch(() => new Map()),
    // Without reconciliation data (0049 not applied) every Bag reads as not yet verified, never as verified.
    getBagVerification(admin, bagIds).catch(() => new Map()),
  ]);
  const names = new Map(bags.map((b) => [b.id, b.name]));

  const { tvl, bags: proofBags } = summarizeTvl(
    bags.map((b) => {
      const nav = navSummaries.get(b.id);
      return {
        id: b.id,
        name: b.name,
        tvl: nav?.tvl ?? 0,
        return7d: nav?.performance['7D'] ?? null,
        return30d: nav?.performance['30D'] ?? null,
        verification: verification.get(b.id),
      };
    }),
    now
  );

  const executions = [
    ...executionsFrom('PURCHASE', (purchases.data ?? []) as IntentRow[]),
    ...executionsFrom('REDEEM', (redeems.data ?? []) as IntentRow[]),
  ];

  const settledSales: SettledSaleInput[] = [];
  for (const r of (sales.data ?? []) as { id: string; bag_id: string; output_asset_address: string; output_decimals: number; settlement_plan: RedeemSettlementPlan | null; executed_at: string | null; updated_at: string }[]) {
    const result = r.settlement_plan?.result;
    if (!result) continue;
    settledSales.push({
      intentId: r.id,
      bagId: r.bag_id,
      txHash: String(result.txHash),
      at: r.executed_at ?? r.updated_at,
      token: r.output_asset_address,
      decimals: r.output_decimals,
      receivedRaw: String(result.received),
      feeRaw: String(result.fee),
      royaltyRaw: String(result.royalty ?? '0'),
      userProceedsRaw: String(result.userProceeds),
      consumedBasisRaw: String(r.settlement_plan?.consumedBasisRaw ?? ''),
    });
  }

  const vaultCredits: VaultCreditInput[] = ((credits.data ?? []) as { id: string; bag_id: string; reward_type: VaultRewardType; reward_amount_token_raw: string; reward_token_address: string; reward_token_decimals: number; onchain_tx_hash: string | null; settled_at: string | null; updated_at: string }[])
    .filter((r) => r.onchain_tx_hash)
    .map((r) => ({
      id: r.id,
      bagId: r.bag_id,
      rewardType: r.reward_type,
      txHash: r.onchain_tx_hash!,
      at: r.settled_at ?? r.updated_at,
      token: r.reward_token_address,
      decimals: r.reward_token_decimals,
      amountRaw: r.reward_amount_token_raw,
    }));

  const truncated: ProtocolProof['truncated'] = [];
  if ((purchases.data ?? []).length >= PROOF_ROW_CAP || (redeems.data ?? []).length >= PROOF_ROW_CAP) truncated.push('executions');
  if ((sales.data ?? []).length >= PROOF_ROW_CAP) truncated.push('settledSales');
  if ((credits.data ?? []).length >= PROOF_ROW_CAP) truncated.push('vaultCredits');

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: PROOF_WINDOW_DAYS,
    tvl,
    bags: proofBags.map((b) => ({ id: b.id, name: b.name, tvl: b.tvl, return7d: b.return7d, return30d: b.return30d, state: b.state, checkedAt: b.checkedAt })),
    executions: summarizeExecutions(executions),
    money: summarizeMoney(settledSales, vaultCredits).map((m) => ({ ...m, symbol: tokenSymbol(m.token) })),
    recent: recentEvents(executions, settledSales, vaultCredits, { settlement: SETTLEMENT_CHAIN }, PROOF_RECENT_LIMIT).map((e) => ({
      ...e,
      bagName: names.get(e.bagId) ?? null,
      tx: { ...e.tx, url: explorerTxUrl(e.tx.chain, e.tx.txHash) },
      ...('token' in e ? { symbol: tokenSymbol(e.token) } : {}),
    })),
    truncated,
  };
}
