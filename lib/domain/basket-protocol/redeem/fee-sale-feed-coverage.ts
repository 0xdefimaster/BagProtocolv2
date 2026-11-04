// -----------------------------------------------------------------------------
// Fee-sale feed coverage: a release gate for the fee-sale confidence policy
// (sale-price-confidence.ts). Pure: inventory, feed map and probe results are
// passed in; scripts/check-fee-sale-feed-coverage.ts does the reading.
//
// WHICH ASSETS A FEE SALE PRICES — taken from the real sale path, not guessed:
//   - A sale's legs are the seller's OWN `bag_investor_holdings` rows for that
//     Bag (position-valuation.ts sellableHoldingsForBag → redeem allocation →
//     intent steps). Not the current recipe: a holder can still hold assets of
//     an earlier version, and an asset dropped from every holding is not sold.
//   - RedeemSettlement (and so this policy) is used only when /execute refuses
//     with FEE_ROUTER_REQUIRED: the seller is NOT the Bag's creator and the
//     rate `performanceFeeBpsLocked ?? currentRecipe.performanceFeeBps` is > 0
//     (redeem-execution.ts). The creator's own sale goes through the free path
//     and is reported, never gated.
//   - quoteSettlement prices every non-USDG leg (USDG is not swapped).
//   - Future buyers buy the CURRENT recipe, so its assets are gated too.
//
// Per required leg:
//   NOT_PRICED          the settlement token (USDG)
//   FEED_CONFIGURED     Stock Token with a ROBINHOOD_CHAINLINK_FEEDS entry — a
//                       configuration fact, NOT evidence the sale can happen
//   MISSING_FEED        Stock Token without a feed → no confidence → refused
//   NO_QUALIFIED_SOURCE crypto (LI.FI / TWAP price, never Chainlink-verified) → refused
//   UNKNOWN_ASSET       not in the asset registry → refused
// and, only with a live probe:
//   VERIFIED_NOW        the price router returned a Chainlink-verified price
//                       that the policy accepted, at probe time
//   NOT_VERIFIED_NOW    anything else that is a determinate answer (feed
//                       unreadable, disagreement, stale, policy refusal, …)
//   PROBE_ERROR         no determinate answer (source outage, unexpected error)
// -----------------------------------------------------------------------------

export type LegCoverage = 'NOT_PRICED' | 'FEED_CONFIGURED' | 'MISSING_FEED' | 'NO_QUALIFIED_SOURCE' | 'UNKNOWN_ASSET';
/** Why the leg is required: held by a fee-paying (non-creator) position, in the current recipe, or both. */
export type LegOrigin = 'HELD_AND_CURRENT_RECIPE' | 'HELD_FROM_EARLIER_VERSION' | 'CURRENT_RECIPE_NOT_HELD';

export interface InventoryBag {
  id: string;
  name: string;
  chain: string;
  creatorId: string;
  performanceFeeBpsLocked: number | null;
  /** The current version's recipe; null when the Bag has no current version. */
  currentRecipe: { performanceFeeBps?: number; assets: { address: string; symbol: string }[] } | null;
}

export interface InventoryHolding {
  userId: string;
  bagId: string;
  chain: string;
  address: string;
  quantityRaw: string;
}

export interface CoverageInput {
  bags: InventoryBag[];
  holdings: InventoryHolding[];
  settlementTokenAddress: string;
  /** Registry classification by lowercase address (Robinhood). Missing = not in the registry. */
  assetTypes: Map<string, 'stock' | 'crypto'>;
  /** Lowercase asset address → feed (ROBINHOOD_CHAINLINK_FEEDS, parsed). */
  feeds: Record<string, string>;
}

export interface CoverageLeg {
  chain: string;
  address: string;
  symbol: string | null;
  origin: LegOrigin;
  coverage: LegCoverage;
  /** Fee-paying (non-creator) positions holding it now. */
  feeHolders: number;
}

export type BagStatus = 'READY_IF_FEEDS_LIVE' | 'FEE_SALE_REFUSED' | 'CHAIN_NOT_SUPPORTED' | 'NOT_DETERMINABLE';

export interface BagCoverage {
  id: string;
  name: string;
  chain: string;
  feeBps: number | null;
  feeSource: 'LOCKED' | 'CURRENT_RECIPE' | 'UNKNOWN';
  status: BagStatus;
  /** Positions that would sell through RedeemSettlement (holder ≠ creator). */
  feePositions: number;
  /** The creator's own position: free path, not gated. */
  creatorPositions: number;
  legs: CoverageLeg[];
  note?: string;
}

