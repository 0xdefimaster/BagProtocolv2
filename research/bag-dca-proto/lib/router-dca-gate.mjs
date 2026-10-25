// Readiness of a Composer-free DCA purchase (existing BagExecutionRouter + on-chain sources) for the
// user-permissioned DCA plan. This module wires nothing: it reads a shadow report and lists which
// gates are closed. DcaComposerPlan keeps its Composer-specific program checks; nothing here relaxes
// them. Until every gate is open the answer is BLOCKED and no router-based DCA run is attempted.

export const GATE_STATUS = Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED' });

/** Gates that no shadow measurement can open; each needs code that does not exist yet. */
export const STRUCTURAL_GATES = Object.freeze([
  { id: 'PLAN_SIGNER_TRUST', detail: 'BagExecutionRouter executes whatever calldata/minimums the backend planSigner signs. A user-permissioned DCA needs target, token, selector, recipient, spend and value rules enforced on chain from the user permission; removing the signature without that would let anyone choose calldata.' },
  { id: 'ROUTER_PLAN_CONTRACT', detail: 'DcaComposerPlan pins a Composer program template. A router-based plan variant with the same per-period budget, total budget, recipient binding, atomic delivery and SDK receipt evidence is not written.' },
  { id: 'BAG_REGISTRY', detail: 'The shadow run used ShadowBagFactory (a mock that reports every bagId as registered); a real BAG registry check is not exercised.' },
  { id: 'V4_ADAPTER', detail: 'ShadowV4Adapter is a research helper with adversarial unit tests, not a reviewed production adapter.' },
]);

export function routerDcaReadiness(report) {
  const runs = report?.runs ?? [];
  const gates = [];
  const allBaskets = runs.length > 0 && runs.every(r => r.basket?.stage === 'RECEIPT_VERIFIED');
  gates.push({ id: 'EXECUTION_EVIDENCE', status: allBaskets ? GATE_STATUS.OPEN : GATE_STATUS.CLOSED,
    detail: runs.map(r => `${r.amountUsdg} USDG basket: ${r.basket?.status ?? 'none'}/${r.basket?.stage ?? 'none'}`).join('; ') || 'no runs' });
  const priceOk = runs.length > 0 && runs.every(r => r.basketGate?.decision === 'PASS');
  gates.push({ id: 'PRICE_POLICY', status: priceOk ? GATE_STATUS.OPEN : GATE_STATUS.CLOSED,
    detail: runs.map(r => `${r.amountUsdg} USDG: ${r.basketGate?.decision ?? 'none'} (${(r.basketGate?.reasons ?? []).join(', ')})`).join('; ') || 'no runs' });
  const sameBlock = report?.blockMode?.label === 'SINGLE_BLOCK';
  gates.push({ id: 'SAME_BLOCK_EVIDENCE', status: sameBlock ? GATE_STATUS.OPEN : GATE_STATUS.CLOSED, detail: report?.blockMode?.label ?? 'unknown block mode' });
  const usesV4 = runs.some(r => (r.legs ?? []).some(l => l.routerPick?.source === 'uniswap-v4'));
  for (const g of STRUCTURAL_GATES) {
    if (g.id === 'V4_ADAPTER' && !usesV4) { gates.push({ id: g.id, status: GATE_STATUS.OPEN, detail: 'no leg picked a v4 pool in this report' }); continue; }
    gates.push({ id: g.id, status: GATE_STATUS.CLOSED, detail: g.detail });
  }
  const closed = gates.filter(g => g.status === GATE_STATUS.CLOSED).map(g => g.id);
  return { status: closed.length ? 'BLOCKED' : 'READY', closed, gates, researchCommand: 'node start.mjs shadow --app <BagProtocolv2 checkout> [--env-file <file>]' };
}
