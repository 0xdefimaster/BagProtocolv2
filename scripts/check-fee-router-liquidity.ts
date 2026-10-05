/**
 * READ-ONLY: would a fee-paying sale of each Robinhood Chain stock token be signed by signFeeAttestation, at a
 * fair price? (B0 live-validation prerequisite, docs/FEE_ECONOMICS_DESIGN.md.) The fee path does NOT use LI.FI: it
 * quotes and swaps through Uniswap v3 directly. "A LI.FI route exists" says nothing about this path.
 *
 * No key, no transaction: QuoterV2 eth_call simulations, BAG's price provider, and a read of the asset registry.
 *
 *   npx tsx scripts/check-fee-router-liquidity.ts                       # every VERIFIED stock token in Supabase, $100
 *   npx tsx scripts/check-fee-router-liquidity.ts --usd=25,100,500      # several sale sizes
 *   npx tsx scripts/check-fee-router-liquidity.ts --symbols=AMKR,SOXX   # only these
 *   npx tsx scripts/check-fee-router-liquidity.ts --out=liquidity.json  # also write the results as JSON
 *   npx tsx scripts/check-fee-router-liquidity.ts --max-deviation-bps=300  # allowed deviation (default: the attestation's, 5%)
 *
 * Each sale leg is judged by the attestation's own rule (redeem-quote-quality.ts): best Uniswap v3 tier, compared
 * with BAG's verified price. STATUS: PASS (would be signed) · UNSAFE (a quote exists but is too far below the
 * verified price — refused) · FAIL (no quote or no verified price) · INDETERMINATE (RPC error: no result either way,
 * re-run). The RPC URL is never printed.
 *
 * Env: RPC_URL_ROBINHOOD (optional; defaults to the public Robinhood Chain RPC). The asset list comes from Supabase
 * (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local, read only).
 *
 * First it verifies on-chain that the configured QuoterV2 and SwapRouter02 exist and point at the configured
 * UniswapV3Factory (a wrong address would otherwise look like "no liquidity" everywhere).
 *
 * Exit code: 0 when every checked token is executable at every size, 1 otherwise, 2 on setup errors.
 */
import './load-env';
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type PublicClient } from 'viem';
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_REWARD_TOKEN,
  ROBINHOOD_RPC_URL,
  UNISWAP_QUOTER_V2_ADDRESS,
  UNISWAP_ROUTER_ADDRESS,
  UNISWAP_V3_FACTORY_ADDRESS,
} from '../lib/config/robinhood-chain';
import { createRobinhoodUniswapQuoter } from '../lib/blockchain/robinhood-uniswap-quoter';
import { COMMON_FEE_TIERS } from '../lib/blockchain/robinhood-swap-builder';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '../lib/blockchain/lifi-purchase-quote';
import { FEE_REDEEM_MAX_PRICE_DEVIATION_BPS } from '../lib/domain/basket-protocol/redeem/redeem-quote-quality';
import { getPriceProvider } from '../lib/server/price-provider';
import {
  checkFeeRouterExecutability,
  formatExecutabilityRow,
  redactRpcUrl,
  type ExecutabilityResult,
  type QuoteFn,
} from '../lib/domain/basket-protocol/redeem/fee-router-executability';
import { listAssets } from '../lib/server/asset-repo';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

