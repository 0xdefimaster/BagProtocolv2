import type { BagHoldingView } from '@/types';

// Assets at 0 are not shown on a Bag page: a 0% target in the allocation and, once the Bag holds something, an asset
// it holds none of (or only a zero-value amount) in the breakdown.

/** A holding of this asset with a quantity above 0 that is not priced at exactly 0. */
export function holdsSomething(held: BagHoldingView | undefined): held is BagHoldingView {
  return !!held && BigInt(held.quantityRaw) > BigInt(0) && !(held.value !== null && /^0*(\.0*)?$/.test(held.value));
}

export function visibleAssets<P extends { symbol: string; weight: number }>(composition: P[], holdings: BagHoldingView[] | undefined) {
  const heldOf = (symbol: string) => holdings?.find((h) => h.symbol.toUpperCase() === symbol.toUpperCase());
  const anyHeld = !!holdings?.some((h) => BigInt(h.quantityRaw) > BigInt(0));
  const allocation = composition.filter((pos) => pos.weight > 0);
  const breakdown = anyHeld ? allocation.filter((pos) => holdsSomething(heldOf(pos.symbol))) : allocation;
  return { allocation, breakdown, hidden: allocation.length - breakdown.length, heldOf };
}
