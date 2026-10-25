// Price/hook gate for routing a DCA purchase without Composer. FAIL-CLOSED: until a price policy is
// proven (DECISIONS.md, "Fiyat politikası"), the best a route can get is PRICE_POLICY_UNPROVEN, which
// blocks execution exactly like FAIL. PASS exists so the mechanics are testable; the shipped policy
// cannot produce it.
//
// Why a probe check alone is not enough: comparing a full-size quote with a 1% probe of the SAME pool
// only detects thin liquidity. A pool with a constant 44-99% fee (seen on 4663 v4) gives the same bad
// price at every size, so the probe sees nothing. The fee and hook checks below catch those directly.
// Other routes measured at the same moment ("peers") are a sanity check only: another AMM's spot
// price is not an independent fair-price reference.

export const DECISION = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', UNPROVEN: 'PRICE_POLICY_UNPROVEN' });
export const DYNAMIC_FEE_FLAG = 0x800000;

export const PRICE_POLICY = Object.freeze({
  /** Only a DECISIONS.md entry backed by evidence may flip this. While false the gate never passes. */
  proven: false,
  requiredEvidence: 'RECEIPT_VERIFIED',
  /** Independent reference price. None is verified for these tokens on 4663, so every field is unset. */
  reference: Object.freeze({
    source: null,               // a verified feed (address + version) per output token; same-moment AMM prices do not qualify
    unit: 'output-token raw units for the leg input (USDG raw, 6 decimals)',
    maxStalenessSeconds: null,  // reject a reference older than this
    twapWindowSeconds: null,    // if the source is a TWAP: its window
    usdgReferenceUsd: null,     // USDG is NOT assumed to be exactly 1 USD; a USD-quoted feed needs a USDG/USD value too
  }),
  /** Largest shortfall against the reference the user accepts (the BAG rule's swapSlippageBps once a reference exists). */
  userToleranceBps: null,
  onMissingData: 'FAIL_CLOSED',
  /** A pool charging more than this is refused outright (100 bps = 1%). */
  maxPoolFeeBps: 100,
  /** Full-size unit price at most this far below a 1% probe of the same route. */
  maxProbeImpactBps: 500,
  /** Sanity check: at most this far below the best other receipt-verified route at the same block. */
  maxBelowBestPeerBps: 200,
  /** Uniswap v4 hooks reviewed and allowed. Empty: every hooked pool is refused. */
  hookAllowlist: Object.freeze([]),
});

const lc = a => String(a ?? '').toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const evidenceOf = c => c?.evidence ?? c?.stage;

/** Pool fee in basis points from a v3 fee tier or a v4 PoolKey fee; null when the fee is dynamic (unknown up front). */
export function poolFeeBps(route) {
  if (!route || route.fee === undefined || route.fee === null) return null;
  const fee = Number(route.fee);
  if (fee & DYNAMIC_FEE_FLAG) return null;
  return fee / 100; // fee is in hundredths of a bip (1e-6)
}

/**
 * candidate: { source, evidence|stage, outRaw (bigint), impactBps?, route: { fee, hooks? } }
 * peers:     other candidates for the same leg, amount and block (only receipt-verified ones count)
 * reference: { source, expectedOutRaw (bigint, same units as outRaw), timestamp (s), synthetic? }
 */
export function priceGate(candidate, { peers = [], reference, nowSeconds, policy = PRICE_POLICY } = {}) {
  const fail = [], unproven = [], checks = {};
  checks.evidence = evidenceOf(candidate);
  if (checks.evidence !== policy.requiredEvidence) fail.push(`EVIDENCE_BELOW_${policy.requiredEvidence}`);
  const hooks = lc(candidate.route?.hooks ?? ZERO);
  checks.hooks = hooks;
  if (hooks !== ZERO && !policy.hookAllowlist.map(lc).includes(hooks)) fail.push('HOOK_NOT_ALLOWLISTED');
  const feeBps = poolFeeBps(candidate.route);
  checks.poolFeeBps = feeBps;
  if (feeBps === null) unproven.push('POOL_FEE_UNKNOWN');
  else if (feeBps > policy.maxPoolFeeBps) fail.push('POOL_FEE_TOO_HIGH');
  checks.probeImpactBps = candidate.impactBps ?? null;
  if (candidate.impactBps === undefined || candidate.impactBps === null) unproven.push('PROBE_IMPACT_UNKNOWN');
  else if (candidate.impactBps > policy.maxProbeImpactBps) fail.push('PROBE_IMPACT_TOO_HIGH');
  const others = peers.filter(p => p !== candidate && evidenceOf(p) === policy.requiredEvidence && typeof p.outRaw === 'bigint' && p.outRaw > 0n);
  if (others.length && typeof candidate.outRaw === 'bigint') {
    const best = others.reduce((m, p) => (p.outRaw > m ? p.outRaw : m), 0n);
    checks.belowBestPeerBps = candidate.outRaw >= best ? 0 : Number(((best - candidate.outRaw) * 10000n) / best);
    if (checks.belowBestPeerBps > policy.maxBelowBestPeerBps) fail.push('BELOW_BEST_PEER');
  }
  const ref = policy.reference ?? {};
  if (!ref.source || !reference) unproven.push('NO_REFERENCE_PRICE');
  else {
    checks.reference = { source: reference.source, timestamp: reference.timestamp, synthetic: !!reference.synthetic };
    if (reference.source !== ref.source) fail.push('REFERENCE_SOURCE_MISMATCH');
    if (reference.synthetic) unproven.push('SYNTHETIC_REFERENCE');
    if (ref.maxStalenessSeconds === null || ref.maxStalenessSeconds === undefined || nowSeconds === undefined) unproven.push('REFERENCE_STALENESS_UNCHECKED');
    else if (nowSeconds - Number(reference.timestamp) > ref.maxStalenessSeconds) fail.push('REFERENCE_STALE');
    if (policy.userToleranceBps === null || policy.userToleranceBps === undefined) unproven.push('USER_TOLERANCE_UNSET');
    else if (typeof candidate.outRaw === 'bigint' && reference.expectedOutRaw > 0n) {
      checks.belowReferenceBps = candidate.outRaw >= reference.expectedOutRaw ? 0 : Number(((reference.expectedOutRaw - candidate.outRaw) * 10000n) / reference.expectedOutRaw);
      if (checks.belowReferenceBps > policy.userToleranceBps) fail.push('BELOW_REFERENCE');
    }
  }
  if (!policy.proven) unproven.push('POLICY_NOT_PROVEN');
  const decision = fail.length ? DECISION.FAIL : unproven.length ? DECISION.UNPROVEN : DECISION.PASS;
  return { decision, reasons: [...fail, ...unproven], checks, executable: decision === DECISION.PASS };
}

/** A basket is executable only if every leg passes. Any FAIL fails it; otherwise any UNPROVEN leaves it unproven. */
export function basketGate(legDecisions) {
  if (!legDecisions.length) return { decision: DECISION.FAIL, reasons: ['NO_LEGS'], executable: false };
  const d = legDecisions.map(x => x.decision);
  const decision = d.includes(DECISION.FAIL) ? DECISION.FAIL : d.includes(DECISION.UNPROVEN) ? DECISION.UNPROVEN : DECISION.PASS;
  return { decision, reasons: [...new Set(legDecisions.flatMap(x => x.reasons))], executable: decision === DECISION.PASS };
}