const FACTORY_ABI = [{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;

/**
 * Before any quote: the configured QuoterV2 and SwapRouter02 must be deployed contracts that point at the configured
 * UniswapV3Factory. Otherwise every quote would fail for a configuration reason and be misread as "no liquidity".
 */
async function verifyUniswapConfig(client: PublicClient): Promise<void> {
  const checks: [string, `0x${string}` | null][] = [
    ['QuoterV2', UNISWAP_QUOTER_V2_ADDRESS],
    ['SwapRouter02', UNISWAP_ROUTER_ADDRESS],
  ];
  if (!(await client.getCode({ address: UNISWAP_V3_FACTORY_ADDRESS }))) {
    throw new Error(`UniswapV3Factory ${UNISWAP_V3_FACTORY_ADDRESS} has no code on this chain.`);
  }
  for (const [name, address] of checks) {
    if (!address) throw new Error(`${name} address is not configured.`);
    if (!(await client.getCode({ address }))) throw new Error(`${name} ${address} has no code on this chain.`);
    const factory = (await client.readContract({ address, abi: FACTORY_ABI, functionName: 'factory' })) as string;
    if (factory.toLowerCase() !== UNISWAP_V3_FACTORY_ADDRESS.toLowerCase()) {
      throw new Error(`${name} ${address} points at factory ${factory}, not the configured ${UNISWAP_V3_FACTORY_ADDRESS}.`);
    }
  }
  console.log(`Uniswap config verified on-chain: QuoterV2 ${UNISWAP_QUOTER_V2_ADDRESS} and SwapRouter02 ${UNISWAP_ROUTER_ADDRESS} → factory ${UNISWAP_V3_FACTORY_ADDRESS}`);
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// Low on purpose: public/free-tier RPCs rate-limit, and a rate-limit error is not a liquidity result.
const CONCURRENCY = 2;

/** Retries an RPC failure (never a revert — the quoter already returns null for those) with backoff. */
function withRetry(quote: QuoteFn, attempts = 5): QuoteFn {
  return async (args) => {
    for (let i = 0; ; i++) {
      try {
        return await quote(args);
      } catch (e) {
        if (i >= attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  };
}

async function main() {
  const sizes = (arg('usd') ?? '100').split(',').map(Number);
  if (sizes.some((s) => !Number.isFinite(s) || s <= 0)) {
    console.error('--usd must be positive numbers, e.g. --usd=25,100,500');
    process.exit(2);
  }
  const onlySymbols = arg('symbols')?.split(',').map((s) => s.trim().toUpperCase());
  const maxDeviationBps = arg('max-deviation-bps') ? Number(arg('max-deviation-bps')) : FEE_REDEEM_MAX_PRICE_DEVIATION_BPS;

  const rpcUrl = process.env.RPC_URL_ROBINHOOD || ROBINHOOD_RPC_URL;
  // Never print the RPC URL itself: API keys live in its path or query.
  const rpcLabel = redactRpcUrl(rpcUrl);
  const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as PublicClient;
  const chainId = await client.getChainId().catch((e: Error) => {
    console.error(`RPC_FAILURE: cannot reach ${rpcLabel}: ${e.message.split('\n')[0]}`);
    process.exit(2);
  });
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    console.error(`WRONG_CHAIN: ${rpcLabel} reports chainId ${chainId}, expected ${ROBINHOOD_CHAIN_ID}.`);
    process.exit(2);
  }

  try {
    await verifyUniswapConfig(client);
  } catch (e) {
    console.error(`UNISWAP_CONFIG_UNVERIFIED: ${(e as Error).message.split(rpcUrl).join(rpcLabel).split('\n')[0]}`);
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

  // BAG's verified price per token — the same provider (and strictness) the attestation uses.
  const priceProvider = getPriceProvider();
  const prices = new Map<string, { price: string | null; error?: string }>();
  for (const a of assets) {
    try {
      prices.set(a.address, { price: (await priceProvider.getPrice({ chain: 'robinhood', address: a.address })).price });
    } catch (e) {
      prices.set(a.address, { price: null, error: (e as Error).message.split('\n')[0] });
    }
  }

  const quote = withRetry(createRobinhoodUniswapQuoter(client));
  const usdg = { address: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`, decimals: ROBINHOOD_REWARD_TOKEN.decimals };
  const jobs = assets.flatMap((a) => sizes.map((sizeUsd) => ({ a, sizeUsd })));
  const results: ExecutabilityResult[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) {
        const i = next++;
        const { a, sizeUsd } = jobs[i];
        const p = prices.get(a.address)!;
        results[i] = await checkFeeRouterExecutability({
          token: { symbol: a.symbol, address: a.address as `0x${string}`, decimals: a.decimals },
          usdg,
          sizeUsd,
          priceUsd: p.price,
          ...(p.error ? { priceError: p.error } : {}),
          slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
          feeTiers: COMMON_FEE_TIERS,
          maxDeviationBps,
          quote,
        });
      }
    })
  );

  // RPC error texts embed the request URL (and so the API key): scrub it before printing or writing anything.
  for (const r of results) if (r.error) r.error = r.error.split(rpcUrl).join(rpcLabel);

  console.log(
    `Robinhood Chain ${chainId} via ${rpcLabel} · best of Uniswap v3 tiers ${COMMON_FEE_TIERS.join('/')} · refused when more than ${maxDeviationBps / 100}% below BAG's verified price · min = quote × ${(10000 - DEFAULT_COMPOSER_SLIPPAGE_BPS) / 100}%`
  );
  console.log(['TOKEN'.padEnd(8), 'STATUS'.padEnd(13), 'TIER'.padEnd(6), 'SIZE'.padEnd(11), 'QUOTE'.padEnd(11), 'VERIFIED'.padEnd(11), 'GROSS MIN'.padEnd(11), 'SIGN', 'REASON'].join(' '));
  for (const r of results) console.log(formatExecutabilityRow(r, usdg.decimals));

  const pass = results.filter((r) => r.status === 'PASS').length;
  const count = (key: (r: ExecutabilityResult) => string) =>
    Object.entries(results.reduce<Record<string, number>>((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {}))
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
  console.log(`\n${pass}/${results.length} PASS · ${count((r) => r.status)} · reasons: ${count((r) => r.reason)}`);
  console.log('PASS = the attestation would sign it · UNSAFE = a quote exists but is too far below the verified price: refused · FAIL = no quote or no verified price · INDETERMINATE = RPC error, re-run.');
  console.log('Read-only: no transaction was sent. Results are a snapshot; prices and pools move.');

  const out = arg('out');
  if (out) {
    writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), chainId, rpc: rpcLabel, maxDeviationBps, sizesUsd: sizes, feeTiers: COMMON_FEE_TIERS, slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS, results }, null, 2));
    console.log(`Wrote ${out}`);
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
