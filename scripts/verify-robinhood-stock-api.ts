/**
 * LIVE check of Robinhood's Stock Token API and the BAG price layer.
 * Read-only: no key, no transaction. Run anywhere api.robinhood.com is reachable:
 *
 *   npx tsx scripts/verify-robinhood-stock-api.ts                 # AAPL, CRWD
 *   npx tsx scripts/verify-robinhood-stock-api.ts NVDA TSLA SGOV
 *
 *   # also cross-check against Chainlink (feed addresses from docs.chain.link):
 *   ROBINHOOD_CHAINLINK_FEEDS='{"0x<token>":"0x<feed>"}' npx tsx scripts/verify-robinhood-stock-api.ts
 *
 * Prints the registry size, every token whose multiplier is not 1 (the cases
 * where forgetting the multiplier is wrong), the RAW /prices payload per symbol
 * (so a response-shape change is visible), recent corporate actions, the
 * per-token quote, and the price
 * the production price layer would use — or the exact reason it fails closed.
 */
import './load-env';
import { fetchRobinhoodAssets } from '../lib/domain/basket-protocol/registry/robinhood-import';
import { ROBINHOOD_PRICES_URL, RobinhoodApiPriceProvider, RobinhoodStockApi } from '../lib/domain/basket-protocol/pricing/robinhood-stock-api';
import { ChainlinkFeedPriceProvider, parseChainlinkFeeds } from '../lib/domain/basket-protocol/pricing/chainlink-feed-provider';
import { BagPriceRouter } from '../lib/domain/basket-protocol/pricing/bag-price-router';
import { getLiFiTokenData, LiFiPriceProvider } from '../lib/blockchain/lifi-token-data';
import { getRobinhoodPublicClient } from '../lib/blockchain/robinhood-public-client';
import { ROBINHOOD_REWARD_TOKEN } from '../lib/config/robinhood-chain';

async function main() {
  const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['AAPL', 'CRWD'];
  const assets = await fetchRobinhoodAssets().catch((e) => {
    console.error(`REGISTRY_FAILURE: ${(e as Error).message}`);
    process.exit(2);
  });
  console.log(`/rhj/assets: ${assets.length} assets`);
  for (const a of assets) {
    if (!/^1(\.0*)?$/.test(String(a.currentMultiplier)) || a.pendingMultiplier) {
      console.log(`  multiplier ${a.tokenSymbol}: current=${a.currentMultiplier} pending=${JSON.stringify(a.pendingMultiplier ?? null)}`);
    }
  }

  const api = new RobinhoodStockApi();
  const client = getRobinhoodPublicClient();
  const layer = new BagPriceRouter({
    stockApi: api,
    stockPrices: new RobinhoodApiPriceProvider({ api }),
    chainlink: new ChainlinkFeedPriceProvider({ client, feeds: parseChainlinkFeeds(process.env.ROBINHOOD_CHAINLINK_FEEDS) }),
    crypto: new LiFiPriceProvider(getLiFiTokenData()),
    usdgAddress: ROBINHOOD_REWARD_TOKEN.address,
  });

  const actions = await api.corporateActions().catch((e) => (console.log(`corporate-actions: ${(e as Error).message}`), []));
  console.log(`/rhj/corporate-actions: ${actions.length} actions (latest: ${actions.slice(0, 3).map((a) => `${a.tokenSymbol} ${a.type} ${a.processDate}`).join(', ')})`);

  let failures = 0;
  for (const symbol of symbols) {
    console.log(`\n== ${symbol}`);
    const raw = await fetch(`${ROBINHOOD_PRICES_URL}/${encodeURIComponent(symbol)}`).then(async (r) => `${r.status} ${await r.text()}`).catch((e) => `ERROR ${(e as Error).message}`);
    console.log(`raw /prices: ${raw.slice(0, 600)}`);
    const token = await api.tokenBySymbol(symbol);
    if (!token) {
      failures++;
      console.log('NOT_A_STOCK_TOKEN (not an ACTIVE chain-4663 deployment in /rhj/assets)');
      continue;
    }
    try {
      const q = await api.quote(token);
      console.log(`token ${token.address} ×${token.currentMultiplier}: bid ${q.bid} ask ${q.ask} (raw ${q.rawBid} / ${q.rawAsk}) spread ${q.spreadBps}bps halt=${q.isTradingHalt} at ${q.generatedAt}`);
      const p = await layer.getPrice({ chain: 'robinhood', address: token.address });
      console.log(`OK    price layer: ${p.price} ${p.quoteCurrency} source=${p.source} confidence=${p.confidence ?? '-'}`);
    } catch (e) {
      failures++;
      console.log(`FAIL  ${(e as Error).name}: ${(e as Error).message}`);
    }
  }
  process.exit(failures ? 1 : 0);
}
main();
