// -----------------------------------------------------------------------------
// Base (8453) / Arbitrum One (42161) Phase 1 — LIVE, READ-ONLY checks.
// This file keeps the original Base CLI; evm-phase1-check.ts selects either chain.
//
//   ETH → USDC · USDC → WETH · USDC → cbBTC · WETH → USDC · USDC → cbETH · USDC → wstETH
//
// For each: chain detection and profile, token recognition (inspectToken),
// asset screening (the chain's PHASE1_REVIEWED_ASSETS), the signer's balance and
// allowance, the Composer account from the reviewed pin, a LI.FI Composer
// quote + compile WITH delivery proof, and simulateBag (eth_call).
//
// NOTHING IS SIGNED OR SENT. The signer is only the address the purchase is
// built for: no key is read. The reviewed assets are the starting test matrix,
// not the list of supported tokens.
//
//   RPC_URL=<Base RPC>  LIFI_API_KEY=...  \
//   COMPOSER_FACTORY=0x...  COMPOSER_FACTORY_CODE_HASH=0x...  \
//   npx tsx packages/bag-sdk/examples/base-phase1-check.ts <signer address>
//
// Optional EXTRA_OUTPUTS=0xToken,0xToken adds a "USDC -> token" scenario per address: a candidate for the
// reviewed set. It is screened as UNREVIEWED (allowed for this check only, and labelled so).
//
// Simulation uses assumeApprovals: when the allowance is missing, the swap itself is still eth_call'ed with a
// VERIFIED allowance-slot state override (OK_WITH_ASSUMED_APPROVALS). The approval is still not on chain.
//
// Per scenario: PASS = trusted compile plus successful eth_call (possibly with verified approval overrides).
// INCOMPLETE = insufficient funds, missing approval or unavailable approval override: swap execution unproven.
// FAIL = refused compile, untrusted target/spender, reverted call, missing code.
// Exit: 0 all PASS · 1 any FAIL · 2 usage · 3 BLOCKED (credentials/network) · 4 INCOMPLETE.
// -----------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import {
  ARBITRUM_PHASE1_REVIEWED_ASSETS,
  BASE_PHASE1_REVIEWED_ASSETS,
  NATIVE_TOKEN,
  compileBag,
  createAssetCapabilityRegistry,
  getChainProfile,
  getSdkErrorInfo,
  parseBag,
  screenPurchaseAssets,
  simulateBag,
  type BagDocument,
  type Hex,
  type SimulationClient,
} from '../src/index';
import { inspectToken, type TokenInspectionClient } from '../src/adapters/evm';
import { lifiComposer, resolveLifiComposerAccount, type ComposerAccountClient } from '../src/adapters/lifi';
import { isNetworkBlock } from './live-compile';

const profile = getChainProfile('base')!;
const USDC = profile.settlementStablecoin!.address as Hex;
const WETH = profile.wrappedNative!.address as Hex;
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' as Hex;
const CBETH = '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22' as Hex;
const WSTETH = '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452' as Hex;

export type Phase1Chain = 'base' | 'arbitrum';
const arbitrum = getChainProfile('arbitrum')!;
const ARB_USDC = arbitrum.settlementStablecoin!.address as Hex;
const ARB_WETH = arbitrum.wrappedNative!.address as Hex;
export const ARBITRUM_PHASE1_MATRIX = [
  { name: 'ETH -> USDC', input: NATIVE_TOKEN as Hex, output: ARB_USDC, amountRaw: BigInt(5) * BigInt(10) ** BigInt(14) },
  { name: 'USDC -> WETH', input: ARB_USDC, output: ARB_WETH, amountRaw: BigInt(2_000_000) },
  { name: 'WETH -> USDC', input: ARB_WETH, output: ARB_USDC, amountRaw: BigInt(10) ** BigInt(14) },
] as const;

/** A compile or a preflight answer alone never proves that the swap can execute. */
export function simulationOutcome(status: string): 'PASS' | 'INCOMPLETE' | 'FAIL' {
  if (status === 'OK' || status === 'OK_WITH_ASSUMED_APPROVALS') return 'PASS';
  if (['INSUFFICIENT_BALANCE', 'NEEDS_APPROVAL', 'APPROVAL_OVERRIDE_UNAVAILABLE'].includes(status)) return 'INCOMPLETE';
  return 'FAIL';
}

export const BASE_PHASE1_MATRIX = [
  { name: 'ETH -> USDC', input: NATIVE_TOKEN as Hex, output: USDC, amountRaw: BigInt(5) * BigInt(10) ** BigInt(14) }, // 0.0005 ETH
  { name: 'USDC -> WETH', input: USDC, output: WETH, amountRaw: BigInt(2_000_000) }, // 2 USDC
  { name: 'USDC -> cbBTC', input: USDC, output: CBBTC, amountRaw: BigInt(2_000_000) },
  { name: 'WETH -> USDC', input: WETH, output: USDC, amountRaw: BigInt(10) ** BigInt(14) }, // 0.0001 WETH
  { name: 'USDC -> cbETH', input: USDC, output: CBETH, amountRaw: BigInt(2_000_000) },
  { name: 'USDC -> wstETH', input: USDC, output: WSTETH, amountRaw: BigInt(2_000_000) },
] as const;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

