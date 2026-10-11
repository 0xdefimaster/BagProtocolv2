// -----------------------------------------------------------------------------
// The public proof page's figures, computed from rows the server already
// recorded and verified against the chain. Pure: no I/O, no clock reads.
//
//   TVL           split by how current each Bag is against the chain (wallet
//                 reconciliation): verified within VERIFICATION_STALE_MS with no
//                 outflow being confirmed, last verified earlier, an outflow
//                 being confirmed, or never verified.
//   executions    purchases and sales that reached a submitted transaction, by
//                 public outcome; the success rate counts finished ones only.
//   money         per token (raw base units, decimal strings — never floats):
//                 performance fees paid to creators by RedeemSettlement
//                 (`Settled`), rewards credited to CreatorRewardsVault
//                 (`Credited`), and what verified settled exits realized.
//   recent        the latest of all of the above, each with its transaction.
// TVL and returns are display figures from NAV snapshots (numbers, as on
// Explore); every money figure is bigint arithmetic over raw amounts.
// -----------------------------------------------------------------------------

/** A check older than this is stale: the 5-minute reconciliation should have refreshed it. */
export const VERIFICATION_STALE_MS = 15 * 60 * 1000;

export type VerificationState = 'VERIFIED' | 'STALE' | 'PENDING_OUTFLOW' | 'UNVERIFIED';

export interface BagVerificationInput {
  checkedAt: string | null;
  pendingOutflows: number;
}

export function verificationState(v: BagVerificationInput | undefined, now: number): VerificationState {
  if (!v) return 'UNVERIFIED';
  if (v.pendingOutflows > 0) return 'PENDING_OUTFLOW';
  if (!v.checkedAt || !Number.isFinite(Date.parse(v.checkedAt))) return 'UNVERIFIED';
  return now - Date.parse(v.checkedAt) > VERIFICATION_STALE_MS ? 'STALE' : 'VERIFIED';
}

export interface ProofBagInput {
  id: string;
  name: string;
  tvl: number;
  return7d: number | null;
  return30d: number | null;
  verification?: BagVerificationInput;
}

export interface ProofBag extends ProofBagInput {
  state: VerificationState;
  checkedAt: string | null;
}

export interface TvlSummary {
  total: number;
  byState: Record<VerificationState, number>;
  bagsByState: Record<VerificationState, number>;
}

const STATES: VerificationState[] = ['VERIFIED', 'STALE', 'PENDING_OUTFLOW', 'UNVERIFIED'];
const zeroByState = () => Object.fromEntries(STATES.map((s) => [s, 0])) as Record<VerificationState, number>;
const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Bags with TVL, highest first, each with its verification state; and the TVL split by state. */
export function summarizeTvl(bags: ProofBagInput[], now: number): { tvl: TvlSummary; bags: ProofBag[] } {
  const byState = zeroByState();
  const bagsByState = zeroByState();
  const out: ProofBag[] = [];
  for (const b of bags) {
    const tvl = finite(b.tvl);
    if (tvl === 0) continue;
    const state = verificationState(b.verification, now);
    byState[state] += tvl;
    bagsByState[state] += 1;
    out.push({ ...b, tvl, state, checkedAt: b.verification?.checkedAt ?? null });
  }
  out.sort((a, b) => b.tvl - a.tvl || a.name.localeCompare(b.name));
  return { tvl: { total: STATES.reduce((s, k) => s + byState[k], 0), byState, bagsByState }, bags: out };
}

// ------------------------------- Executions ----------------------------------

export type ProofOutcome = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'PENDING' | 'UNKNOWN';

export interface ProofTx {
  chain: string;
  txHash: string;
}

export interface ExecutionInput {
  kind: 'PURCHASE' | 'REDEEM';
  id: string;
  bagId: string;
  outcome: ProofOutcome;
  at: string;
  txs: ProofTx[];
}

export interface OutcomeCounts {
  succeeded: number;
  partial: number;
  failed: number;
  pending: number;
}

export interface ExecutionSummary {
  purchases: OutcomeCounts;
  redeems: OutcomeCounts;
  /** Succeeded ÷ finished (succeeded + partial + failed), in basis points; null when nothing finished. */
  successRateBps: number | null;
}

const zeroCounts = (): OutcomeCounts => ({ succeeded: 0, partial: 0, failed: 0, pending: 0 });

export function summarizeExecutions(rows: ExecutionInput[]): ExecutionSummary {
  const purchases = zeroCounts();
  const redeems = zeroCounts();
  for (const r of rows) {
    const c = r.kind === 'PURCHASE' ? purchases : redeems;
    if (r.outcome === 'SUCCEEDED') c.succeeded += 1;
    else if (r.outcome === 'PARTIAL') c.partial += 1;
    else if (r.outcome === 'FAILED') c.failed += 1;
    else if (r.outcome === 'PENDING') c.pending += 1;
  }
  const succeeded = purchases.succeeded + redeems.succeeded;
  const finished = succeeded + purchases.partial + redeems.partial + purchases.failed + redeems.failed;
  return { purchases, redeems, successRateBps: finished === 0 ? null : Math.floor((succeeded * 10_000) / finished) };
}

// ---------------------------------- Money ------------------------------------

export interface SettledSaleInput {
  intentId: string;
  bagId: string;
  txHash: string;
  at: string;
  token: string;
  decimals: number;
  receivedRaw: string;
  feeRaw: string;
  userProceedsRaw: string;
  consumedBasisRaw: string;
}

export type VaultRewardType = 'FORK_ROYALTY' | 'PERFORMANCE_FEE';

