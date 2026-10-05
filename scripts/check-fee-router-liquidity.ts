/**
 * READ-ONLY: can a fee-paying sale of each Robinhood Chain stock token execute through RedeemFeeRouter?
 * (B0 live-validation prerequisite, docs/FEE_ECONOMICS_DESIGN.md.) The fee path does NOT use LI.FI: it quotes and
 * swaps through Uniswap v3 directly, trying fee tiers 0.3% → 0.05% → 1% and using the first that quotes — exactly
 * as signFeeAttestation does. "A LI.FI route exists" says nothing about this path.
 *
 * No key, no transaction: only QuoterV2 eth_call simulations and (optionally) a read of the asset registry.
 *
 *   npx tsx scripts/check-fee-router-liquidity.ts                       # every VERIFIED stock token in Supabase, $100
 *   npx tsx scripts/check-fee-router-liquidity.ts --usd=25,100,500      # several sale sizes
 *   npx tsx scripts/check-fee-router-liquidity.ts --symbols=AMKR,SOXX   # only these
 *   npx tsx scripts/check-fee-router-liquidity.ts --out=liquidity.json  # also write the results as JSON
 *
 * Env: RPC_URL_ROBINHOOD (optional; defaults to the public Robinhood Chain RPC). The asset list comes from Supabase
 * (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local, read only).
 *
 * Exit code: 0 when every checked token is executable at every size, 1 otherwise, 2 on setup errors.
 */
import './load-env';
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type PublicClient } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, ROBINHOOD_RPC_URL } from '../lib/config/robinhood-chain';
import { createRobinhoodUniswapQuoter } from '../lib/blockchain/robinhood-uniswap-quoter';
import { COMMON_FEE_TIERS } from '../lib/blockchain/robinhood-swap-builder';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '../lib/blockchain/lifi-purchase-quote';
import { checkFeeRouterExecutability, formatExecutabilityRow, type ExecutabilityResult } from '../lib/domain/basket-protocol/redeem/fee-router-executability';
import { listAssets } from '../lib/server/asset-repo';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CONCURRENCY = 4;

async function main() {
  const sizes = (arg('usd') ?? '100').split(',').map(Number);
  if (sizes.some((s) => !Number.isFinite(s) || s <= 0)) {
    console.error('--usd must be positive numbers, e.g. --usd=25,100,500');
    process.exit(2);
  }
  const onlySymbols = arg('symbols')?.split(',').map((s) => s.trim().toUpperCase());

  const rpcUrl = process.env.RPC_URL_ROBINHOOD || ROBINHOOD_RPC_URL;
  const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as PublicClient;
  const chainId = await client.getChainId().catch((e: Error) => {
    console.error(`RPC_FAILURE: cannot reach ${rpcUrl}: ${e.message}`);
    process.exit(2);
  });
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    console.error(`WRONG_CHAIN: ${rpcUrl} reports chainId ${chainId}, expected ${ROBINHOOD_CHAIN_ID}.`);
    process.exit(2);
  }

  if (!isSupabaseConfigured()) {
    console.error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): the asset list cannot be read.');
    process.exit(2);
  }
  const assets = (await listAssets(supabaseAdmin(), { chain: 'robinhood' }))
    .filter((a) => a.status === 'VERIFIED' && a.assetType === 'stock')
    .filter((a) => !onlySymbols || onlySymbols.includes(a.symbol.toUpperCase()))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (assets.length === 0) {
    console.error('No matching VERIFIED stock tokens on robinhood.');
    process.exit(2);
  }

  const quote = createRobinhoodUniswapQuoter(client);
  const usdg = { address: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`, decimals: ROBINHOOD_REWARD_TOKEN.decimals };
  const jobs = assets.flatMap((a) => sizes.map((sizeUsdg) => ({ a, sizeUsdg })));
  const results: ExecutabilityResult[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) {
        const i = next++;
        const { a, sizeUsdg } = jobs[i];
        results[i] = await checkFeeRouterExecutability({
          token: { symbol: a.symbol, address: a.address as `0x${string}`, decimals: a.decimals },
          usdg,
          sizeUsdg,
          slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
          feeTiers: COMMON_FEE_TIERS,
          quote,
        });
      }
    })
  );

  console.log(`Robinhood Chain ${chainId} via ${rpcUrl} · Uniswap v3 tiers ${COMMON_FEE_TIERS.join('/')} (first that quotes) · min = quote × ${(10000 - DEFAULT_COMPOSER_SLIPPAGE_BPS) / 100}%`);
  console.log(['TOKEN'.padEnd(8), 'STAT'.padEnd(5), 'TIER'.padEnd(6), 'SIZE'.padEnd(11), 'QUOTE'.padEnd(11), 'GROSS MIN'.padEnd(11), 'EXEC', 'REASON'].join(' '));
  for (const r of results) console.log(formatExecutabilityRow(r, usdg.decimals));

  const pass = results.filter((r) => r.executable).length;
  const byReason = results.reduce<Record<string, number>>((m, r) => ((m[r.reason] = (m[r.reason] ?? 0) + 1), m), {});
  console.log(`\n${pass}/${results.length} executable · ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log('Read-only: no transaction was sent. A PASS means the quote and its 99% floor exist right now at that size; prices move.');

  const out = arg('out');
  if (out) {
    writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), chainId, rpcUrl, sizesUsdg: sizes, feeTiers: COMMON_FEE_TIERS, slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS, results }, null, 2));
    console.log(`Wrote ${out}`);
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
