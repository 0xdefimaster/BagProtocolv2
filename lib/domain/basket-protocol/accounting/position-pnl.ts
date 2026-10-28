import { formatDec, mulDiv, parseDec } from './decimal';

// -----------------------------------------------------------------------------
// Accounting V2 / A3 — a position's cost basis and realized P&L, computed
// deterministically from its ledger events alone (docs/ACCOUNTING_V2_DESIGN.md
// §3.2–3.3). Pure: same events in, same numbers out.
//
//   - Average cost per asset. A fill adds quantity and the cost recorded on its
//     leg (`costQuote`); a sale or an external outflow removes quantity at the
//     current average cost.
//   - Realized P&L exists only for exits through BAG and only from proceeds
//     actually received (`proceedsQuote` on the leg, from the verified receipt).
//     NAV and quotes are never used.
//   - A rebalance (REBALANCE_FILL) realizes nothing either: the basis of what it
//     sold moves to what it bought, split by each bought leg's `weightBps` (its
//     share of the proceeds), so a gain stays unrealized until the position exits
//     through BAG and the performance fee applies there.
//   - An external outflow removes quantity and its basis but realizes nothing:
//     BAG does not know the proceeds. It is NOT a sale, gain or loss: the basis
//     that left is reported separately (`basisExitedExternallyQuote`) and must
//     never be read as a realized result by performance, fees or indexes.
//   - Where a cost or a proceeds amount is unknown (state that predates per-leg
//     costs), the affected numbers are null, never estimated. An asset's basis
//     becomes known again once its quantity returns to zero.
//   - Fee base: realized gain above the high-water mark of cumulative realized
//     P&L (losses carry forward). This is what the fee SHOULD be based on; the
//     fee actually charged is reported next to it, unchanged (on-chain fee
//     changes are a separate, audited PR).
// -----------------------------------------------------------------------------

export interface PnlLeg {
  chain: string;
  address: string;
  deltaRaw: string;
  costQuote?: string | null;
  proceedsQuote?: string | null;
  /** REBALANCE_FILL bought legs: share of the proceeds in bps. */
  weightBps?: number | null;
}

export interface PnlEvent {
  seq: string;
  kind: string;
  legs: PnlLeg[];
  quote: Record<string, unknown>;
  /** EXTERNAL_OUTFLOW / OUTFLOW_CLASSIFIED: `reconciliationRecordId` ties a classification to the outflow it corrects. */
  source?: Record<string, unknown>;
}

export interface AssetBasis {
  chain: string;
  address: string;
  quantityRaw: string;
  /** Total basis of the quantity held; null when unknown. */
  costBasisQuote: string | null;
  /**
   * The basis is known but approximate: an outflow it came back from was valued at an average cost that a later
   * purchase had already changed (0057). Stays until the asset is fully sold. No fee is computed on it.
   */
  costBasisApproximate: boolean;
}

export interface RealizedExit {
  seq: string;
  proceedsQuote: string | null;
  costOfSoldQuote: string | null;
  realizedPnlQuote: string | null;
  /** Realized gain above the high-water mark at this exit; null when realized P&L is unknown. */
  feeBaseQuote: string | null;
  partial: boolean;
}

export interface PositionPnl {
  assets: AssetBasis[];
  /** Σ asset basis; null if any held asset's basis is unknown. */
  costBasisQuote: string | null;
  /**
   * Σ realized P&L over BAG exits, BEFORE performance fees: gross proceeds − consumed basis. This is the strategy's
   * result and the only input to the high-water mark and the fee base; null if any exit's is unknown.
   */
  realizedPnlQuote: string | null;
  /** Highest cumulative realized P&L so far (never below 0). */
  realizedHighWaterMarkQuote: string | null;
  /** Σ performance fees charged (database-booked or settled on-chain). */
  feesChargedQuote: string;
  /** What the user actually realized: realizedPnlQuote − feesChargedQuote; null when realized P&L is unknown. */
  netRealizedPnlQuote: string | null;
  /** Basis that left with external outflows (no proceeds known, nothing realized). */
  basisExitedExternallyQuote: string | null;
  exits: RealizedExit[];
}

const ZERO = BigInt(0);
const key = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;
const isDec = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

interface State {
  chain: string;
  address: string;
  qty: bigint;
  basis: bigint;
  known: boolean;
  approximate: boolean;
}

