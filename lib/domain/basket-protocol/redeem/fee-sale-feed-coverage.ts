// -----------------------------------------------------------------------------
// Which fee-bearing Bags can be sold under the fee-sale confidence policy
// (sale-price-confidence.ts)? Pure: the caller supplies the Bags, the asset
// registry's classification and the configured Chainlink feed map.
//
// A sale leg is usable for a fee sale only when its reference price can be
// CHAINLINK_VERIFIED (or, while the feed is unreadable, CHAINLINK_UNAVAILABLE).
// Both require a feed in ROBINHOOD_CHAINLINK_FEEDS for that Stock Token:
//
//   NOT_PRICED          the settlement token (USDG): no swap, no price check
//   FEED_CONFIGURED     a Stock Token with a configured feed — necessary, not
//                       sufficient: the feed must also be readable and agree
//   MISSING_FEED        a Stock Token without a feed → no confidence → refused
//   NO_QUALIFIED_SOURCE a crypto asset (LI.FI / TWAP price, no confidence) → refused
//   UNKNOWN_ASSET       not in the asset registry → refused (cannot even classify)
//
// Fee sales run on Robinhood Chain only; a fee-bearing Bag elsewhere is
// CHAIN_NOT_SUPPORTED. The legs are the CURRENT version's recipe assets: a
// holder can still hold assets of earlier versions, which this does not see.
// -----------------------------------------------------------------------------

export type LegCoverage = 'NOT_PRICED' | 'FEED_CONFIGURED' | 'MISSING_FEED' | 'NO_QUALIFIED_SOURCE' | 'UNKNOWN_ASSET';

export interface CoverageBag {
  id: string;
  name: string;
  chain: string;
  /** Effective rate: performanceFeeBpsLocked ?? current recipe's performanceFeeBps ?? 0 (as redeem-execution.ts). */
  feeBps: number;
  assets: { address: string; symbol: string }[];
}

export interface CoverageInput {
  bags: CoverageBag[];
  settlementTokenAddress: string;
  /** Registry classification by lowercase address; missing = not in the registry. */
  assetTypes: Map<string, 'stock' | 'crypto'>;
  /** Lowercase asset address → feed (ROBINHOOD_CHAINLINK_FEEDS, already parsed). */
  feeds: Record<string, string>;
}

export interface BagCoverage {
  id: string;
  name: string;
  chain: string;
  feeBps: number;
  status: 'READY_IF_FEEDS_LIVE' | 'FEE_SALE_REFUSED' | 'CHAIN_NOT_SUPPORTED';
  legs: { symbol: string; address: string; coverage: LegCoverage }[];
}

export function feeSaleFeedCoverage(input: CoverageInput): BagCoverage[] {
  const usdg = input.settlementTokenAddress.toLowerCase();
  return input.bags
    .filter((b) => b.feeBps > 0)
    .map((b) => {
      if (b.chain !== 'robinhood') return { id: b.id, name: b.name, chain: b.chain, feeBps: b.feeBps, status: 'CHAIN_NOT_SUPPORTED' as const, legs: [] };
      const legs = b.assets.map((a) => {
        const k = a.address.toLowerCase();
        const type = input.assetTypes.get(k);
        const coverage: LegCoverage =
          k === usdg ? 'NOT_PRICED' : type === undefined ? 'UNKNOWN_ASSET' : type === 'crypto' ? 'NO_QUALIFIED_SOURCE' : input.feeds[k] ? 'FEED_CONFIGURED' : 'MISSING_FEED';
        return { symbol: a.symbol, address: a.address, coverage };
      });
      const ready = legs.every((l) => l.coverage === 'NOT_PRICED' || l.coverage === 'FEED_CONFIGURED');
      return { id: b.id, name: b.name, chain: b.chain, feeBps: b.feeBps, status: ready ? ('READY_IF_FEEDS_LIVE' as const) : ('FEE_SALE_REFUSED' as const), legs };
    });
}
