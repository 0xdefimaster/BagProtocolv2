import { erc20Abi, type Hex } from 'viem';
import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';
import { RobinhoodStockApi, RobinhoodStockQuote } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';
import { getLiFiTokenData, LiFiTokenData, LiFiTokenUnavailableError } from '@/lib/blockchain/lifi-token-data';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { BagAsset, bagAssetFromCrypto, bagAssetFromOnchain, bagAssetFromStockToken } from '@/lib/domain/basket-protocol/assets/bag-asset';
import { getPriceProvider, getRobinhoodStockApi } from '@/lib/server/price-provider';

// -----------------------------------------------------------------------------
// BAG normalizer: (chain, address) → BagAsset, from the provider that is
// authoritative for each part.
//   Stock Token (Robinhood registry lists the address): metadata + bid/ask from
//     Robinhood, price from the price router.
//   Crypto: metadata from LI.FI; if LI.FI does not know the token, ERC-20
//     symbol/name/decimals read on-chain through the resilient RPC layer.
//     Price from the price router (LI.FI, documented fallbacks).
// Every external call is cached underneath (registry 5 min, stock prices 15 s,
// LI.FI tokens 60 s) and shared with the NAV/purchase path, so the asset API
// and the price router never fetch the same token twice.
// -----------------------------------------------------------------------------

export type ResolveBagAssetResult = { ok: true; asset: BagAsset } | { ok: false; error: 'UNSUPPORTED_CHAIN' | 'STOCK_REGISTRY_UNAVAILABLE' | 'TOKEN_UNAVAILABLE' };

export interface Erc20MetadataReader {
  (chain: AssetIdentity['chain'], address: string): Promise<{ symbol: string; name: string; decimals: number }>;
}

const readErc20Onchain: Erc20MetadataReader = async (chain, address) => {
  if (!isBagChain(chain)) throw new Error('not an EVM chain');
  const c = getChainPublicClient(chain);
  const a = address as Hex;
  const [symbol, name, decimals] = await Promise.all([
    c.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
    c.readContract({ address: a, abi: erc20Abi, functionName: 'name' }),
    c.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { symbol, name, decimals: Number(decimals) };
};

export interface BagAssetServiceDeps {
  stockApi: RobinhoodStockApi;
  lifi: LiFiTokenData;
  prices: PriceProvider;
  readErc20?: Erc20MetadataReader;
}

export class BagAssetService {
  constructor(private readonly deps: BagAssetServiceDeps) {}

  private async price(identity: AssetIdentity): Promise<{ price: AssetPrice | null; unavailable?: string }> {
    try {
      return { price: await this.deps.prices.getPrice(identity) };
    } catch (err) {
      return { price: null, unavailable: (err as Error).name || 'PRICE_UNAVAILABLE' };
    }
  }

  async resolve(identity: AssetIdentity): Promise<ResolveBagAssetResult> {
    if (!isBagChain(identity.chain)) return { ok: false, error: 'UNSUPPORTED_CHAIN' };
    const chainId = BAG_CHAINS[identity.chain].chainId;

    if (identity.chain === 'robinhood') {
      let token;
      try {
        token = await this.deps.stockApi.tokenByAddress(identity.address);
      } catch {
        return { ok: false, error: 'STOCK_REGISTRY_UNAVAILABLE' };
      }
      if (token) {
        const [quote, p] = await Promise.all([
          this.deps.stockApi.quote(token).catch((): RobinhoodStockQuote | null => null),
          this.price(identity),
        ]);
        return { ok: true, asset: bagAssetFromStockToken(chainId, token, quote, p.price, p.unavailable) };
      }
    }

    try {
      const token = await this.deps.lifi.getToken(identity.chain, identity.address);
      const p = await this.price(identity);
      return { ok: true, asset: bagAssetFromCrypto(token, p.price, p.unavailable) };
    } catch (err) {
      if (!(err instanceof LiFiTokenUnavailableError) || err.kind !== 'NOT_FOUND') return { ok: false, error: 'TOKEN_UNAVAILABLE' };
    }
    try {
      const meta = await (this.deps.readErc20 ?? readErc20Onchain)(identity.chain, identity.address);
      if (!meta.symbol || !Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 36) return { ok: false, error: 'TOKEN_UNAVAILABLE' };
      const p = await this.price(identity);
      return { ok: true, asset: bagAssetFromOnchain({ chainId, address: identity.address, ...meta }, p.price, p.unavailable) };
    } catch {
      return { ok: false, error: 'TOKEN_UNAVAILABLE' };
    }
  }
}

let shared: BagAssetService | null = null;
export function getBagAssetService(): BagAssetService {
  if (!shared) shared = new BagAssetService({ stockApi: getRobinhoodStockApi(), lifi: getLiFiTokenData(), prices: getPriceProvider() });
  return shared;
}
