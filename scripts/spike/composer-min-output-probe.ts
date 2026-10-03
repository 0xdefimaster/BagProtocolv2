import '../load-env';
import { createComposeSdk, guards, materialisers, raw, resources } from '@lifi/composer-sdk';
import type { Bindable } from '@lifi/composer-sdk';
import { isComposeError } from '@lifi/composer-sdk';
import type { ComposeCompileResult } from '@lifi/compose-spec';
import { ROBINHOOD_REWARD_TOKEN } from '../../lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// Composer per-leg minimum-output probe (spike — changes no app code).
//
// QUESTION: can a Composer flow enforce "each leg delivered at least X" ON
// CHAIN, the way BagExecutionRouter's `minOutputs` does? The installed
// @lifi/composer-sdk 0.5.0 exposes several candidate primitives; this script
// builds the SAME 2–3 leg purchase flow with each one, compiles it, lets the
// Composer server simulate it, and reports which primitive actually gates
// the leg's output.
//
// For every candidate it runs TWO compiles:
//   - REALISTIC threshold (the leg's own simulated amountOutMin, else
//     amountOut minus slippage) → must still compile + simulate OK;
//   - IMPOSSIBLE threshold (2x the simulated amountOut) → must be rejected
//     by the simulation (a revert). If it still compiles and simulates OK,
//     that primitive does NOT enforce the minimum.
// It also checks whether the threshold value is literally encoded in the
// transaction calldata — i.e. the check travels on-chain rather than being a
// compile-time-only server check.
//
// CANDIDATES
//   baseline      current app shape: lifi.swap(config.slippage) + slippage guard on `unspentIn`
//   A_guardSlip   guards.slippage on the swap's `amountOut` port (SDK doc example)
//   B_guardInv    guards.coreNumericInvariant({ port: 'amountOut', op: 'gte', threshold })
//   C_invGte      invariant.gte({ value: swap.amountOut }, threshold)          — separate node
//   D_assertGte   core.assertGte({ a: swap.amountOut, b: literal(threshold) }) — separate node
//
// USAGE (on a machine with LIFI_API_KEY and outbound access to composer.li.quest)
//   npx tsx scripts/spike/composer-min-output-probe.ts \
//     --signer 0xYourWallet --tokens 0xTokenA,0xTokenB[,0xTokenC] [--amount 1] [--slippage-bps 100]
//   or --symbols CASHCAT,HII,KLAC  (resolved from the Supabase asset registry, chain robinhood)
//
// The signer should hold at least --amount USDG on Robinhood Chain (the
// server simulates the real transaction). Nothing is signed or sent: this
// only calls Composer's compile endpoint. No private key is read.
// -----------------------------------------------------------------------------

const CHAIN_ID = 4663;

type Variant = 'baseline' | 'A_guardSlip' | 'B_guardInv' | 'C_invGte' | 'D_assertGte';
const VARIANTS: Variant[] = ['A_guardSlip', 'B_guardInv', 'C_invGte', 'D_assertGte'];

