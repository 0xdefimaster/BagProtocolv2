/**
 * LIVE check of the Robinhood Chain price authority (Uniswap v3 TWAP vs USDG).
 * Read-only: no key, no transaction. Run where the Robinhood RPC is reachable:
 *
 *   ROBINHOOD_PRICE_POOLS='{"0x<asset>":"0x<pool>"}' \
 *   RPC_URL_ROBINHOOD=https://rpc.mainnet.chain.robinhood.com \
 *   npx tsx scripts/verify-robinhood-price.ts
 *
 * Prints, per configured asset, the TWAP price and its source/timestamp — or
 * the exact reason it failed closed. Never prints a fabricated number.
 */
import './load-env';
import { createPublicClient, http } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, ROBINHOOD_RPC_URL, UNISWAP_V3_FACTORY_ADDRESS } from '../lib/config/robinhood-chain';
import { parseRobinhoodPricePools, RobinhoodTwapPriceProvider } from '../lib/domain/basket-protocol/pricing/robinhood-twap-provider';

async function main() {
  const rpcUrl = process.env.RPC_URL_ROBINHOOD || ROBINHOOD_RPC_URL;
  const pools = parseRobinhoodPricePools(process.env.ROBINHOOD_PRICE_POOLS);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId().catch((e) => {
    console.error(`RPC_FAILURE: cannot reach ${rpcUrl}: ${(e as Error).message}`);
    process.exit(2);
  });
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    console.error(`WRONG_CHAIN: ${rpcUrl} reports chainId ${chainId}, expected ${ROBINHOOD_CHAIN_ID}.`);
    process.exit(2);
  }
  const provider = new RobinhoodTwapPriceProvider({
    client,
    factoryAddress: UNISWAP_V3_FACTORY_ADDRESS,
    usdg: { address: ROBINHOOD_REWARD_TOKEN.address, decimals: ROBINHOOD_REWARD_TOKEN.decimals },
    pools,
    windowSeconds: process.env.ROBINHOOD_TWAP_WINDOW_SECONDS ? Number(process.env.ROBINHOOD_TWAP_WINDOW_SECONDS) : undefined,
  });
  const assets = [ROBINHOOD_REWARD_TOKEN.address, ...Object.keys(pools)];
  if (assets.length === 1) console.warn('No ROBINHOOD_PRICE_POOLS configured — only the USDG peg can be shown.');
  let failures = 0;
  for (const address of assets) {
    try {
      const p = await provider.getPrice({ chain: 'robinhood', address });
      console.log(`OK    ${address}  ${p.price} ${p.quoteCurrency}  source=${p.source}  at=${p.timestamp}`);
    } catch (e) {
      failures++;
      console.log(`FAIL  ${address}  ${(e as Error).name}: ${(e as Error).message}`);
    }
  }
  process.exit(failures ? 1 : 0);
}
main();