function singleAssetBag(chain: Phase1Chain, asset: Hex, decimals: number): BagDocument {
  const r = parseBag({
    bagJson: 1,
    definition: {
      kind: 'STATIC_BASKET', chain, mutability: 'MUTABLE',
      assets: [{ chain, address: asset, decimals, weightBps: 10000 }],
      rules: {
        weightBounds: { minBps: 100, maxBps: 10000 }, maxAssets: 10, minInvestment: { amount: '0', measuredAs: 'PAYMENT_TOKEN_AMOUNT' },
        swapSlippageBps: 100, rebalance: { frequency: 'MANUAL', driftThresholdBps: 500 }, performanceFeeBps: 0, noRouteAssetPolicy: 'BLOCK',
      },
    },
  });
  if (!r.ok) throw new Error(`bag: ${r.issues.map((i) => i.code).join(',')}`);
  return r.bag;
}

function matrix(chain: Phase1Chain, extra: string | undefined) {
  const usdc = getChainProfile(chain)!.settlementStablecoin!.address as Hex;
  const initial = chain === 'base' ? BASE_PHASE1_MATRIX : ARBITRUM_PHASE1_MATRIX;
  const out: { name: string; input: Hex; output: Hex; amountRaw: bigint; candidate: boolean }[] = initial.map((m) => ({ ...m, candidate: false }));
  for (const a of (extra ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`EXTRA_OUTPUTS: ${a} is not an address`);
    out.push({ name: `USDC -> ${a} (candidate)`, input: usdc, output: a.toLowerCase() as Hex, amountRaw: BigInt(2_000_000), candidate: true });
  }
  return out;
}

