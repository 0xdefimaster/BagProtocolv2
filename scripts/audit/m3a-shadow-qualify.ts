// M3a staging qualification (read-only): real Composer compiles through the app's legacy adapter, cross-checked by
// the SDK exactly as BAG_SDK_COMPOSER_COMPILE=shadow does (lib/blockchain/composer-sdk-compile.ts), on Robinhood and
// Base, with the reviewed Composer pins (docs/SDK_DEPLOYMENT_PIN_ROBINHOOD.md, docs/SDK_DEPLOYMENT_PIN_BASE.md).
//
//   npx tsx --env-file=.env.local scripts/audit/m3a-shadow-qualify.ts [--out <dir>]
//
// Needs LIFI_API_KEY, ROBINHOOD_RPC_URL, BASE_RPC_URL (or the app's RPC fallbacks) and COMPOSER_TEST_SIGNER (any
// address; only used as the compile's signer, nothing is signed). Compiles are unsigned quotes; nothing is sent.
// Never prints the API key or RPC URLs. Arbitrum is deliberately not included (its pin is not release-approved).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, http, keccak256 } from 'viem';
import { planPartitionLegs } from '@/packages/bag-sdk/src';
import type { ComposerAccountClient } from '@/packages/bag-sdk/src/adapters/lifi';
import { buildComposerPurchase } from '@/lib/blockchain/lifi-composer-adapter';
import { crossCheckWithDeadline, recordingFetch, reviewedComposerDeployment, type SdkCompileCheck } from '@/lib/blockchain/composer-sdk-compile';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { composeErrorOf } from '@/lib/blockchain/lifi-composer-adapter';

const { values } = parseArgs({ options: { out: { type: 'string' } } });

/** The reviewed pins, copied from the approved pin documents (identical factory on both chains, CREATE2). */
const REVIEWED_PINS = {
  COMPOSER_FACTORY_ROBINHOOD: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae',
  COMPOSER_FACTORY_CODE_HASH_ROBINHOOD: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5',
  COMPOSER_FACTORY_BASE: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae',
  COMPOSER_FACTORY_CODE_HASH_BASE: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5',
};
const VM = '0xa9f22b951d5a9cbbd0ec8d2741ea44bfdd2d11fd';
const NATIVE = '0x0000000000000000000000000000000000000000';