export interface CoverageReport {
  status: 'NO_FEE_BEARING_POSITIONS' | 'STATIC_COMPLETE' | 'STATIC_GAPS' | 'INCOMPLETE';
  bags: BagCoverage[];
  totals: { bagsScanned: number; holdingRowsScanned: number; feeBearingBags: number; feePositions: number; creatorPositions: number };
}

const positive = (q: string) => /^\d+$/.test(q) && BigInt(q) > BigInt(0);

export function buildFeeSaleCoverage(input: CoverageInput): CoverageReport {
  const usdg = input.settlementTokenAddress.toLowerCase();
  const byBag = new Map<string, InventoryHolding[]>();
  for (const h of input.holdings) {
    if (!positive(h.quantityRaw)) continue;
    const list = byBag.get(h.bagId) ?? [];
    list.push(h);
    byBag.set(h.bagId, list);
  }

  const bags: BagCoverage[] = [];
  let feeBearingBags = 0;
  let feePositionsTotal = 0;
  let creatorPositionsTotal = 0;
  for (const b of [...input.bags].sort((x, y) => x.id.localeCompare(y.id))) {
    const held = byBag.get(b.id) ?? [];
    const feeSource = b.performanceFeeBpsLocked !== null ? 'LOCKED' : b.currentRecipe ? 'CURRENT_RECIPE' : 'UNKNOWN';
    const feeBps = b.performanceFeeBpsLocked ?? (b.currentRecipe ? b.currentRecipe.performanceFeeBps ?? 0 : null);
    const feeHeld = held.filter((h) => h.userId !== b.creatorId);
    const creatorHeld = held.filter((h) => h.userId === b.creatorId);
    const feePositions = new Set(feeHeld.map((h) => h.userId)).size;
    const creatorPositions = creatorHeld.length > 0 ? 1 : 0;

    if (feeBps === null) {
      // No current version and no locked rate: whether a sale pays a fee cannot be determined. Only matters when
      // someone holds it; a version-less Bag nobody holds cannot be bought or sold.
      if (held.length > 0) {
        bags.push({ id: b.id, name: b.name, chain: b.chain, feeBps, feeSource, status: 'NOT_DETERMINABLE', feePositions, creatorPositions, legs: [], note: 'held, but no current version and no locked rate' });
      }
      continue;
    }
    if (feeBps <= 0) continue;
    feeBearingBags++;
    feePositionsTotal += feePositions;
    creatorPositionsTotal += creatorPositions;
    if (b.chain !== 'robinhood') {
      bags.push({ id: b.id, name: b.name, chain: b.chain, feeBps, feeSource, status: 'CHAIN_NOT_SUPPORTED', feePositions, creatorPositions, legs: [], note: 'fee sales settle on Robinhood Chain only' });
      continue;
    }

    const current = new Map((b.currentRecipe?.assets ?? []).map((a) => [a.address.toLowerCase(), a.symbol]));
    const legKeys = new Map<string, { chain: string; address: string; holders: Set<string> }>();
    for (const h of feeHeld) {
      const k = `${h.chain}:${h.address.toLowerCase()}`;
      const e = legKeys.get(k) ?? { chain: h.chain, address: h.address, holders: new Set<string>() };
      e.holders.add(h.userId);
      legKeys.set(k, e);
    }
    for (const [address] of current) {
      const k = `robinhood:${address}`;
      if (!legKeys.has(k)) legKeys.set(k, { chain: 'robinhood', address, holders: new Set() });
    }
    const legs: CoverageLeg[] = [...legKeys.values()]
      .map((e) => {
        const a = e.address.toLowerCase();
        const inCurrent = current.has(a);
        const origin: LegOrigin = e.holders.size === 0 ? 'CURRENT_RECIPE_NOT_HELD' : inCurrent ? 'HELD_AND_CURRENT_RECIPE' : 'HELD_FROM_EARLIER_VERSION';
        const type = input.assetTypes.get(a);
        const coverage: LegCoverage =
          e.chain !== 'robinhood'
            ? 'UNKNOWN_ASSET'
            : a === usdg
              ? 'NOT_PRICED'
              : type === undefined
                ? 'UNKNOWN_ASSET'
                : type === 'crypto'
                  ? 'NO_QUALIFIED_SOURCE'
                  : input.feeds[a]
                    ? 'FEED_CONFIGURED'
                    : 'MISSING_FEED';
        return { chain: e.chain, address: e.address, symbol: current.get(a) ?? null, origin, coverage, feeHolders: e.holders.size };
      })
      .sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
    const ready = legs.every((l) => l.coverage === 'NOT_PRICED' || l.coverage === 'FEED_CONFIGURED');
    bags.push({ id: b.id, name: b.name, chain: b.chain, feeBps, feeSource, status: ready ? 'READY_IF_FEEDS_LIVE' : 'FEE_SALE_REFUSED', feePositions, creatorPositions, legs });
  }

  const totals = { bagsScanned: input.bags.length, holdingRowsScanned: input.holdings.length, feeBearingBags, feePositions: feePositionsTotal, creatorPositions: creatorPositionsTotal };
  if (bags.some((b) => b.status === 'NOT_DETERMINABLE')) return { status: 'INCOMPLETE', bags, totals };
  if (feeBearingBags === 0) return { status: 'NO_FEE_BEARING_POSITIONS', bags, totals };
  return { status: bags.every((b) => b.status === 'READY_IF_FEEDS_LIVE') ? 'STATIC_COMPLETE' : 'STATIC_GAPS', bags, totals };
}

