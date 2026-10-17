import './load-env';
import { getQuote } from '@lifi/sdk';
import { formatUnits, parseUnits } from 'viem';
import { listAssets } from '@/lib/server/asset-repo';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { getLiFiClient, toLiFiChainId } from '@/lib/blockchain/lifi-config';
import { buildComposerPurchase } from '@/lib/blockchain/lifi-composer-adapter';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';

// -----------------------------------------------------------------------------
// Read-only diagnosis of a failing Swap multi-buy paid with ETH. Runs the same
// steps as POST /api/wallet/buy-quote and prints what each one says:
//
//   1. the wallet's ETH balance on that chain vs the amount;
//   2. a plain LI.FI quote (what Jumper does) for each token's share;
//   3. the one-transaction Composer compile the Swap page uses, with the
//      reason for every leg that fails.
//
// USAGE
//   npx tsx scripts/probe-swap-buy.ts --chain=arbitrum --wallet=0xYourWallet --amount=0.004 "--symbols=bNVDA,ONDO"
//
// Nothing is signed or sent; no private key is read. Needs Supabase (to look
// the symbols up in the asset registry) and LIFI_API_KEY (for Composer).
// -----------------------------------------------------------------------------

const NATIVE = '0x0000000000000000000000000000000000000000';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** Same split as the Swap card: 10000 bps, the remainder to the first tokens. */
function equalShares(n: number): number[] {
  const base = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10000 - base * n ? 1 : 0));
}

async function main() {
  const chain = arg('chain') ?? '';
  const wallet = arg('wallet') ?? '';
  const amount = arg('amount') ?? '';
  const symbols = (arg('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!isBagChain(chain)) throw new Error('--chain must be one of ethereum, arbitrum, base, robinhood.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('--wallet must be your 0x… address.');
  if (!amount || symbols.length === 0) throw new Error('Pass --amount=0.004 and "--symbols=A,B".');
  if (!isSupabaseConfigured()) throw new Error('Supabase env vars are missing (.env.local).');
  const apiKey = process.env.LIFI_API_KEY;
  if (!apiKey) throw new Error('LIFI_API_KEY is missing from .env.local (copy it from Netlify; never paste it in chat).');

  const cfg = BAG_CHAINS[chain];
  const amountRaw = parseUnits(amount, cfg.nativeCurrency.decimals);

  console.log(`\n1) ETH balance on ${cfg.name}`);
  const balance = await getChainPublicClient(chain).getBalance({ address: wallet as `0x${string}` });
  console.log(`   wallet holds ${formatUnits(balance, 18)} ETH, spending ${amount} ETH`);
  if (balance < amountRaw) console.log('   !! NOT ENOUGH ETH on this chain — Composer simulates with your real balance, so every leg can fail.');

  const registry = await listAssets(supabaseAdmin(), { chain, status: 'VERIFIED' });
  const legs = symbols.map((sym) => {
    const matches = registry.filter((a) => a.symbol.toLowerCase() === sym.toLowerCase());
    if (matches.length !== 1) throw new Error(`${sym}: ${matches.length === 0 ? 'not in the VERIFIED registry on ' + chain : 'more than one registry row'}.`);
    return matches[0];
  });
  const shares = equalShares(legs.length);

  console.log('\n2) Plain LI.FI quote per token (what Jumper does)');
  for (const [i, asset] of legs.entries()) {
    const legAmount = (amountRaw * BigInt(shares[i])) / BigInt(10000);
    try {
      const step = await getQuote(getLiFiClient(), {
        fromChain: toLiFiChainId(chain),
        toChain: toLiFiChainId(chain),
        fromToken: NATIVE,
        toToken: asset.address,
        fromAmount: legAmount.toString(),
        fromAddress: wallet,
        slippage: DEFAULT_COMPOSER_SLIPPAGE_BPS / 10000,
      });
      const out = formatUnits(BigInt(step.estimate.toAmount), asset.decimals);
      console.log(`   ${asset.symbol.padEnd(8)} OK   ${formatUnits(legAmount, 18)} ETH → ${out} via ${step.toolDetails?.name ?? step.tool}`);
    } catch (err) {
      console.log(`   ${asset.symbol.padEnd(8)} FAIL ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n3) One-transaction Composer compile (what the Swap page does)');
  try {
    const compiled = await buildComposerPurchase({
      chain,
      inputTokenAddress: NATIVE,
      inputAmountRaw: amountRaw.toString(),
      legs: legs.map((a, i) => ({ address: a.address, weightBps: shares[i], symbol: a.symbol })),
      signerAddress: wallet,
      slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
      apiKey,
    });
    console.log(`   OK — price impact ${compiled.priceImpact?.impactBps ?? '—'} bps; the transaction was NOT sent.`);
  } catch (err) {
    console.log(`   FAIL ${err instanceof Error ? err.message : String(err)}`);
    const raw = (err as { cause?: unknown }).cause ?? err;
    const extra = raw as { code?: unknown; failedOps?: unknown; details?: unknown };
    if (extra.failedOps || extra.details) console.log(JSON.stringify({ code: extra.code, failedOps: extra.failedOps, details: extra.details }, null, 2));
  }
  console.log('\nRead-only — nothing was signed or sent.');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