const DESCRIBE: Record<Variant, string> = {
  baseline: 'lifi.swap(config.slippage) + guards.slippage(port=unspentIn)  [current app]',
  A_guardSlip: 'guards.slippage(port=amountOut)  → slippage bound on each swap output',
  B_guardInv: 'guards.coreNumericInvariant(port=amountOut, gte, threshold)  → swap output >= threshold',
  C_invGte: 'invariant.gte(value=swap.amountOut, threshold)  → separate node, swap output >= threshold',
  D_assertGte: 'core.assertGte(a=swap.amountOut, b=literal threshold)  → separate node, a >= b',
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function resolveTokens(): Promise<{ symbol: string; address: string }[]> {
  const tokens = arg('tokens');
  if (tokens) return tokens.split(',').map((a, i) => ({ symbol: `leg${i}`, address: a.trim() }));
  const symbols = arg('symbols');
  if (!symbols) throw new Error('Pass --tokens 0x..,0x.. or --symbols CASHCAT,HII,KLAC');
  const { isSupabaseConfigured, supabaseAdmin } = await import('../../lib/supabase/server');
  if (!isSupabaseConfigured()) throw new Error('--symbols needs Supabase configured; use --tokens instead.');
  const wanted = symbols.split(',').map((s) => s.trim().toUpperCase());
  const { data, error } = await supabaseAdmin()
    .from('assets')
    .select('symbol,address')
    .eq('chain', 'robinhood')
    .eq('status', 'VERIFIED')
    .in('symbol', wanted);
  if (error) throw new Error(error.message);
  return wanted.map((s) => {
    const row = (data ?? []).find((r: { symbol: string }) => r.symbol.toUpperCase() === s);
    if (!row) throw new Error(`Symbol ${s} not found as a VERIFIED robinhood asset.`);
    return { symbol: s, address: row.address as string };
  });
}

/** Same cascade-split math as lib/blockchain/lifi-composer-adapter.ts (equal weights here). */
function cascadeBps(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) out.push(Math.min(9999, Math.max(1, Math.round(10000 / (n - i)))));
  return out;
}

interface RunOpts {
  variant: Variant;
  thresholds: bigint[] | null; // per leg; null for baseline
}

async function compileVariant(
  sdk: ReturnType<typeof createComposeSdk>,
  legs: { symbol: string; address: string }[],
  opts: RunOpts,
  common: { signer: string; amountRaw: bigint; slippageBps: number }
): Promise<ComposeCompileResult> {
  const builder = sdk.flow(CHAIN_ID, {
    name: `bag-probe-${opts.variant}`,
    inputs: { amountIn: resources.erc20(ROBINHOOD_REWARD_TOKEN.address as `0x${string}`, CHAIN_ID) },
  });
  const splits = cascadeBps(legs.length);
  let current: Bindable<'resource'> = builder.inputs.amountIn;

  legs.forEach((leg, i) => {
    let amountIn: Bindable<'resource'> = current;
    if (i < legs.length - 1) {
      const { a, b } = builder.core.split(`split_${i}`, { bind: { source: current }, config: { bps: splits[i] } });
      amountIn = a;
      current = b;
    }
    const threshold = opts.thresholds?.[i] ?? BigInt(0);
    const swapGuards: unknown[] = [guards.slippage({ port: 'unspentIn', bps: common.slippageBps })];
    if (opts.variant === 'A_guardSlip') swapGuards.push(guards.slippage({ port: 'amountOut', bps: common.slippageBps }));
    if (opts.variant === 'B_guardInv') swapGuards.push(guards.coreNumericInvariant({ port: 'amountOut', op: 'gte', threshold }));

    const swap = builder.lifi.swap(`swap_${i}`, {
      bind: { amountIn },
      config: {
        resourceOut: { kind: 'erc20', token: leg.address as `0x${string}`, chainId: CHAIN_ID },
        slippage: common.slippageBps / 10000,
      },
      // The generated type only admits guards on `unspentIn`; the probe
      // deliberately tries other ports to see what the server accepts.
      guards: swapGuards as never,
    });

    if (opts.variant === 'C_invGte') {
      builder.invariant.gte(`min_out_${i}`, {
        bind: { value: swap.amountOut as unknown as Bindable<'uint256'> },
        config: { threshold },
      });
    }
    if (opts.variant === 'D_assertGte') {
      builder.core.assertGte(`min_out_${i}`, {
        bind: { a: swap.amountOut as unknown as Bindable<'uint256'>, b: raw.literal('uint256', threshold.toString()) as unknown as Bindable<'uint256'> },
      });
    }
  });

  return builder.compile({
    signer: common.signer as `0x${string}`,
    inputs: { amountIn: materialisers.directDeposit({ amount: common.amountRaw }) },
    sweepTo: { $ref: 'context.sender' },
    checkOnChainAllowances: true,
    simulationPolicy: 'allow-revert',
    simulateUserProgram: true,
  });
}