/** Every priced leg a fee sale (or a future fee-paying purchase's sale) would need a verified price for. */
export function requiredPricedLegs(report: CoverageReport): { chain: string; address: string }[] {
  const out = new Map<string, { chain: string; address: string }>();
  for (const b of report.bags) {
    for (const l of b.legs) if (l.coverage !== 'NOT_PRICED') out.set(`${l.chain}:${l.address.toLowerCase()}`, { chain: l.chain, address: l.address.toLowerCase() });
  }
  return [...out.values()].sort((x, y) => x.address.localeCompare(y.address));
}

// ---------------------------------- probe ------------------------------------

export type ProbeOutcome =
  | { status: 'VERIFIED_NOW'; detail: string }
  | { status: 'NOT_VERIFIED_NOW'; reason: string }
  | { status: 'PROBE_ERROR'; reason: string };

/** Router causes that are a determinate "no" from a reachable source (pricing/provider.ts PriceUnavailableCause). */
const DETERMINATE_CAUSES = new Set(['MARKET_CLOSED_OR_HALTED', 'SPREAD_TOO_WIDE', 'STALE_QUOTE', 'NOT_LISTED', 'SOURCES_DISAGREE', 'NO_PRICE']);

/**
 * Classifies one probe. `decision` is salePriceDeviationLimit's answer for the price the router returned; `error` is
 * what the router threw instead. For a release gate only a Chainlink-verified price passes: the reduced band the
 * policy allows while a feed is unreadable is an outage mode, not a release state.
 */
export function classifyProbe(
  r: { decision: { ok: true; tier: 'VERIFIED' | 'REDUCED_CONFIDENCE'; maxDeviationBps: number } | { ok: false; reason: string } } | { error: unknown }
): ProbeOutcome {
  if ('error' in r) {
    const e = r.error as { name?: unknown; cause?: unknown };
    const cause = typeof e?.cause === 'string' ? e.cause : null;
    if (e?.name === 'PriceSourceDisagreementError') return { status: 'NOT_VERIFIED_NOW', reason: 'SOURCES_DISAGREE' };
    if (e?.name === 'PriceUnavailableError' && cause && DETERMINATE_CAUSES.has(cause)) return { status: 'NOT_VERIFIED_NOW', reason: cause };
    return { status: 'PROBE_ERROR', reason: cause ?? (typeof e?.name === 'string' ? e.name : 'UNKNOWN_ERROR') };
  }
  const d = r.decision;
  if (!d.ok) return { status: 'NOT_VERIFIED_NOW', reason: `POLICY_${d.reason}` };
  if (d.tier !== 'VERIFIED') return { status: 'NOT_VERIFIED_NOW', reason: `CHAINLINK_UNAVAILABLE (the policy would allow a ${d.maxDeviationBps} bps band)` };
  return { status: 'VERIFIED_NOW', detail: `Chainlink-verified, ${d.maxDeviationBps} bps band` };
}

// --------------------------------- exit code ---------------------------------

/**
 * 0: inventory complete, static coverage complete (or no fee-bearing positions), and — with a probe — every required
 *    priced leg VERIFIED_NOW.
 * 1: a determinate gap: missing feed, unsupported/unknown asset or chain, or a probe answer other than VERIFIED_NOW.
 * 2: no determinate answer: inventory incomplete, configuration error, or a probe that could not complete.
 */
export function gateExitCode(report: CoverageReport, probe: Map<string, ProbeOutcome> | null): 0 | 1 | 2 {
  if (report.status === 'INCOMPLETE') return 2;
  if (probe) {
    const required = requiredPricedLegs(report);
    for (const l of required) {
      const o = probe.get(`${l.chain}:${l.address}`);
      if (!o || o.status === 'PROBE_ERROR') return 2; // never silently skipped
    }
  }
  if (report.status === 'STATIC_GAPS') return 1;
  if (probe && [...probe.values()].some((o) => o.status === 'NOT_VERIFIED_NOW')) return 1;
  return 0;
}