const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export async function runPhase1Check(chain: Phase1Chain, signerArg: string | undefined) {
  const profile = getChainProfile(chain)!;
  const signer = signerArg as Hex | undefined;
  if (!signer || !/^0x[0-9a-fA-F]{40}$/.test(signer)) {
    console.error('Usage: RPC_URL=… LIFI_API_KEY=… COMPOSER_FACTORY=0x… COMPOSER_FACTORY_CODE_HASH=0x… npx tsx packages/bag-sdk/examples/evm-phase1-check.ts <base|arbitrum> <signer address>');
    process.exit(2);
  }
  const env = { rpc: process.env.RPC_URL, key: process.env.LIFI_API_KEY, factory: process.env.COMPOSER_FACTORY, hash: process.env.COMPOSER_FACTORY_CODE_HASH };
  const missing = Object.entries({ RPC_URL: env.rpc, LIFI_API_KEY: env.key, COMPOSER_FACTORY: env.factory, COMPOSER_FACTORY_CODE_HASH: env.hash }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.log(`BLOCKED  not set: ${missing.join(', ')}`);
    process.exit(3);
  }
  const client = createPublicClient({ transport: http(env.rpc, { retryCount: 1, timeout: 30_000 }) });
  const any = client as unknown as SimulationClient & TokenInspectionClient & ComposerAccountClient;

  // 1. chain detection
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (e) {
    console.log(`BLOCKED  RPC unreachable (${getSdkErrorInfo(e).code})`);
    process.exit(3);
  }
  console.log(`${chainId === profile.chainId ? 'PASS' : 'FAIL'}  CHAIN  RPC ${chainId}, profile ${profile.chain} ${profile.chainId}; receipts: ${j(profile.receipts)}`);
  if (chainId !== profile.chainId) process.exit(1);

  const registry = createAssetCapabilityRegistry(chain === 'base' ? BASE_PHASE1_REVIEWED_ASSETS : ARBITRUM_PHASE1_REVIEWED_ASSETS);
  const deployment = { chainId, factory: env.factory as Hex, factoryCodeHash: env.hash as Hex };
  let account;
  try {
    account = await resolveLifiComposerAccount({ chainId, signer, deployment, client: any });
  } catch (e) {
    console.log(`FAIL  COMPOSER_ACCOUNT  ${getSdkErrorInfo(e).code}`);
    process.exit(1);
  }
  console.log(`PASS  COMPOSER_ACCOUNT  proxy ${account.proxy} (${account.proxyDeployed ? 'deployed' : 'not deployed: first purchase targets the factory'})`);
  const provider = lifiComposer({ apiKey: env.key!, baseUrl: process.env.COMPOSER_URL ?? 'https://composer.li.quest', deliveryProof: true, account });

  let failures = 0;
  let blocked = 0;
  let incomplete = 0;
  let simulationsPassed = 0;
  const scenarios = matrix(chain, process.env.EXTRA_OUTPUTS);
  for (const s of scenarios) {
    console.log(`\n== ${s.name}  (amount ${s.amountRaw} raw) ==`);
    try {
      // 2–3. recognition (dynamic, by chain id + address) and screening (reviewed class)
      const [inIns, outIns] = await Promise.all([inspectToken({ chainId, address: s.input, client: any }), inspectToken({ chainId, address: s.output, client: any })]);
      console.log(`INFO  TOKENS  in ${j(inIns)} | out ${j(outIns)}`);
      if (outIns.kind !== 'ERC20' || (inIns.kind !== 'ERC20' && inIns.kind !== 'NATIVE')) throw new Error(`token not recognised: ${inIns.kind}/${outIns.kind}`);
      const screen = screenPurchaseAssets({ chainId, inputToken: s.input, outputTokens: [s.output], registry, allowUnreviewed: s.candidate });
      console.log(`${screen.ok ? 'PASS' : 'FAIL'}  SCREEN  ${screen.decisions.map((d) => `${d.role}:${d.assetClass}:${d.decision}`).join(' ')}`);
      if (!screen.ok) throw new Error('screening refused');

      // 4. balance and allowance (to the signer's Composer proxy)
      const balance = s.input === NATIVE_TOKEN
        ? await client.getBalance({ address: signer })
        : ((await client.readContract({ address: s.input, abi: ERC20_ABI, functionName: 'balanceOf', args: [signer] })) as bigint);
      const allowance = s.input === NATIVE_TOKEN ? null : ((await client.readContract({ address: s.input, abi: ERC20_ABI, functionName: 'allowance', args: [signer, account.proxy as Hex] })) as bigint);
      console.log(`INFO  FUNDS  balance ${balance}${allowance === null ? ' (native: no approval)' : `, allowance to proxy ${allowance}`}, needed ${s.amountRaw}`);

      // 5. quote + compile (trust policy derived from the reviewed pin)
      const compiled = await compileBag(
        singleAssetBag(chain, s.output, outIns.decimals),
        { inputToken: s.input, amountRaw: s.amountRaw, signer, inputTokenDecimals: inIns.decimals, tokens: [{ chain, address: s.output, decimals: outIns.decimals }] },
        { provider, trust: account.trust }
      );
      const leg = compiled.quote.legs[0];
      const legOk = !!leg.minOutRaw && !!leg.expectedOutRaw && BigInt(leg.minOutRaw) > BigInt(0) && BigInt(leg.minOutRaw) <= BigInt(leg.expectedOutRaw);
      console.log(`${legOk ? 'PASS' : 'FAIL'}  COMPILE  to ${compiled.transaction.to} value ${compiled.transaction.value}; leg ${leg.token} expected ${leg.expectedOutRaw} min ${leg.minOutRaw}; impact ${compiled.quote.priceImpactBps} bps; approvals ${j(compiled.approvals)}; deliveryProof ${compiled.deliveryProof ? 'on' : 'OFF'}`);

      // 6. simulation (eth_call from the signer; nothing sent)
      const sim = await simulateBag(compiled, { client: any, assumeApprovals: true });
      const outcome = simulationOutcome(sim.status);
      console.log(`${outcome}  SIMULATE${outcome === 'PASS' ? ' (swap executed in eth_call)' : ' (swap NOT verified by eth_call)'}  ${j(sim)}`);
      if (outcome === 'PASS') simulationsPassed++;
      if (outcome === 'INCOMPLETE') incomplete++;
      if (!legOk || outcome === 'FAIL' || !compiled.deliveryProof) failures++;
    } catch (e) {
      if (isNetworkBlock(e)) {
        blocked++;
        console.log(`BLOCKED  ${getSdkErrorInfo(e).code}`);
      } else {
        failures++;
        const info = getSdkErrorInfo(e);
        console.log(`FAIL  ${info.code === 'UNKNOWN_ERROR' ? (e as Error).message.split('\n')[0].replace(/https?:\/\/\S+/g, '<url>') : `${info.code}: ${info.message}`}`);
      }
    }
  }
  const verdict = failures > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : incomplete > 0 ? 'INCOMPLETE' : 'PASS';
  console.log(j({ chain, chainId, verdict, scenarios: scenarios.length, simulationsPassed, incomplete, blocked, failures, evidence: 'LIVE_READ_ONLY', signedOrSubmitted: false }));
  console.log(`\nVERDICT ${verdict}  (${scenarios.length} scenarios; nothing was signed or sent)`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'BLOCKED' ? 3 : verdict === 'INCOMPLETE' ? 4 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runPhase1Check('base', process.argv[2]).catch((e) => {
    console.error(getSdkErrorInfo(e).code);
    process.exit(1);
  });
}
