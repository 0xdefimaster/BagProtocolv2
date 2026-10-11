import { formatDec, mulDiv, parseDec } from '@/lib/domain/basket-protocol/accounting/decimal';

// -----------------------------------------------------------------------------
// What a VERIFIED sale debits from the ledger.
//
// A sale is sized at quote time from what the wallet holds of what BAG tracks for the strategy. If the ledger
// shrinks before the sale is booked (an earlier sale booked late, e.g. a wallet batch recovered after the fact),
// the tokens still left the wallet on-chain, but only what the ledger still tracks is the strategy's. So each leg
// debits at most the tracked holding, the share burn is at most the remaining shares, and the leg's proceeds and
// the sale's value shrink in the same proportion as its debit. When the ledger covers the sale, nothing changes.
// A leg left with nothing to debit is dropped (its tokens were never the strategy's).
// -----------------------------------------------------------------------------

export interface SaleLeg {
  chain: string;
  address: string;
  quantityRaw: bigint;
  /** What the leg returned, raw, in the output asset. */
  proceedsRaw: bigint | null;
}

export interface LedgerCover {
  sharesRaw: bigint;
  /** `${chain}:${lowercased address}` → what the ledger tracks for this user and strategy. */
  trackedRaw: Map<string, bigint>;
}

export interface AttributedSale {
  legs: SaleLeg[];
  sharesBurnRaw: bigint;
  redeemValueQuote: string;
  /** True when anything was reduced to fit the ledger. */
  reduced: boolean;
}

export const ledgerKey = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function attributeSaleToLedger(sale: { legs: SaleLeg[]; sharesBurnRaw: bigint; redeemValueQuote: string }, cover: LedgerCover): AttributedSale {
  const remaining = new Map(cover.trackedRaw);
  let reduced = false;
  let proceedsBefore = BigInt(0);
  let proceedsAfter = BigInt(0);
  const legs: SaleLeg[] = [];
  for (const leg of sale.legs) {
    const key = ledgerKey(leg.chain, leg.address);
    const available = remaining.get(key) ?? BigInt(0);
    const quantityRaw = min(leg.quantityRaw, available);
    remaining.set(key, available - quantityRaw);
    const proceedsRaw =
      leg.proceedsRaw === null || quantityRaw === leg.quantityRaw ? leg.proceedsRaw : leg.quantityRaw === BigInt(0) ? BigInt(0) : mulDiv(leg.proceedsRaw, quantityRaw, leg.quantityRaw);
    if (quantityRaw !== leg.quantityRaw) reduced = true;
    proceedsBefore += leg.proceedsRaw ?? BigInt(0);
    proceedsAfter += proceedsRaw ?? BigInt(0);
    if (quantityRaw > BigInt(0)) legs.push({ ...leg, quantityRaw, proceedsRaw });
  }
  const sharesBurnRaw = min(sale.sharesBurnRaw, cover.sharesRaw);
  if (sharesBurnRaw !== sale.sharesBurnRaw) reduced = true;
  const redeemValueQuote =
    reduced && proceedsBefore > BigInt(0) ? formatDec(mulDiv(parseDec(sale.redeemValueQuote), proceedsAfter, proceedsBefore)) : sale.redeemValueQuote;
  return { legs, sharesBurnRaw, redeemValueQuote, reduced };
}