type Chain = 'robinhood' | 'base';
const CHAIN_IDS: Record<Chain, number> = { robinhood: 4663, base: 8453 };
interface Case { name: string; chain: Chain; input: string; amountRaw: bigint; outputs: string[] }
const CASES: Case[] = [
  // USDG → two Robinhood tokens observed in the fork evidence.
  { name: 'robinhood-usdg-2-legs', chain: 'robinhood', input: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', amountRaw: BigInt(2_000_000), outputs: ['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x322f0929c4625ed5bad873c95208d54e1c003b2d'] },
  { name: 'robinhood-native-eth-2-legs', chain: 'robinhood', input: NATIVE, amountRaw: BigInt(500_000_000_000_000), outputs: ['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'] },
  // USDC → WETH + cbBTC (the Base phase-1 reviewed assets).
  { name: 'base-usdc-2-legs', chain: 'base', input: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amountRaw: BigInt(2_000_000), outputs: ['0x4200000000000000000000000000000000000006', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'] },
  { name: 'base-usdc-3-legs', chain: 'base', input: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amountRaw: BigInt(3_000_000), outputs: ['0x4200000000000000000000000000000000000006', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22'] },
  { name: 'base-native-eth-2-legs', chain: 'base', input: NATIVE, amountRaw: BigInt(500_000_000_000_000), outputs: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'] },
];

const apiKey = process.env.LIFI_API_KEY ?? '';
const signer = (process.env.COMPOSER_TEST_SIGNER ?? '').toLowerCase();
if (!apiKey || !/^0x[0-9a-f]{40}$/.test(signer)) {
  console.error('LIFI_API_KEY and COMPOSER_TEST_SIGNER are required.');
  process.exit(2);
}
const scrub = (s: string) => s.replaceAll(apiKey, '<key>').replace(/https?:\/\/[^\s"')]+/g, '<url>');
const client = (chain: Chain) => getChainPublicClient(chain) as unknown as ComposerAccountClient;

async function pinCheck(chain: Chain) {
  const c = getChainPublicClient(chain);
  const chainId = await c.getChainId();
  const deployment = reviewedComposerDeployment(chain, CHAIN_IDS[chain], REVIEWED_PINS);
  const block = await c.getBlockNumber();
  const factoryCode = await c.getCode({ address: deployment!.factory, blockNumber: block });
  const vmCode = await c.getCode({ address: VM, blockNumber: block });
  const factoryHash = factoryCode ? keccak256(factoryCode) : null;
  return {
    chain, chainId, block: block.toString(), factory: deployment!.factory, pinnedCodeHash: deployment!.factoryCodeHash, liveCodeHash: factoryHash,
    factoryMatchesPin: factoryHash === deployment!.factoryCodeHash, factoryEmbedsVm: !!factoryCode && factoryCode.toLowerCase().includes(VM.slice(2)),
    vmCodeHash: vmCode ? keccak256(vmCode) : null,
  };
}

async function runCase(k: Case) {
  let composerCalls = 0;
  const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
    composerCalls++;
    return fetch(input, init);
  }) as typeof fetch;
  const rec = recordingFetch(counted);
  const partitioned = planPartitionLegs(k.outputs.map((t) => ({ token: t, amountRaw: k.amountRaw / BigInt(k.outputs.length) })));
  const swapAmountRaw = partitioned.totalRaw;
  const nativeInput = k.input === NATIVE;
  const startedAt = Date.now();
  let legacy;
  try {
    legacy = await buildComposerPurchase({
      chain: k.chain, inputTokenAddress: k.input, inputAmountRaw: swapAmountRaw.toString(),
      legs: partitioned.legs.map((l, i) => ({ address: l.token, weightBps: l.legBps, symbol: `L${i}` })),
      signerAddress: signer, slippageBps: 100, apiKey, fetchImpl: rec.fetch,
    });
  } catch (err) {
    return { case: k.name, chain: k.chain, legacy: 'COMPOSER_REFUSED', composerKind: composeErrorOf(err)?.kind ?? null, message: scrub(err instanceof Error ? err.message : String(err)).slice(0, 300), composerCalls };
  }
  const input = {
    chain: k.chain, chainId: CHAIN_IDS[k.chain], inputKind: nativeInput ? 'native' as const : 'erc20' as const, inputToken: k.input, signer, swapAmountRaw,
    legs: partitioned.legs.map((l) => ({ token: l.token, legBps: l.legBps, targetInputRaw: l.amountRaw })), slippageBps: 100, apiKey, legacy, exchanges: rec.exchanges,
  };
  const check: SdkCompileCheck = await crossCheckWithDeadline(input, { env: REVIEWED_PINS, client: client(k.chain) });
  const callsAfterCheck = composerCalls;
  // Negative controls on the same recording (still no Composer call): a wrong pin, a tampered legacy calldata.
  const wrongPin = await crossCheckWithDeadline(input, { env: { ...REVIEWED_PINS, [`COMPOSER_FACTORY_CODE_HASH_${k.chain.toUpperCase()}`]: `0x${'ab'.repeat(32)}` }, client: client(k.chain) });
  const tampered = await crossCheckWithDeadline({ ...input, legacy: { ...legacy, transactionRequest: { ...legacy.transactionRequest, data: `${legacy.transactionRequest.data.slice(0, -2)}${legacy.transactionRequest.data.endsWith('00') ? '01' : '00'}` } } }, { env: REVIEWED_PINS, client: client(k.chain) });
  return {
    case: k.name, chain: k.chain, inputKind: input.inputKind, legs: partitioned.legs.map((l) => ({ token: l.token, legBps: l.legBps })),
    legacy: {
      to: legacy.transactionRequest.to, dataKeccak: keccak256(legacy.transactionRequest.data as `0x${string}`), dataBytes: (legacy.transactionRequest.data.length - 2) / 2,
      value: legacy.transactionRequest.value, userProxy: legacy.userProxy, approvals: legacy.approvals,
      priceImpactBps: legacy.priceImpact?.impactBps ?? null,
    },
    verdict: check, composerCallsTotal: composerCalls, composerCallsByCrossCheck: callsAfterCheck - 1, elapsedMs: Date.now() - startedAt,
    negativeControls: { wrongPin, tamperedCalldata: tampered },
  };
}

async function failureBehaviour() {
  // A dead RPC and a hanging RPC, against a recorded MATCHing case shape (no Composer call needed: NOT_RECORDED is
  // avoided by giving one synthetic exchange; the account resolution fails first).
  const dead = createPublicClient({ transport: http('http://127.0.0.1:9', { timeout: 2000, retryCount: 0 }) }) as unknown as ComposerAccountClient;
  const hanging = { ...(dead as object), getChainId: () => new Promise<number>(() => {}) } as unknown as ComposerAccountClient;
  const stub = {
    chain: 'base' as const, chainId: 8453, inputKind: 'erc20' as const, inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', signer, swapAmountRaw: BigInt(1),
    legs: [{ token: '0x4200000000000000000000000000000000000006', legBps: 10_000, targetInputRaw: BigInt(1) }], slippageBps: 100, apiKey,
    legacy: { transactionRequest: { to: NATIVE, data: '0x', value: '0' }, userProxy: NATIVE, approvals: [], outputs: {}, gasLimitRaw: null, priceImpact: null, fees: [] },
    exchanges: [{ url: 'x', method: 'POST', body: null, status: 200, statusText: '', headers: [] as [string, string][], responseText: '{}' }],
  };
  const t0 = Date.now();
  const deadRpc = await crossCheckWithDeadline(stub, { env: REVIEWED_PINS, client: dead });
  const t1 = Date.now();
  const hangingRpc = await crossCheckWithDeadline(stub, { env: REVIEWED_PINS, client: hanging }, 3000);
  return { deadRpc, deadRpcMs: t1 - t0, hangingRpc, hangingRpcMs: Date.now() - t1 };
}

const report = {
  recordedAt: new Date().toISOString(),
  role: 'MAINTAINER_READ_ONLY_UNSIGNED',
  signer,
  pins: [] as unknown[],
  cases: [] as unknown[],
  failureBehaviour: null as unknown,
};
for (const chain of ['robinhood', 'base'] as const) {
  try { report.pins.push(await pinCheck(chain)); } catch (e) { report.pins.push({ chain, error: scrub(String(e)).slice(0, 200) }); }
}
for (const k of CASES) {
  try { report.cases.push(await runCase(k)); } catch (e) { report.cases.push({ case: k.name, error: scrub(e instanceof Error ? e.message : String(e)).slice(0, 300) }); }
}
report.failureBehaviour = await failureBehaviour();

const text = JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
if (values.out) {
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `m3a-shadow-qualify-${report.recordedAt.slice(0, 10)}.json`), text);
}
console.log(scrub(text));