export function computePositionPnl(events: PnlEvent[]): PositionPnl {
  const ordered = [...events].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
  const assets = new Map<string, State>();
  const asset = (leg: PnlLeg) => {
    const k = key(leg.chain, leg.address);
    let s = assets.get(k);
    if (!s) {
      s = { chain: leg.chain, address: leg.address, qty: ZERO, basis: ZERO, known: true, approximate: false };
      assets.set(k, s);
    }
    return s;
  };

  let realized: bigint | null = ZERO;
  let peak: bigint | null = ZERO;
  let fees = ZERO;
  let exitedBasis: bigint | null = ZERO;
  const exits: RealizedExit[] = [];
  // Per (outflow record, asset): what an EXTERNAL_OUTFLOW took off and has not been given back by OUTFLOW_CLASSIFIED.
  const outflows = new Map<string, { qty: bigint; basis: bigint | null }>();
  const outflowKey = (e: PnlEvent, leg: PnlLeg) => `${String(e.source?.reconciliationRecordId ?? '')}|${key(leg.chain, leg.address)}`;
  // Per (sale intent, asset): tokens an OUTFLOW_CLASSIFIED gave back for that sale, with the basis they left with. The
  // sale happened before anything bought since, so its REDEEM_FILL consumes this lot first, at exactly this basis,
  // never blended into the average cost of later purchases.
  const saleLots = new Map<string, { qty: bigint; basis: bigint | null; approximate: boolean }>();
  const saleLotKey = (intentId: unknown, leg: PnlLeg) => `${String(intentId ?? '')}|${key(leg.chain, leg.address)}`;

  /** Removes `sold` from the asset at average cost; returns the basis removed (null when unknown). */
  const remove = (s: State, sold: bigint): bigint | null => {
    if (sold <= ZERO) return ZERO;
    if (s.qty <= ZERO) {
      // Selling something the books do not hold: the basis of it is unknown.
      return null;
    }
    const take = sold > s.qty ? s.qty : sold;
    const consumed = s.known ? mulDiv(s.basis, take, s.qty) : null;
    s.qty -= take;
    if (consumed !== null) s.basis -= consumed;
    if (s.qty === ZERO) {
      s.basis = ZERO;
      s.known = true; // nothing left: whatever was unknown has left with it
      s.approximate = false;
    }
    return sold > take ? null : consumed;
  };

  for (const e of ordered) {
    switch (e.kind) {
      case 'OPENING_BALANCE':
      case 'PURCHASE_FILL': {
        for (const leg of e.legs) {
          const d = BigInt(leg.deltaRaw);
          if (d === ZERO) continue;
          const s = asset(leg);
          if (d > ZERO) {
            s.qty += d;
            if (isDec(leg.costQuote)) s.basis += parseDec(leg.costQuote);
            else s.known = false;
          } else {
            remove(s, -d);
          }
        }
        break;
      }
      case 'REDEEM_FILL': {
        let proceeds: bigint | null = ZERO;
        let cost: bigint | null = ZERO;
        for (const leg of e.legs) {
          const d = BigInt(leg.deltaRaw);
          if (d >= ZERO) continue;
          let sold = -d;
          let consumed: bigint | null = ZERO;
          const lk = saleLotKey(e.source?.intentId, leg);
          const lot = saleLots.get(lk);
          if (lot && lot.qty > ZERO) {
            const fromLot = sold < lot.qty ? sold : lot.qty;
            const lotBasis = lot.basis === null ? null : fromLot === lot.qty ? lot.basis : mulDiv(lot.basis, fromLot, lot.qty);
            saleLots.set(lk, { ...lot, qty: lot.qty - fromLot, basis: lot.basis === null || lotBasis === null ? null : lot.basis - lotBasis });
            consumed = lotBasis;
            sold -= fromLot;
          }
          const fromPool = sold > ZERO ? remove(asset(leg), sold) : ZERO;
          consumed = consumed === null || fromPool === null ? null : consumed + fromPool;
          cost = cost === null || consumed === null ? null : cost + consumed;
          proceeds = proceeds === null || !isDec(leg.proceedsQuote) ? null : proceeds + parseDec(leg.proceedsQuote);
        }
        const r = proceeds === null || cost === null ? null : proceeds - cost;
        let feeBase: bigint | null = null;
        if (r === null) {
          realized = null;
          peak = null;
        } else if (realized !== null && peak !== null) {
          realized += r;
          feeBase = realized > peak ? realized - peak : ZERO;
          if (realized > peak) peak = realized;
        }
        exits.push({
          seq: e.seq,
          proceedsQuote: proceeds === null ? null : formatDec(proceeds),
          costOfSoldQuote: cost === null ? null : formatDec(cost),
          realizedPnlQuote: r === null ? null : formatDec(r),
          feeBaseQuote: feeBase === null ? null : formatDec(feeBase),
          partial: e.quote.partial === true,
        });
        break;
      }
      case 'REBALANCE_FILL': {
        let moved: bigint | null = ZERO;
        for (const leg of e.legs) {
          const d = BigInt(leg.deltaRaw);
          if (d >= ZERO) continue;
          const consumed = remove(asset(leg), -d);
          moved = moved === null || consumed === null ? null : moved + consumed;
        }
        const bought = e.legs.filter((leg) => BigInt(leg.deltaRaw) > ZERO);
        const weights = bought.map((leg) => (Number.isInteger(leg.weightBps) && (leg.weightBps as number) > 0 ? BigInt(leg.weightBps as number) : ZERO));
        const totalWeight = weights.reduce((a, w) => a + w, ZERO);
        let left = moved;
        bought.forEach((leg, i) => {
          const s = asset(leg);
          s.qty += BigInt(leg.deltaRaw);
          if (left === null || moved === null || totalWeight === ZERO) {
            s.known = false;
            return;
          }
          // The last bought leg takes the rounding remainder, so the basis moved is conserved exactly.
          const part = i === bought.length - 1 ? left : mulDiv(moved, weights[i], totalWeight);
          s.basis += part;
          left -= part;
        });
        break;
      }
      case 'EXTERNAL_OUTFLOW': {
        for (const leg of e.legs) {
          const d = BigInt(leg.deltaRaw);
          if (d >= ZERO) continue;
          const s = asset(leg);
          const before = s.qty;
          const consumed = remove(s, -d);
          exitedBasis = exitedBasis === null || consumed === null ? null : exitedBasis + consumed;
          const taken = before - s.qty;
          const k = outflowKey(e, leg);
          const prev = outflows.get(k) ?? { qty: ZERO, basis: ZERO };
          outflows.set(k, { qty: prev.qty + taken, basis: prev.basis === null || consumed === null ? null : prev.basis + consumed });
        }
        break;
      }
      case 'OUTFLOW_CLASSIFIED': {
        // A sale explained (part of) an outflow: the tokens come back with exactly the basis the outflow took off them,
        // pro rata over what is still unexplained; the last classification takes the rest. The sale that follows
        // (REDEEM_FILL, later seq) then removes them at average cost and realizes its proceeds against that basis.
        for (const leg of e.legs) {
          const d = BigInt(leg.deltaRaw);
          if (d <= ZERO) continue;
          asset(leg); // the asset is held again
          const k = outflowKey(e, leg);
          const out = outflows.get(k);
          let back: bigint | null = null;
          if (out && out.qty > ZERO && out.basis !== null) {
            back = d >= out.qty ? out.basis : mulDiv(out.basis, d, out.qty);
            outflows.set(k, { qty: d >= out.qty ? ZERO : out.qty - d, basis: out.basis - back });
          }
          if (back !== null && exitedBasis !== null) exitedBasis -= back;
          const lk = saleLotKey(e.source?.redeemIntentId, leg);
          const lot = saleLots.get(lk) ?? { qty: ZERO, basis: ZERO, approximate: false };
          saleLots.set(lk, {
            qty: lot.qty + d,
            basis: lot.basis === null || back === null ? null : lot.basis + back,
            approximate: lot.approximate || e.quote.approximate === true,
          });
          if (e.quote.approximate === true) asset(leg).approximate = true;
        }
        break;
      }
      case 'FEE_CHARGED': {
        if (isDec(e.quote.amountQuote)) fees += parseDec(e.quote.amountQuote);
        break;
      }
      default:
        break; // ROYALTY_ACCRUED, RECONCILIATION_NOTE: no effect on this position's books
    }
  }

  // A lot given back for a sale that is not booked yet (the two RPCs run one after the other) is still held.
  for (const [lk, lot] of saleLots) {
    if (lot.qty <= ZERO) continue;
    const s = assets.get(lk.slice(lk.indexOf('|') + 1));
    if (!s) continue;
    s.qty += lot.qty;
    if (lot.basis === null) s.known = false;
    else s.basis += lot.basis;
  }
  const held = [...assets.values()].filter((s) => s.qty > ZERO);
  const allKnown = held.every((s) => s.known);
  return {
    assets: held.map((s) => ({
      chain: s.chain,
      address: s.address,
      quantityRaw: s.qty.toString(),
      costBasisQuote: s.known ? formatDec(s.basis) : null,
      costBasisApproximate: s.approximate,
    })),
    costBasisQuote: allKnown ? formatDec(held.reduce((a, s) => a + s.basis, ZERO)) : null,
    realizedPnlQuote: realized === null ? null : formatDec(realized),
    realizedHighWaterMarkQuote: peak === null ? null : formatDec(peak),
    feesChargedQuote: formatDec(fees),
    netRealizedPnlQuote: realized === null ? null : formatDec(realized - fees),
    basisExitedExternallyQuote: exitedBasis === null ? null : formatDec(exitedBasis),
    exits,
  };
}