export interface VaultCreditInput {
  id: string;
  bagId: string;
  rewardType: VaultRewardType;
  txHash: string;
  at: string;
  token: string;
  decimals: number;
  amountRaw: string;
}

export interface TokenMoney {
  token: string;
  decimals: number;
  /** Paid straight to creators by RedeemSettlement (`Settled.fee`). */
  performanceFeesPaidRaw: string;
  /** Credited to creators in CreatorRewardsVault (`Credited`), by reward type. */
  vaultCreditsRaw: Record<VaultRewardType, string>;
  exits: {
    count: number;
    grossProceedsRaw: string;
    costBasisRaw: string;
    feesRaw: string;
    /** Signed: gross proceeds − cost basis − fee. */
    netRealizedPnlRaw: string;
  };
}

const UINT = /^\d+$/;
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function isValidSale(s: SettledSaleInput): boolean {
  return TX_HASH.test(s.txHash) && [s.receivedRaw, s.feeRaw, s.userProceedsRaw, s.consumedBasisRaw].every((v) => UINT.test(v));
}

export function isValidCredit(c: VaultCreditInput): boolean {
  return TX_HASH.test(c.txHash) && UINT.test(c.amountRaw);
}

interface Acc {
  token: string;
  decimals: number;
  fees: bigint;
  vault: Record<VaultRewardType, bigint>;
  exits: number;
  gross: bigint;
  basis: bigint;
  exitFees: bigint;
}

/** Totals per token (lowercased address). Rows with malformed amounts or hashes are left out, never guessed. */
export function summarizeMoney(sales: SettledSaleInput[], credits: VaultCreditInput[]): TokenMoney[] {
  const byToken = new Map<string, Acc>();
  const acc = (token: string, decimals: number): Acc => {
    const key = token.toLowerCase();
    let a = byToken.get(key);
    if (!a) {
      a = { token: key, decimals, fees: BigInt(0), vault: { FORK_ROYALTY: BigInt(0), PERFORMANCE_FEE: BigInt(0) }, exits: 0, gross: BigInt(0), basis: BigInt(0), exitFees: BigInt(0) };
      byToken.set(key, a);
    }
    return a;
  };
  for (const s of sales) {
    if (!isValidSale(s)) continue;
    const a = acc(s.token, s.decimals);
    const fee = BigInt(s.feeRaw);
    a.fees += fee;
    a.exits += 1;
    a.gross += BigInt(s.receivedRaw);
    a.basis += BigInt(s.consumedBasisRaw);
    a.exitFees += fee;
  }
  for (const c of credits) {
    if (!isValidCredit(c)) continue;
    acc(c.token, c.decimals).vault[c.rewardType] += BigInt(c.amountRaw);
  }
  return [...byToken.values()]
    .sort((x, y) => (x.token < y.token ? -1 : x.token > y.token ? 1 : 0))
    .map((a) => ({
      token: a.token,
      decimals: a.decimals,
      performanceFeesPaidRaw: a.fees.toString(),
      vaultCreditsRaw: { FORK_ROYALTY: a.vault.FORK_ROYALTY.toString(), PERFORMANCE_FEE: a.vault.PERFORMANCE_FEE.toString() },
      exits: {
        count: a.exits,
        grossProceedsRaw: a.gross.toString(),
        costBasisRaw: a.basis.toString(),
        feesRaw: a.exitFees.toString(),
        netRealizedPnlRaw: (a.gross - a.basis - a.exitFees).toString(),
      },
    }));
}

// --------------------------------- Recent ------------------------------------

export type ProofEvent =
  | { type: 'EXECUTION'; at: string; bagId: string; kind: 'PURCHASE' | 'REDEEM'; outcome: ProofOutcome; tx: ProofTx }
  | { type: 'FEE_PAID'; at: string; bagId: string; tx: ProofTx; token: string; decimals: number; amountRaw: string }
  | { type: 'VAULT_CREDIT'; at: string; bagId: string; rewardType: VaultRewardType; tx: ProofTx; token: string; decimals: number; amountRaw: string };

/**
 * The latest events, newest first, each with one transaction to open. An execution shows its last
 * transaction (the swap after any approvals); one without a valid hash is left out.
 */
export function recentEvents(
  executions: ExecutionInput[],
  sales: SettledSaleInput[],
  credits: VaultCreditInput[],
  chainOf: { settlement: string },
  limit: number
): ProofEvent[] {
  const events: ProofEvent[] = [];
  for (const e of executions) {
    const tx = [...e.txs].reverse().find((t) => TX_HASH.test(t.txHash));
    if (tx) events.push({ type: 'EXECUTION', at: e.at, bagId: e.bagId, kind: e.kind, outcome: e.outcome, tx });
  }
  for (const s of sales) {
    if (isValidSale(s) && BigInt(s.feeRaw) > BigInt(0)) {
      events.push({ type: 'FEE_PAID', at: s.at, bagId: s.bagId, tx: { chain: chainOf.settlement, txHash: s.txHash }, token: s.token.toLowerCase(), decimals: s.decimals, amountRaw: s.feeRaw });
    }
  }
  for (const c of credits) {
    if (isValidCredit(c)) {
      events.push({ type: 'VAULT_CREDIT', at: c.at, bagId: c.bagId, rewardType: c.rewardType, tx: { chain: chainOf.settlement, txHash: c.txHash }, token: c.token.toLowerCase(), decimals: c.decimals, amountRaw: c.amountRaw });
    }
  }
  const t = (iso: string) => (Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0);
  return events.sort((a, b) => t(b.at) - t(a.at)).slice(0, limit);
}