type Outcome = { kind: 'ok'; result: ComposeCompileResult & { status: 'success' } } | { kind: 'reverted'; detail: string; result?: ComposeCompileResult } | { kind: 'error'; detail: string };

async function run(
  sdk: ReturnType<typeof createComposeSdk>,
  legs: { symbol: string; address: string }[],
  opts: RunOpts,
  common: { signer: string; amountRaw: bigint; slippageBps: number }
): Promise<Outcome> {
  try {
    const result = await compileVariant(sdk, legs, opts, common);
    if (result.status === 'success') return { kind: 'ok', result };
    const decoded = result.simulationRevert.decodeResult;
    const cand = decoded?.errorCandidates?.map((c) => `${c.decodedErrorSignature}(${c.decodedParams.join(', ')})`).join(' | ');
    return { kind: 'reverted', detail: `${result.error.kind}: ${result.error.message}${cand ? ` — ${cand}` : ''}${decoded?.error ? ` — ${decoded.error}` : ''}`, result };
  } catch (err) {
    if (isComposeError(err)) {
      const failed = err.failedOps?.map((f) => JSON.stringify(f)).join('; ');
      const detail = `${err.code}${err.kind ? `/${err.kind}` : ''}: ${err.message}${failed ? ` — failedOps: ${failed}` : ''}`;
      return err.kind === 'simulation_revert' || err.kind === 'subgraph_simulation_revert' ? { kind: 'reverted', detail } : { kind: 'error', detail };
    }
    return { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

const hex32 = (v: bigint) => v.toString(16).padStart(64, '0');
const inCalldata = (data: string, v: bigint) => data.toLowerCase().includes(hex32(v));

function logLegs(result: ComposeCompileResult, legs: { symbol: string }[]) {
  for (const [node, res] of Object.entries(result.producedResources)) {
    const i = Number(node.replace(/\D/g, ''));
    const token = 'token' in res ? res.token : 'native';
    console.log(
      `    produced ${node.padEnd(10)} ${legs[i]?.symbol ?? ''} token=${token} owner=${res.owner} simulated.amountOut=${res.simulated?.amountOut ?? '-'} amountOutMin=${res.simulated?.amountOutMin ?? '-'}`
    );
  }
  if ('verificationByNode' in result && result.verificationByNode) {
    console.log(`    verificationByNode: ${JSON.stringify(result.verificationByNode, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
  if ('userProgramSimulation' in result && result.userProgramSimulation) console.log(`    userProgramSimulation: ${result.userProgramSimulation.status}`);
}

async function main() {
  const apiKey = process.env.LIFI_API_KEY;
  if (!apiKey) throw new Error('LIFI_API_KEY is not set (.env.local).');
  const signer = arg('signer');
  if (!signer || !/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error('Pass --signer 0xYourWallet (holds USDG on Robinhood Chain).');
  const amount = Number(arg('amount') ?? '1');
  const slippageBps = Number(arg('slippage-bps') ?? '100');
  const amountRaw = BigInt(Math.round(amount * 10 ** ROBINHOOD_REWARD_TOKEN.decimals));
  const legs = await resolveTokens();
  if (legs.length < 2 || legs.length > 3) throw new Error('Use 2 or 3 tokens.');

  const sdk = createComposeSdk({ baseUrl: 'https://composer.li.quest', apiKey });
  const common = { signer, amountRaw, slippageBps };
  console.log(`Composer min-output probe · chain ${CHAIN_ID} · input ${amount} USDG · slippage ${slippageBps} bps · legs ${legs.map((l) => l.symbol).join(', ')}`);

  // 1. Baseline — current shape; gives each leg's simulated output.
  console.log(`\n[baseline] ${DESCRIBE.baseline}`);
  const base = await run(sdk, legs, { variant: 'baseline', thresholds: null }, common);
  if (base.kind !== 'ok') {
    console.log(`  baseline did not compile/simulate: ${base.detail}`);
    console.log('\nCannot derive thresholds without a working baseline. Check the signer holds USDG, the tokens have liquidity, and the API key.');
    process.exitCode = 1;
    return;
  }
  logLegs(base.result, legs);
  const txData = base.result.transactionRequest?.data ?? '';
  // producedResources is keyed by output port (`swap_0.amountOut`), not by node.
  const producedFor = (r: ComposeCompileResult, i: number) =>
    r.producedResources[`swap_${i}.amountOut`] ?? r.producedResources[`swap_${i}`];
  const sims = legs.map((_, i) => producedFor(base.result, i)?.simulated);
  if (sims.some((s) => !s)) {
    console.log('  baseline returned no simulated amounts per swap node; cannot derive thresholds.');
    process.exitCode = 1;
    return;
  }
  sims.forEach((s, i) => {
    const min = s!.amountOutMin;
    console.log(
      `  leg ${i} ${legs[i].symbol}: LI.FI amountOutMin ${min ?? '-'} ${min !== undefined ? (inCalldata(txData, min) ? 'IS encoded in calldata (on-chain min inside the swap)' : 'not found verbatim in calldata') : ''}`
    );
  });

  const realistic = sims.map((s) => s!.amountOutMin ?? (s!.amountOut * BigInt(10000 - slippageBps)) / BigInt(10000));
  const impossible = sims.map((s) => s!.amountOut * BigInt(2) + BigInt(1));

  // 2. Each candidate primitive: realistic must pass, impossible must revert.
  const summary: { variant: Variant; realistic: string; impossible: string; onChain: string; verdict: string }[] = [];
  for (const variant of VARIANTS) {
    console.log(`\n[${variant}] ${DESCRIBE[variant]}`);
    realistic.forEach((t, i) => console.log(`  checks leg ${i} ${legs[i].symbol}: output of swap_${i} (tokens held by the Composer proxy right after the swap) >= ${t} (realistic) / ${impossible[i]} (impossible)`));

    const ok = await run(sdk, legs, { variant, thresholds: realistic }, common);
    console.log(`  realistic → ${ok.kind}${ok.kind !== 'ok' ? `: ${ok.detail}` : ''}`);
    if (ok.kind === 'ok') logLegs(ok.result, legs);
    const onChain =
      ok.kind === 'ok' && ok.result.transactionRequest
        ? realistic.every((t) => inCalldata(ok.result.transactionRequest!.data, t))
          ? 'yes (every threshold encoded in calldata)'
          : 'not found verbatim'
        : '-';

    const bad = await run(sdk, legs, { variant, thresholds: impossible }, common);
    console.log(`  impossible → ${bad.kind}${bad.kind !== 'ok' ? `: ${bad.detail}` : ''}`);

    let verdict: string;
    if (ok.kind === 'error') verdict = 'UNSUPPORTED (rejected even with a realistic threshold)';
    else if (ok.kind === 'reverted') verdict = 'BROKEN (reverts with a realistic threshold)';
    else if (bad.kind === 'reverted') verdict = 'ENFORCED in simulation (impossible minimum reverts)';
    else if (bad.kind === 'error') verdict = 'CHECKED AT COMPILE TIME ONLY? (impossible minimum rejected before simulation)';
    else verdict = 'NOT ENFORCED (impossible minimum still compiles and simulates OK)';
    summary.push({ variant, realistic: ok.kind, impossible: bad.kind, onChain, verdict });
  }

  console.log('\n=== SUMMARY ===');
  console.log('variant       realistic  impossible  threshold-in-calldata                verdict');
  for (const s of summary) {
    console.log(`${s.variant.padEnd(13)} ${s.realistic.padEnd(10)} ${s.impossible.padEnd(11)} ${s.onChain.padEnd(36)} ${s.verdict}`);
  }
  console.log('\nA primitive is usable for BAG only if: realistic=ok, impossible=reverted, and its threshold is encoded on-chain.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
