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
//   - An external outflow removes quantity and its basis but realizes nothing:
//     BAG does not know the proceeds.
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
}

export interface PnlEvent {
  seq: string;
  kind: string;
  legs: PnlLeg[];
  quote: Record<string, unknown>;
}

export interface AssetBasis {
  chain: string;
  address: string;
  quantityRaw: string;
  /** Total basis of the quantity held; null when unknown. */
  costBasisQuote: string | null;
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
  /** Σ realized P&L over BAG exits; null if any exit's is unknown. */
  realizedPnlQuote: string | null;
  /** Highest cumulative realized P&L so far (never below 0). */
  realizedHighWaterMarkQuote: string | null;
  feesChargedQuote: string;
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
}

export function computePositionPnl(events: PnlEvent[]): PositionPnl {
  const ordered = [...events].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
  const assets = new Map<string, State>();
  const asset = (leg: PnlLeg) => {
    const k = key(leg.chain, leg.address);
    let s = assets.get(k);
    if (!s) {
      s = { chain: leg.chain, address: leg.address, qty: ZERO, basis: ZERO, known: true };
      assets.set(k, s);
    }
    return s;
  };

  let realized: bigint | null = ZERO;
  let peak: bigint | null = ZERO;
  let fees = ZERO;
  let exitedBasis: bigint | null = ZERO;
  const exits: RealizedExit[] = [];

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
          const consumed = remove(asset(leg), -d);
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
      case 'EXTERNAL_OUTFLOW': {
        for (const leg of e.legs) {
          const d = BigInt(leg.deltaRaw);
          if (d >= ZERO) continue;
          const consumed = remove(asset(leg), -d);
          exitedBasis = exitedBasis === null || consumed === null ? null : exitedBasis + consumed;
        }
        break;
      }
      case 'FEE_CHARGED': {
        if (isDec(e.quote.amountQuote)) fees += parseDec(e.quote.amountQuote);
        break;
      }
      default:
        break; // ROYALTY_ACCRUED, OUTFLOW_CLASSIFIED, RECONCILIATION_NOTE: no effect on this position's books
    }
  }

  const held = [...assets.values()].filter((s) => s.qty > ZERO);
  const allKnown = held.every((s) => s.known);
  return {
    assets: held.map((s) => ({ chain: s.chain, address: s.address, quantityRaw: s.qty.toString(), costBasisQuote: s.known ? formatDec(s.basis) : null })),
    costBasisQuote: allKnown ? formatDec(held.reduce((a, s) => a + s.basis, ZERO)) : null,
    realizedPnlQuote: realized === null ? null : formatDec(realized),
    realizedHighWaterMarkQuote: peak === null ? null : formatDec(peak),
    feesChargedQuote: formatDec(fees),
    basisExitedExternallyQuote: exitedBasis === null ? null : formatDec(exitedBasis),
    exits,
  };
}
