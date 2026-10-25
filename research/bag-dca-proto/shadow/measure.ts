// RESEARCH PROTOTYPE: read-only shadow measurement of execution sources for one BAG purchase.
// Nothing is sent to a public network: every swap is a transaction on an isolated fork behind the
// read-only relay (lib/fork-env.mjs); API sources only return calldata, which is executed on the fork.
//
// Output is measured, never simulated: each candidate's realized amount comes from the fork receipt
// and the taker's balance deltas, cross-checked with the receipt's Transfer logs. Evidence stages:
//   QUOTED            an API/quoter number only
//   SIMULATED         eth_call result
//   FORK_EXECUTED     a mined fork transaction, balances read, but some check did not hold
//   RECEIPT_VERIFIED  receipt success; debit == amountIn; credit > 0; Transfer logs equal both deltas;
//                     no transit balance left on target/spender; allowance back to 0
//
// Block modes: `single` (one pinned fork block for every leg, source, amount and the basket; needs an
// archive RPC because the run outlives a pruning node's state window) or `per-unit` (fallback for a
// non-archive RPC: one fresh fork per leg and per basket; cross-leg numbers are NOT same-block and
// the report says so). `auto` picks single when the RPC serves old state.
//
// Run from the app checkout (its `@/` imports and solc 0.8.24 resolve there), with the pinned tsx:
//   node <proto>/node_modules/tsx/dist/cli.mjs <proto>/shadow/measure.ts --app . --bag <bag.json> \
//     --amounts 5,100 [--sources uniswap-v3,uniswap-v4,composer] [--block-mode auto|single|per-unit]
//     [--block <n>] [--env-file .env.local] [--sdk <built packages/bag-sdk>] [--out <dir>]
// Kyber and 0x can be added to --sources for comparison only: their spender is not independently
// verified, so they are never router picks (EXCLUDED_UNVERIFIED).
//
// Exit codes: 0 complete; 1 fatal; 2 usage (unknown source, ARCHIVE_REQUIRED, missing args);
// 3 incomplete (some result is RPC_ERROR / PRUNED_STATE / API_ERROR); 4 a basket did not execute.
// The report is written in every case (finally), and the relay and fork are closed.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-ignore research JS modules
import { v, accounts, startRelay, createFork, compileProto, reasonOf, json, PUBLIC_RPC } from '../lib/fork-env.mjs';
// @ts-ignore
import { priceGate, basketGate, PRICE_POLICY } from '../lib/price-gate.mjs';
// @ts-ignore
import { routerDcaReadiness } from '../lib/router-dca-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const usage = (m: string) => { console.error('USAGE: ' + m); process.exit(2); };
const KNOWN_SOURCES = ['uniswap-v3', 'uniswap-v4', 'kyberswap', '0x', 'composer'];
const UNVERIFIED_SOURCES = new Set(['kyberswap', '0x']);
const SOURCES = (arg('--sources', 'uniswap-v3,uniswap-v4,composer')!).split(',').map(s => s.trim()).filter(Boolean);
const unknown = SOURCES.filter(s => !KNOWN_SOURCES.includes(s));
if (unknown.length) usage(`unknown source(s): ${unknown.join(', ')}; known: ${KNOWN_SOURCES.join(', ')}`);
if (!arg('--bag')) usage('--bag <bag.json> is required');
const BLOCK_MODE = arg('--block-mode', 'auto')!;
if (!['auto', 'single', 'per-unit'].includes(BLOCK_MODE)) usage('--block-mode auto|single|per-unit');
const app = resolve(arg('--app', '.')!);
const out = resolve(arg('--out', join(here, 'out', 'shadow-' + new Date().toISOString().replaceAll(':', '-')))!);
if (existsSync(out)) usage('use a new --out directory');
mkdirSync(join(out, 'traces'), { recursive: true });
const AMOUNTS = (arg('--amounts', '5,100')!).split(',').map(s => s.trim());
const env: Record<string, string> = {};
if (arg('--env-file')) for (const line of readFileSync(resolve(arg('--env-file')!), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && ['ROBINHOOD_RPC_URL', 'LIFI_API_KEY', 'ZEROX_API_KEY', 'KYBER_CLIENT_ID'].includes(m[1])) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const RPC = env.ROBINHOOD_RPC_URL || PUBLIC_RPC;
const redact = (x: unknown) => String(x).replace(/https?:\/\/[^\s"'<>]+/g, '<url>').replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 400);

const errText = (e: any) => [reasonOf(e), e?.message].filter(Boolean).join(' | ');
const report: any = { schema: 'bag-shadow-measure/v2', scope: 'SHADOW_MEASUREMENT_READ_ONLY_FORK', startedAt: new Date().toISOString(), args: args.filter(a => !/[A-Za-z0-9_-]{32,}/.test(a)) };
let relay: any, F: any;
try {
const appRequire = createRequire(join(app, 'package.json'));
const solc24 = appRequire('solc');

// ---- Policy (recorded in the report) -------------------------------------------------------
const POLICY = { probeDivisor: 100n, v3FeeTiers: [100, 500, 3000, 10000], sdkMaxSlippageBps: 300, v4ExecutePerLeg: 3, v4UnrankedCap: 6, v4EventLookbackBlocks: 2_000_000n };
const USDG = v.getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const USDG_HOLDER = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';   // lib/config/robinhood-chain.ts (VERIFIED)
const V3_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const V3_ROUTER02 = '0xCaf681a66D020601342297493863E78C959E5cb2';
const UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const PRUNED = /historical state|missing trie node|state.{0,20}not available|header not found|state histories/i;
const TRANSPORT = /upstream|fetch failed|timeout|ECONN|429|rate.?limit|socket|503|502|Missing or invalid parameters|InvalidInputRpcError/i;

// ---- BAG → BagExecutionGraph with the app's own code ----------------------------------------
const bagFile = JSON.parse(readFileSync(resolve(arg('--bag')!), 'utf8'));
const bag = bagFile.bagJson ? bagFile : bagFile.bag;
if (bag?.bagJson !== 1) usage('--bag must be a bag.json document (or a fixture with .bag)');
const { calculateDepositAllocation } = await import(pathToFileURL(join(app, 'lib/domain/basket-protocol/deposit/allocation.ts')).href);
const { buildExecutionPlan } = await import(pathToFileURL(join(app, 'lib/domain/basket-protocol/deposit/execution-plan.ts')).href);
const { buildBagExecutionGraph, assertValidExecutionGraph, computeBagExecutionGraphHash } = await import(pathToFileURL(join(app, 'lib/execution/plan.ts')).href);
const symbolOf = (a: string) => bag.metadata?.assets?.find((m: any) => m.address.toLowerCase() === a.toLowerCase())?.symbol ?? a.slice(0, 8);
const recipe = { id: bag.ref?.strategyId ?? 'shadow', bagId: bag.ref?.strategyId ?? 'shadow', name: bag.metadata?.name ?? '', symbol: bag.metadata?.symbol ?? '', description: '',
  chain: 'robinhood', strategyType: 'STATIC_BASKET', rebalanceRule: { frequency: 'MANUAL' }, minInvestment: 0, maxAssets: 10, minWeightBps: 0, maxWeightBps: 10000,
  mutability: bag.definition.mutability ?? 'MUTABLE', version: bag.ref?.version ?? 1, createdAt: '',
  assets: bag.definition.assets.map((a: any) => ({ chain: a.chain, address: a.address, symbol: symbolOf(a.address), decimals: a.decimals, weightBps: a.weightBps })) };
const slippageBps = Math.min(bag.definition.rules?.swapSlippageBps ?? 100, POLICY.sdkMaxSlippageBps);

// ---- Compile: research adapters (0.8.23) and the app's existing BagExecutionRouter (0.8.24) ---
const { art } = compileProto(['shadow/contracts/ShadowAdapters.sol', 'composer/contracts/LocalArbSysRead.sol']);
function compile24(sources: Record<string, string>, find: (p: string) => { contents?: string; error?: string }) {
  const o = JSON.parse(solc24.compile(JSON.stringify({ language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).map(([k, c]) => [k, { content: c }])),
    settings: { optimizer: { enabled: false }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), { import: find }));
  const errs = (o.errors ?? []).filter((e: any) => e.severity === 'error'); if (errs.length) throw new Error(errs.map((e: any) => e.formattedMessage).join('\n'));
  const c = o.contracts['contracts/BagExecutionRouter.sol'].BagExecutionRouter; return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}
const routerSource = readFileSync(join(app, 'contracts/BagExecutionRouter.sol'), 'utf8');
const routerArt = compile24({ 'contracts/BagExecutionRouter.sol': routerSource }, p => { try { return { contents: readFileSync(join(app, 'node_modules', p), 'utf8') }; } catch { return { error: 'not found: ' + p }; } });

// ---- Relay, archive detection, block mode ---------------------------------------------------
relay = await startRelay(RPC);
const remote = v.createPublicClient({ chain: v.defineChain({ id: 4663, name: 'relay', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [relay.url] } } }), transport: v.http(relay.url) });
const latest = await remote.getBlock();
async function archiveProbe() {
  const old = latest.number > 500_000n ? latest.number - 500_000n : 1n;
  try { await remote.getBalance({ address: USDG_HOLDER, blockNumber: old }); await remote.getStorageAt({ address: USDG, slot: '0x0', blockNumber: old }); return { archive: true, probedBlock: old }; }
  catch (e: any) { return { archive: false, probedBlock: old, reason: PRUNED.test(reasonOf(e) + e?.message) ? 'PRUNED_STATE' : 'ERROR: ' + redact(e?.shortMessage ?? e?.message) }; }
}
const archive = await archiveProbe();
let mode = BLOCK_MODE === 'auto' ? (archive.archive ? 'single' : 'per-unit') : BLOCK_MODE;
if (mode === 'single' && !archive.archive) { report.exit = { code: 2, status: 'ARCHIVE_REQUIRED', detail: `single-block mode needs an RPC that serves old state (probe at block ${archive.probedBlock}: ${archive.reason})` }; throw new Error(report.exit.detail); }
if (arg('--block') && mode !== 'single') usage('--block needs --block-mode single (archive RPC)');
const blockMode = mode === 'single'
  ? { mode, archive, label: 'SINGLE_BLOCK', note: 'every leg, source, amount and the basket at one pinned block (snapshots between candidates)' }
  : { mode, archive, label: 'NON_ARCHIVE_PER_UNIT', note: 'non-archive RPC: one fresh fork per leg and per basket. Sources and amounts for one leg share a block; different legs and the basket do NOT. Cross-leg sums are not same-block evidence.' };

// ---- Fork state ------------------------------------------------------------------------------
const taker = accounts.privateKeyToAccount(accounts.generatePrivateKey()), keeper = accounts.privateKeyToAccount(accounts.generatePrivateKey()), planSigner = accounts.privateKeyToAccount(accounts.generatePrivateKey());
const erc20 = v.parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const maxAmount = AMOUNTS.reduce((m, a) => (v.parseUnits(a, 6) > m ? v.parseUnits(a, 6) : m), 0n);
const pm = await remote.readContract({ address: UNIVERSAL_ROUTER, abi: v.parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' }) as string;
const forks: any[] = [];
let W: any, router = '', v4adapter = '';
const client = () => F.client;
const rpc = (method: string, params: unknown[] = []) => F.rpc(method, params);
const bal = (t: string, a: string) => client().readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
async function send(who: string, to: string, abi: any, functionName: string, a: unknown[] = [], value = 0n) {
  const hash = await W[who].writeContract({ address: to, abi, functionName, args: a, value, gas: 15_000_000n });
  const r = await client().waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(functionName + ' failed'); return r;
}
const deploy = async (a: { abi: any; bytecode: string }, ctor: unknown[] = []) =>
  (await client().waitForTransactionReceipt({ hash: await W.keeper.deployContract({ abi: a.abi, bytecode: a.bytecode, args: ctor, gas: 25_000_000n }) })).contractAddress as string;
async function openFork(label: string) {
  if (F) { forks.at(-1).localTransactions = F.localTx.sent; forks.at(-1).changes = F.changes; await F.close(); }
  F = await createFork({ relayUrl: relay.url, out, blockNumber: mode === 'single' && arg('--block') ? BigInt(arg('--block')!) : undefined, label });
  W = { taker: F.wallet(taker), keeper: F.wallet(keeper) };
  await F.edit('ARBSYS', 'hardhat_setCode', ['0x0000000000000000000000000000000000000064', art('LocalArbSysRead').runtime], 'ArbSys read emulation (Arbitrum precompile is not in EDR)'); await rpc('evm_mine');
  for (const a of [taker, keeper]) await F.edit('GAS', 'hardhat_setBalance', [a.address, v.toHex(v.parseEther('10'))], 'fork-only gas for local test accounts');
  await F.edit('IMPERSONATE', 'hardhat_impersonateAccount', [USDG_HOLDER], 'USDG for the taker from a real holder balance (fork only)');
  await F.edit('GAS', 'hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))], 'gas for the impersonated holder');
  await client().waitForTransactionReceipt({ hash: await F.wallet(USDG_HOLDER).writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [taker.address, maxAmount * 4n], gas: 500000n }) });
  await F.edit('IMPERSONATE', 'hardhat_stopImpersonatingAccount', [USDG_HOLDER], '');
  const shadowFactory = await deploy(art('ShadowBagFactory'));
  router = await deploy(routerArt, [shadowFactory, keeper.address, planSigner.address]);
  v4adapter = await deploy(art('ShadowV4Adapter'), [pm]);
  forks.push({ label, blockNumber: F.block.number, blockHash: F.block.hash, timestamp: F.block.timestamp, mock: { ShadowBagFactory: shadowFactory + ' (MOCK: says every bagId exists; not registry evidence)' } });
  return F.block.number as bigint;
}

// ---- Errors, traces, receipt-verified execution ----------------------------------------------
const rawRevert = (e: any) => errText(e).match(/return data: (0x[0-9a-fA-F]+)/)?.[1] ?? e?.cause?.data?.data ?? (typeof e?.data === 'string' ? e.data : undefined);
function classify(e: any): { status: string; reason: string } {
  const t = errText(e);
  if (PRUNED.test(t)) return { status: 'PRUNED_STATE', reason: redact(t) };
  if (TRANSPORT.test(t)) return { status: 'RPC_ERROR', reason: redact(t) };
  const raw = rawRevert(e);
  if (raw) try { const d = v.decodeErrorResult({ abi: art('ShadowV4Adapter').abi, data: raw }); return { status: d.errorName === 'PartialFill' ? 'PARTIAL_FILL' : 'REVERTED', reason: `${d.errorName}(${(d.args ?? []).map(String).join(', ')})` }; } catch {}
  return { status: 'REVERTED', reason: redact(t) };
}
async function revertSite(tx: any) {
  try {
    const t = await rpc('debug_traceCall', [{ from: taker.address, to: tx.to, data: tx.data, value: v.toHex(tx.value ?? 0n), gas: v.toHex(15_000_000n) }, 'latest', { tracer: 'callTracer' }]);
    const deep = (f: any): any => { for (const k of f?.calls ?? []) { const x = deep(k); if (x) return x; } return f?.error ? { to: f.to, selector: f.input?.slice(0, 10), error: f.error, output: f.output?.slice(0, 138) } : null; };
    return deep(t);
  } catch (e: any) { return { traceError: redact(e?.message ?? e).slice(0, 160) }; }
}
type Exec = { stage: string; status: string; reason?: string; txHash?: string; blockNumber?: bigint; gasUsed?: bigint; outRaw?: bigint; spentRaw?: bigint; issues?: string[]; [k: string]: any };
let execSeq = 0;
/** Approve exactly `amountIn`, send, read the receipt and every balance, then revert the fork. */
async function forkSwap(label: string, p: { tx: { to: string; data: string; value?: bigint }; spender: string; tokenOut: string; amountIn: bigint; transit: string[] }): Promise<Exec> {
  const id = `${String(++execSeq).padStart(3, '0')}-${label.replace(/[^A-Za-z0-9.-]+/g, '_')}`;
  const snap = await rpc('evm_snapshot');
  try {
    await send('taker', USDG, erc20, 'approve', [p.spender, p.amountIn]);
    const who = [taker.address, ...p.transit], toks = [USDG, p.tokenOut];
    const read = async (): Promise<Record<string, bigint>> => Object.fromEntries(await Promise.all(who.flatMap(a => toks.map(async t => [`${a.toLowerCase()}:${t.toLowerCase()}`, await bal(t, a)] as const))));
    const before = await read();
    let hash: string;
    try { hash = await W.taker.sendTransaction({ to: p.tx.to, data: p.tx.data, value: p.tx.value ?? 0n, gas: 15_000_000n }); }
    catch (e) { const c = classify(e); const site = c.status === 'RPC_ERROR' || c.status === 'PRUNED_STATE' ? undefined : await revertSite(p.tx); return { stage: 'NONE', ...c, revertSite: site, trace: id }; }
    const r = await client().waitForTransactionReceipt({ hash });
    try { writeFileSync(join(out, 'traces', id + '-trace.json'), json(await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }]))); } catch {}
    const after = await read(), k = (a: string, t: string) => `${a.toLowerCase()}:${t.toLowerCase()}`;
    const spent = before[k(taker.address, USDG)] - after[k(taker.address, USDG)], got = after[k(taker.address, p.tokenOut)] - before[k(taker.address, p.tokenOut)];
    const transfers = v.parseEventLogs({ abi: erc20, logs: r.logs, eventName: 'Transfer' }) as any[];
    const net = (t: string, a: string): bigint => transfers.filter(x => x.address.toLowerCase() === t.toLowerCase()).reduce((s: bigint, x) => s + (x.args.to.toLowerCase() === a.toLowerCase() ? (x.args.value as bigint) : 0n) - (x.args.from.toLowerCase() === a.toLowerCase() ? (x.args.value as bigint) : 0n), 0n);
    const transit = p.transit.map(a => ({ address: a, usdgDelta: after[k(a, USDG)] - before[k(a, USDG)], tokenDelta: after[k(a, p.tokenOut)] - before[k(a, p.tokenOut)] }));
    const allowanceAfter = await client().readContract({ address: USDG, abi: erc20, functionName: 'allowance', args: [taker.address, p.spender] }) as bigint;
    const issues: string[] = [];
    if (r.status !== 'success') issues.push('receipt status ' + r.status);
    if (spent !== p.amountIn) issues.push(`debit ${spent} != amountIn ${p.amountIn}`);
    if (got <= 0n) issues.push('no output reached the taker');
    if (-net(USDG, taker.address) !== spent) issues.push('USDG Transfer logs differ from the debit');
    if (net(p.tokenOut, taker.address) !== got) issues.push('output Transfer logs differ from the credit');
    for (const x of transit) if (x.usdgDelta !== 0n || x.tokenDelta !== 0n) issues.push(`transit balance left on ${x.address}`);
    if (allowanceAfter !== 0n) issues.push(`allowance to ${p.spender} left at ${allowanceAfter}`);
    return { stage: issues.length ? 'FORK_EXECUTED' : 'RECEIPT_VERIFIED', status: issues.length ? 'UNVERIFIED_EXECUTION' : 'OK', issues, txHash: hash, blockNumber: r.blockNumber, gasUsed: r.gasUsed,
      outRaw: got, spentRaw: spent, debits: { USDG: spent }, credits: { [p.tokenOut]: got }, transferLogs: transfers.length, transit, allowanceAfter, trace: id };
  } catch (e) { const c = classify(e); return { stage: 'NONE', ...c }; }
  finally { await rpc('evm_revert', [snap]); }
}
const impactOf = (amount: bigint, out: bigint, probeIn: bigint, probeOut?: bigint) => (probeOut && probeOut > 0n ? Number(10000n - (out * probeIn * 10000n) / (probeOut * amount)) : undefined);
type Cand = { source: string; status: string; stage: string; reason?: string; outRaw?: bigint; quotedOutRaw?: bigint; quoteStage?: string; impactBps?: number; route?: any; target?: string; spender?: string;
  eligibility: string; exec?: Exec; probe?: Exec; routerLeg?: (amountIn: bigint, recipient?: string) => any; vsBestBps?: number; gate?: any; [k: string]: any };
function fromExec(base: Partial<Cand>, full: Exec, probe: Exec | undefined, amount: bigint, probeIn: bigint): Cand {
  const c: any = { ...base, status: full.status, stage: full.stage, reason: full.reason ?? (full.issues?.length ? full.issues.join('; ') : undefined), outRaw: full.outRaw, exec: full, probe };
  if (full.stage === 'RECEIPT_VERIFIED' && probe?.stage === 'RECEIPT_VERIFIED') c.impactBps = impactOf(amount, full.outRaw!, probeIn, probe.outRaw);
  return c;
}

// ---- Source: Uniswap v3 (every fee tier executed through SwapRouter02 on the fork) ------------
const quoterAbi = v.parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']);
const factoryAbi = v.parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = v.parseAbi(['function liquidity() view returns (uint128)']);
const router02Abi = v.parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)']);
const v3Call = (token: string, fee: number, recipient: string, amountIn: bigint) => v.encodeFunctionData({ abi: router02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: USDG, tokenOut: token, fee, recipient, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
async function sourceV3(token: string, amount: bigint, probeIn: bigint, tag: string): Promise<Cand[]> {
  const res: Cand[] = [];
  for (const fee of POLICY.v3FeeTiers) {
    const base: any = { source: 'uniswap-v3', route: { fee }, target: V3_ROUTER02, spender: V3_ROUTER02, eligibility: 'ELIGIBLE' };
    try {
      const pool = await client().readContract({ address: V3_FACTORY, abi: factoryAbi, functionName: 'getPool', args: [USDG, token, fee] });
      if (pool === v.zeroAddress) { res.push({ ...base, status: 'NO_POOL', stage: 'NONE' }); continue; }
      base.route.pool = pool;
      const liq = await client().readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }) as bigint;
      base.route.inRangeLiquidity = liq;
      if (liq === 0n) { res.push({ ...base, status: 'NO_LIQUIDITY', stage: 'NONE', reason: 'pool has no in-range liquidity at the measurement block' }); continue; }
      try { const { result } = await client().simulateContract({ address: V3_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDG, tokenOut: token, amountIn: amount, fee, sqrtPriceLimitX96: 0n }] }); base.quotedOutRaw = result[0]; base.quoteStage = 'SIMULATED'; } catch { base.quoteStage = 'QUOTER_REVERTED'; }
      const full = await forkSwap(`${tag}-v3-${fee}`, { tx: { to: V3_ROUTER02, data: v3Call(token, fee, taker.address, amount) }, spender: V3_ROUTER02, tokenOut: token, amountIn: amount, transit: [V3_ROUTER02] });
      const probe = full.stage === 'RECEIPT_VERIFIED' ? await forkSwap(`${tag}-v3-${fee}-probe`, { tx: { to: V3_ROUTER02, data: v3Call(token, fee, taker.address, probeIn) }, spender: V3_ROUTER02, tokenOut: token, amountIn: probeIn, transit: [V3_ROUTER02] }) : undefined;
      const c = fromExec(base, full, probe, amount, probeIn);
      c.routerLeg = (amountIn: bigint, recipient = router) => ({ target: V3_ROUTER02, value: 0n, approveToken: USDG, approveAmount: amountIn, callData: v3Call(token, fee, recipient, amountIn) });
      res.push(c);
    } catch (e) { res.push({ ...base, ...classify(e), stage: 'NONE' }); }
  }
  return res;
}

// ---- Source: Uniswap v4 (pools from Initialize logs up to the measurement block) --------------
const initEvent = v.parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const swapEvent = v.parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
const modifyEvent = v.parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)');
const adapterAbi = v.parseAbi(['function swapExactIn((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint256 amountIn,uint256 minOut) returns (uint256 out,uint256 spent)']);
const extsloadAbi = v.parseAbi(['function extsload(bytes32[]) view returns (bytes32[])']);
const initLogs = new Map<string, { toBlock: bigint; logs: any[] }>();
async function getLogsChunked(params: any, from: bigint, to: bigint) {
  const logs: any[] = [];
  for (let a = from; a <= to; a += 10_000_000n) logs.push(...await remote.getLogs({ ...params, fromBlock: a, toBlock: a + 9_999_999n > to ? to : a + 9_999_999n }));
  return logs;
}
// PoolManager storage: _pools mapping at slot 6; Pool.State = { slot0, feeGrowthGlobal0, feeGrowthGlobal1, liquidity, ... }.
// slot0 packs sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24). The layout is validated, not assumed.
const poolSlot = (id: string, off: bigint) => v.toHex(BigInt(v.keccak256(v.encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]))) + off, { size: 32 });
const int24 = (x: bigint) => Number(x >= 1n << 23n ? x - (1n << 24n) : x);
async function v4Scan(token: string) {
  const block = F.block.number as bigint;
  const [c0, c1] = BigInt(USDG) < BigInt(token) ? [USDG, v.getAddress(token)] : [v.getAddress(token), USDG];
  const key = c0 + c1, cached = initLogs.get(key);
  const fresh = await getLogsChunked({ address: pm, event: initEvent, args: { currency0: c0, currency1: c1 } }, cached ? cached.toBlock + 1n : 0n, block);
  const logs = [...(cached?.logs ?? []), ...fresh].filter(l => l.blockNumber <= block); initLogs.set(key, { toBlock: block, logs });
  const pools: any[] = logs.map(l => ({ id: l.args.id, key: { currency0: c0, currency1: c1, fee: l.args.fee, tickSpacing: l.args.tickSpacing, hooks: l.args.hooks } }));
  if (!pools.length) return { pools, layout: { verified: true, checks: [] } };
  // read at the measurement block, through the fork itself
  const words = await client().readContract({ address: pm, abi: extsloadAbi, functionName: 'extsload', args: [pools.flatMap(p => [poolSlot(p.id, 0n), poolSlot(p.id, 3n)])] }) as string[];
  const checks: any[] = [];
  pools.forEach((p, i) => {
    const w = BigInt(words[2 * i]); p.liquidity = BigInt(words[2 * i + 1]) & ((1n << 128n) - 1n);
    p.sqrtPriceX96 = w & ((1n << 160n) - 1n); p.tick = int24((w >> 160n) & 0xffffffn); p.lpFee = Number((w >> 208n) & 0xffffffn);
    const expTick = p.sqrtPriceX96 > 0n ? Math.floor((2 * Math.log(Number(p.sqrtPriceX96) / 2 ** 96)) / Math.log(1.0001)) : null;
    const dynamic = (Number(p.key.fee) & 0x800000) !== 0;
    checks.push({ poolId: p.id, initialized: p.sqrtPriceX96 > 0n, tickMatchesPrice: expTick !== null && Math.abs(expTick - p.tick) <= 1, lpFeeMatchesKey: dynamic ? null : p.lpFee === Number(p.key.fee) });
  });
  const baseOk = checks.every(c => c.initialized && c.tickMatchesPrice && c.lpFeeMatchesKey !== false);
  // Liquidity offset: where a pool's latest state-changing event is a Swap, the stored values must equal what that Swap emitted.
  const swapChecks: any[] = [];
  for (const p of [...pools].sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1)).slice(0, POLICY.v4ExecutePerLeg + 2)) {
    try {
      const from = block > POLICY.v4EventLookbackBlocks ? block - POLICY.v4EventLookbackBlocks : 0n;
      const ev = [...await getLogsChunked({ address: pm, event: swapEvent, args: { id: p.id } }, from, block), ...await getLogsChunked({ address: pm, event: modifyEvent, args: { id: p.id } }, from, block)]
        .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      const last = ev.at(-1);
      if (!last || last.eventName !== 'Swap') { swapChecks.push({ poolId: p.id, compared: false, lastEvent: last?.eventName ?? null }); continue; }
      swapChecks.push({ poolId: p.id, compared: true, block: last.blockNumber, liquidityMatches: last.args.liquidity === p.liquidity, sqrtPriceMatches: last.args.sqrtPriceX96 === p.sqrtPriceX96, tickMatches: last.args.tick === p.tick });
    } catch (e) { swapChecks.push({ poolId: p.id, compared: false, error: classify(e).status }); }
  }
  const compared = swapChecks.filter(c => c.compared), swapMismatch = compared.some(c => !c.liquidityMatches || !c.sqrtPriceMatches || !c.tickMatches);
  return { pools, layout: { verified: baseOk && !swapMismatch, baseSlotVerified: baseOk, liquidityOffsetVerified: compared.length ? !swapMismatch : null, checks, swapChecks } };
}
async function sourceV4(token: string, amount: bigint, probeIn: bigint, tag: string, scan: any): Promise<Cand[]> {
  const base = { source: 'uniswap-v4', target: v4adapter, spender: v4adapter };
  if (scan.error) return [{ ...base, ...scan.error, stage: 'NONE', eligibility: 'ELIGIBLE' }];
  if (!scan.pools.length) return [{ ...base, status: 'NO_POOL', stage: 'NONE', eligibility: 'ELIGIBLE' }];
  if (!scan.layout.verified) return [{ ...base, status: 'LAYOUT_UNVERIFIED', stage: 'NONE', eligibility: 'ELIGIBLE', reason: 'PoolManager storage layout check failed; liquidity numbers are not trusted' }];
  // With the liquidity offset confirmed, rank by in-range liquidity; otherwise execute every pool up to a cap (no ranking trusted).
  const ranked = scan.layout.liquidityOffsetVerified === true
    ? scan.pools.filter((p: any) => p.liquidity > 0n).sort((a: any, b: any) => (b.liquidity > a.liquidity ? 1 : -1)).slice(0, POLICY.v4ExecutePerLeg)
    : [...scan.pools].sort((a: any, b: any) => Number(a.key.fee) - Number(b.key.fee)).slice(0, POLICY.v4UnrankedCap);
  if (!ranked.length) return [{ ...base, status: 'NO_LIQUIDITY', stage: 'NONE', eligibility: 'ELIGIBLE', reason: `${scan.pools.length} pool(s) initialized, none with in-range liquidity` }];
  const res: Cand[] = [];
  for (const p of ranked) {
    const zeroForOne = p.key.currency0 === USDG, hooked = p.key.hooks.toLowerCase() !== v.zeroAddress;
    const allow = PRICE_POLICY.hookAllowlist.map((h: string) => h.toLowerCase()).includes(p.key.hooks.toLowerCase());
    const call = (amt: bigint) => v.encodeFunctionData({ abi: adapterAbi, functionName: 'swapExactIn', args: [p.key, zeroForOne, amt, 0n] });
    const b: any = { ...base, route: { poolId: p.id, ...p.key, zeroForOne, inRangeLiquidity: p.liquidity, lpFee: p.lpFee }, eligibility: hooked && !allow ? 'HOOK_NOT_ALLOWLISTED' : 'ELIGIBLE' };
    const full = await forkSwap(`${tag}-v4-${p.id.slice(2, 10)}`, { tx: { to: v4adapter, data: call(amount) }, spender: v4adapter, tokenOut: token, amountIn: amount, transit: [v4adapter] });
    const probe = full.stage === 'RECEIPT_VERIFIED' ? await forkSwap(`${tag}-v4-${p.id.slice(2, 10)}-probe`, { tx: { to: v4adapter, data: call(probeIn) }, spender: v4adapter, tokenOut: token, amountIn: probeIn, transit: [v4adapter] }) : undefined;
    const c = fromExec(b, full, probe, amount, probeIn);
    c.routerLeg = (amountIn: bigint) => ({ target: v4adapter, value: 0n, approveToken: USDG, approveAmount: amountIn, callData: call(amountIn) });
    res.push(c);
  }
  return res;
}

// ---- API sources: comparison only (spender not independently verified) -----------------------
async function apiJson(url: string, init: any = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let body: any; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}
const KYBER_CHAIN = arg('--kyber-chain', 'robinhood')!;
async function sourceKyber(token: string, amount: bigint, _p: bigint, tag: string): Promise<Cand[]> {
  const base = { source: 'kyberswap', eligibility: 'EXCLUDED_UNVERIFIED', note: 'the API returns one routerAddress used as both call target and spender; that equality is assumed, not verified, so this source is never a router pick' };
  const api = `https://aggregator-api.kyberswap.com/${KYBER_CHAIN}/api/v1`, headers: any = { 'x-client-id': env.KYBER_CLIENT_ID || 'bag-shadow-measure', 'content-type': 'application/json' };
  try {
    const r = await apiJson(`${api}/routes?tokenIn=${USDG}&tokenOut=${token}&amountIn=${amount}`, { headers });
    if (r.status !== 200 || !r.body?.data?.routeSummary) return [{ ...base, status: /route|not found|4008|4011/i.test(JSON.stringify(r.body)) ? 'NO_ROUTE' : 'API_ERROR', stage: 'NONE', reason: `HTTP ${r.status}: ${redact(JSON.stringify(r.body))}` }];
    const b = await apiJson(`${api}/route/build`, { method: 'POST', headers, body: JSON.stringify({ routeSummary: r.body.data.routeSummary, sender: taker.address, recipient: taker.address, slippageTolerance: slippageBps }) });
    if (b.status !== 200 || !b.body?.data?.data) return [{ ...base, status: 'API_ERROR', stage: 'NONE', reason: `HTTP ${b.status}: ${redact(JSON.stringify(b.body))}` }];
    const to = b.body.data.routerAddress;
    const full = await forkSwap(`${tag}-kyber`, { tx: { to, data: b.body.data.data }, spender: to, tokenOut: token, amountIn: amount, transit: [to] });
    return [{ ...fromExec({ ...base, target: to, spender: `${to} (assumed)` }, full, undefined, amount, 0n), quotedOutRaw: BigInt(b.body.data.amountOut), quoteStage: 'QUOTED' }];
  } catch (e) { return [{ ...base, ...classify(e), status: 'API_ERROR', stage: 'NONE' }]; }
}
async function source0x(token: string, amount: bigint, _p: bigint, tag: string): Promise<Cand[]> {
  const base = { source: '0x', eligibility: 'EXCLUDED_UNVERIFIED', note: 'allowance-holder flow; never a router pick. transaction.to is never used as the spender.' };
  if (!env.ZEROX_API_KEY) return [{ ...base, status: 'NOT_RUN', stage: 'NONE', reason: 'ZEROX_API_KEY not in --env-file' }];
  try {
    const r = await apiJson(`https://api.0x.org/swap/allowance-holder/quote?chainId=4663&sellToken=${USDG}&buyToken=${token}&sellAmount=${amount}&taker=${taker.address}&slippageBps=${slippageBps}`, { headers: { '0x-api-key': env.ZEROX_API_KEY, '0x-version': 'v2' } });
    if (r.status !== 200) return [{ ...base, status: 'API_ERROR', stage: 'NONE', reason: `HTTP ${r.status}: ${redact(JSON.stringify(r.body))}` }];
    if (r.body?.liquidityAvailable === false) return [{ ...base, status: 'NO_ROUTE', stage: 'NONE' }];
    const tx = r.body?.transaction, spender = r.body?.issues?.allowance?.spender;
    if (!tx?.to) return [{ ...base, status: 'API_ERROR', stage: 'NONE', reason: 'quote without transaction' }];
    if (!spender) return [{ ...base, status: 'EXCLUDED_UNVERIFIED', stage: 'QUOTED', quotedOutRaw: BigInt(r.body.buyAmount ?? 0), reason: 'quote names no allowance spender; not executed (no fallback to transaction.to)' }];
    const full = await forkSwap(`${tag}-0x`, { tx: { to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) }, spender, tokenOut: token, amountIn: amount, transit: [tx.to, spender] });
    return [{ ...fromExec({ ...base, target: tx.to, spender }, full, undefined, amount, 0n), quotedOutRaw: BigInt(r.body.buyAmount), quoteStage: 'QUOTED' }];
  } catch (e) { return [{ ...base, ...classify(e), status: 'API_ERROR', stage: 'NONE' }]; }
}

// ---- Composer (basket-level: one compiled transaction for the whole BAG) ----------------------
async function sourceComposer(graph: any, amount: bigint): Promise<any> {
  const base = { source: 'composer', eligibility: 'NOT_ROUTER_COMPATIBLE', basketLevel: true };
  if (!env.LIFI_API_KEY) return { ...base, status: 'NOT_RUN', stage: 'NONE', reason: 'LIFI_API_KEY not in --env-file' };
  if (!arg('--sdk')) return { ...base, status: 'NOT_RUN', stage: 'NONE', reason: '--sdk <built packages/bag-sdk> not given' };
  try {
    const sdkDir = resolve(arg('--sdk')!);
    const sdk = await import(pathToFileURL(join(sdkDir, 'dist/index.js')).href);
    const { lifiComposer, resolveLifiComposerAccount } = await import(pathToFileURL(join(sdkDir, 'dist/adapters/lifi.js')).href);
    const parsed = sdk.parseBag(bag); if (!parsed.ok) throw new Error('parseBag failed');
    const deployment = { chainId: 4663, factory: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae', factoryCodeHash: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5' };
    const account = await resolveLifiComposerAccount({ chainId: 4663, signer: taker.address, deployment, client: remote });
    const compiled = await sdk.compileBag(parsed.bag, { inputToken: USDG, amountRaw: amount, inputTokenDecimals: 6, signer: taker.address },
      { provider: lifiComposer({ apiKey: env.LIFI_API_KEY, baseUrl: 'https://composer.li.quest', account, timeoutMs: 60000 }), trust: account.trust });
    const snap = await rpc('evm_snapshot');
    try {
      for (const a of compiled.approvals) await send('taker', a.token, erc20, 'approve', [a.spender, BigInt(a.amountRaw)]);
      const toks = graph.legs.map((l: any) => l.targetAsset.address.toLowerCase()), before: any = {};
      for (const t of [USDG.toLowerCase(), ...toks]) before[t] = await bal(t, taker.address);
      const hash = await W.taker.sendTransaction({ to: compiled.transaction.to, data: compiled.transaction.data, value: BigInt(compiled.transaction.value ?? 0), gas: 25_000_000n });
      const r = await client().waitForTransactionReceipt({ hash });
      const outs: any = {}; for (const t of toks) outs[t] = (await bal(t, taker.address)) - before[t];
      const spent = before[USDG.toLowerCase()] - await bal(USDG, taker.address);
      const issues = [r.status !== 'success' && 'receipt failed', spent !== amount && `debit ${spent} != ${amount}`, ...toks.filter((t: string) => outs[t] <= 0n).map((t: string) => 'no output ' + t)].filter(Boolean);
      return { ...base, status: issues.length ? 'UNVERIFIED_EXECUTION' : 'OK', stage: issues.length ? 'FORK_EXECUTED' : 'RECEIPT_VERIFIED', issues, txHash: hash, gasUsed: r.gasUsed, outs, spentRaw: spent,
        target: compiled.transaction.to, spender: compiled.approvals.map((a: any) => a.spender).join(','), priceImpactBps: compiled.quote.priceImpactBps };
    } finally { await rpc('evm_revert', [snap]); }
  } catch (e) { const c = classify(e); return { ...base, stage: 'NONE', status: c.status === 'REVERTED' ? 'API_ERROR' : c.status, reason: redact((e as any)?.code ? `${(e as any).code}: ${(e as any).message}` : c.reason) }; }
}

// ---- Basket: chosen legs through the existing BagExecutionRouter, in call order ---------------
const routerAbi = routerArt.abi;
async function basketThroughRouter(graph: any, graphHash: string, chosen: Map<string, Cand>, isolated: Map<string, bigint>) {
  const missing = graph.legs.filter((l: any) => !chosen.get(l.id));
  if (missing.length) return { status: 'MISSING_LEGS', stage: 'NONE', legs: missing.map((l: any) => symbolOf(l.targetAsset.address)) };
  const snap = await rpc('evm_snapshot');
  try {
    const legs: any[] = [], minOutputs: any[] = [];
    for (const l of graph.legs) {
      const leg = chosen.get(l.id)!.routerLeg!(BigInt(l.amountRaw));
      await send('keeper', router, routerAbi, 'setAllowedTarget', [leg.target, true]); legs.push(leg);
      minOutputs.push({ token: v.getAddress(l.targetAsset.address), minAmountOut: (isolated.get(l.id)! * BigInt(10000 - slippageBps)) / 10000n });
    }
    const tokens = graph.legs.map((l: any) => v.getAddress(l.targetAsset.address));
    for (const t of [USDG, ...tokens]) await send('keeper', router, routerAbi, 'setAllowedToken', [t, true]);
    const inputAmount = graph.legs.reduce((a: bigint, l: any) => a + BigInt(l.amountRaw), 0n);
    const plan = { bagId: v.keccak256(v.toBytes(graph.bagId)), executionPlanHash: ('0x' + graphHash.replace(/^0x/, '').padStart(64, '0')) as `0x${string}`, wallet: taker.address,
      inputToken: USDG, inputAmount, deadline: (await client().getBlock()).timestamp + 600n, legs, minOutputs };
    const signature = await planSigner.signTypedData({ domain: { name: 'BagExecutionRouter', version: '1', chainId: 4663, verifyingContract: router }, primaryType: 'ExecutionPlan',
      types: { ExecutionPlan: [{ name: 'bagId', type: 'bytes32' }, { name: 'executionPlanHash', type: 'bytes32' }, { name: 'wallet', type: 'address' }, { name: 'inputToken', type: 'address' },
        { name: 'inputAmount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'legs', type: 'Leg[]' }, { name: 'minOutputs', type: 'OutputCheck[]' }],
        Leg: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }, { name: 'value', type: 'uint256' }, { name: 'approveToken', type: 'address' }, { name: 'approveAmount', type: 'uint256' }],
        OutputCheck: [{ name: 'token', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }] }, message: plan });
    await send('taker', USDG, erc20, 'approve', [router, inputAmount]);
    const who = [taker.address, router, ...new Set(legs.map(l => l.target))];
    const read = async () => { const m: Record<string, bigint> = {}; for (const a of who) for (const t of [USDG, ...tokens]) m[`${a.toLowerCase()}:${t.toLowerCase()}`] = await bal(t, a); return m; };
    const before = await read();
    let hash: string;
    try { hash = await W.taker.writeContract({ address: router, abi: routerAbi, functionName: 'execute', args: [plan, signature], gas: 15_000_000n }); }
    catch (e) { const c = classify(e); return { stage: 'NONE', ...c, revertSite: await revertSite({ to: router, data: v.encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [plan, signature] }) }) }; }
    const r = await client().waitForTransactionReceipt({ hash });
    try { writeFileSync(join(out, 'traces', `basket-${graphHash.slice(2, 10)}-trace.json`), json(await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }]))); } catch {}
    const after = await read(), k = (a: string, t: string) => `${a.toLowerCase()}:${t.toLowerCase()}`;
    const transfers = v.parseEventLogs({ abi: erc20, logs: r.logs, eventName: 'Transfer' }) as any[];
    const completed = v.parseEventLogs({ abi: routerAbi, logs: r.logs, eventName: 'ExecutionCompleted' }) as any[];
    const issues: string[] = [];
    if (r.status !== 'success') issues.push('receipt failed');
    if (completed.length !== 1) issues.push('ExecutionCompleted not emitted exactly once');
    const debit = before[k(taker.address, USDG)] - after[k(taker.address, USDG)]; if (debit !== inputAmount) issues.push(`debit ${debit} != ${inputAmount}`);
    const realized = graph.legs.map((l: any, i: number) => {
      const t = tokens[i], got = after[k(taker.address, t)] - before[k(taker.address, t)], iso = isolated.get(l.id)!;
      const logged = transfers.filter(x => x.address.toLowerCase() === t.toLowerCase() && x.args.from.toLowerCase() === router.toLowerCase() && x.args.to.toLowerCase() === taker.address.toLowerCase()).reduce((s, x) => s + x.args.value, 0n);
      if (logged !== got) issues.push(`${symbolOf(t)}: Transfer logs ${logged} != balance delta ${got}`);
      if (got < minOutputs[i].minAmountOut) issues.push(`${symbolOf(t)} below its minimum`);
      return { leg: symbolOf(t), source: chosen.get(l.id)!.source, route: chosen.get(l.id)!.route, isolatedOutRaw: iso, realizedOutRaw: got, realizedVsIsolatedBps: iso > 0n ? Number(((got - iso) * 10000n) / iso) : null };
    });
    const residue = who.slice(1).flatMap(a => [USDG, ...tokens].map(t => ({ address: a, token: t, delta: after[k(a, t)] - before[k(a, t)] }))).filter(x => x.delta !== 0n);
    if (residue.length) issues.push('transit balance left on router/targets');
    const allowanceAfter = await client().readContract({ address: USDG, abi: erc20, functionName: 'allowance', args: [taker.address, router] }) as bigint;
    if (allowanceAfter !== 0n) issues.push('router allowance not consumed');
    return { status: issues.length ? 'UNVERIFIED_EXECUTION' : 'EXECUTED', stage: issues.length ? 'FORK_EXECUTED' : 'RECEIPT_VERIFIED', issues, txHash: hash, blockNumber: r.blockNumber, gasUsed: r.gasUsed,
      router: 'BagExecutionRouter (app main, unchanged; planSigner trust model, signed here by a local test key)', minOutputRule: `isolated realized - ${slippageBps} bps`, debitRaw: debit, realized, residue, allowanceAfter };
  } catch (e) { return { stage: 'NONE', ...classify(e) }; }
  finally { await rpc('evm_revert', [snap]); }
}

// =============================================================================================
Object.assign(report, { blockMode, forks,
  evidenceStages: { QUOTED: 'API/quoter number only', SIMULATED: 'eth_call result', FORK_EXECUTED: 'mined fork tx, a check did not hold', RECEIPT_VERIFIED: 'receipt + balance deltas + Transfer logs + no transit/allowance left' },
  bag: { definitionHash: bag.definitionHash ?? null, ref: bag.ref ?? null, assets: recipe.assets.map((a: any) => ({ symbol: a.symbol, address: a.address, weightBps: a.weightBps })) },
  policy: { ...POLICY, probeDivisor: String(POLICY.probeDivisor), slippageBps, pricePolicy: PRICE_POLICY }, sources: SOURCES,
  notMeasured: { '1inch': 'not implemented in this measurement (no adapter); not evidence either way' },
  sourceHashes: { 'measure.ts': createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    'ShadowAdapters.sol': createHash('sha256').update(readFileSync(join(here, 'contracts/ShadowAdapters.sol'))).digest('hex'),
    'lib/price-gate.mjs': createHash('sha256').update(readFileSync(join(here, '..', 'lib/price-gate.mjs'))).digest('hex'),
    'lib/router-dca-gate.mjs': createHash('sha256').update(readFileSync(join(here, '..', 'lib/router-dca-gate.mjs'))).digest('hex'),
    'BagExecutionRouter.sol (app)': createHash('sha256').update(routerSource).digest('hex') },
  addresses: { poolManager: pm, v3Factory: V3_FACTORY, v3Quoter: V3_QUOTER, v3Router02: V3_ROUTER02, universalRouter: UNIVERSAL_ROUTER }, runs: [] });
const legSources: Record<string, (t: string, a: bigint, p: bigint, tag: string, scan?: any) => Promise<Cand[]>> = { 'uniswap-v3': sourceV3, 'uniswap-v4': sourceV4, kyberswap: sourceKyber, '0x': source0x };
const graphs = AMOUNTS.map(amt => {
  const amount = v.parseUnits(amt, 6);
  const deposit = calculateDepositAllocation({ bagId: recipe.bagId, inputAsset: { chain: 'robinhood', address: USDG }, amountRaw: amount.toString() }, recipe);
  const graph = buildBagExecutionGraph(buildExecutionPlan(deposit), { wallet: taker.address, chainId: 'robinhood', defaultSlippageBps: slippageBps });
  assertValidExecutionGraph(graph);
  const graphHash = computeBagExecutionGraphHash(graph) as string;
  return { amt, amount, graph, graphHash, run: { amountUsdg: amt, graphHash, legs: [] as any[] } as any, chosen: new Map<string, Cand>(), isolated: new Map<string, bigint>() };
});
async function measureLeg(i: number, block: bigint) {
  const token = v.getAddress(graphs[0].graph.legs[i].targetAsset.address);
  let scan: any = undefined;
  if (SOURCES.includes('uniswap-v4')) { try { scan = await v4Scan(token); } catch (e) { scan = { error: classify(e) }; } }
  for (const G of graphs) {
    const leg = G.graph.legs[i], legAmount = BigInt(leg.amountRaw), probeIn = legAmount / POLICY.probeDivisor > 0n ? legAmount / POLICY.probeDivisor : 1n;
    const cands: Cand[] = [];
    for (const s of SOURCES) if (legSources[s]) { const r = await legSources[s](token, legAmount, probeIn, `${G.amt}-${symbolOf(token)}`, scan); console.log(`${G.amt} USDG  ${symbolOf(token)}  ${s}: ${r.map(c => c.status + '/' + c.stage).join(', ')}`); cands.push(...r); }
    const verified = cands.filter(c => c.stage === 'RECEIPT_VERIFIED');
    const best = verified.reduce((m: bigint, c) => (c.outRaw! > m ? c.outRaw! : m), 0n);
    for (const c of verified) c.vsBestBps = best > 0n ? Number(((c.outRaw! - best) * 10000n) / best) : undefined;
    for (const c of verified) c.gate = priceGate(c, { peers: verified });
    const pick = verified.filter(c => c.eligibility === 'ELIGIBLE' && c.routerLeg).sort((a, b) => (b.outRaw! > a.outRaw! ? 1 : -1))[0];
    if (pick) { G.chosen.set(leg.id, pick); G.isolated.set(leg.id, pick.outRaw!); }
    G.run.legs.push({ id: leg.id, symbol: symbolOf(token), token, forkBlock: block, amountRaw: leg.amountRaw, weightBps: leg.weightBps,
      v4Scan: scan && !scan.error ? { pools: scan.pools.length, withInRangeLiquidity: scan.pools.filter((p: any) => p.liquidity > 0n).length, layout: scan.layout } : scan,
      candidates: cands.map(({ routerLeg, ...c }) => c), routerPick: pick ? { source: pick.source, route: pick.route, outRaw: pick.outRaw } : null, gate: pick?.gate ?? { decision: 'FAIL', reasons: ['NO_ELIGIBLE_RECEIPT_VERIFIED_ROUTE'] } });
  }
}
let fatal: string | undefined;
try {
  if (mode === 'single') {
    const block = await openFork('single block');
    for (let i = 0; i < graphs[0].graph.legs.length; i++) await measureLeg(i, block);
    for (const G of graphs) {
      G.run.basketForkBlock = block;
      if (SOURCES.includes('composer')) { G.run.composer = await sourceComposer(G.graph, G.amount); console.log(`${G.amt} USDG  basket  composer: ${G.run.composer.status}`); }
      G.run.basket = await basketThroughRouter(G.graph, G.graphHash, G.chosen, G.isolated); console.log(`${G.amt} USDG  basket through BagExecutionRouter: ${G.run.basket.status}/${G.run.basket.stage}`);
    }
  } else {
    for (let i = 0; i < graphs[0].graph.legs.length; i++) await measureLeg(i, await openFork('leg ' + symbolOf(graphs[0].graph.legs[i].targetAsset.address)));
    // Basket on its own fresh fork: each chosen route is executed again at that block so the basket is compared with same-block isolated numbers.
    for (const G of graphs) {
      G.run.basketForkBlock = await openFork('basket ' + G.amt + ' USDG');
      for (const leg of G.graph.legs) {
        const pick = G.chosen.get(leg.id); if (!pick) continue;
        const legAmount = BigInt(leg.amountRaw), token = v.getAddress(leg.targetAsset.address), call = pick.routerLeg!(legAmount, taker.address);
        const again = await forkSwap(`${G.amt}-${symbolOf(token)}-basket-isolated`, { tx: { to: call.target, data: call.callData }, spender: call.target, tokenOut: token, amountIn: legAmount, transit: [call.target] });
        if (again.stage === 'RECEIPT_VERIFIED') G.isolated.set(leg.id, again.outRaw!); else G.chosen.delete(leg.id);
        (G.run.basketIsolated ??= []).push({ leg: symbolOf(token), source: pick.source, status: again.status, stage: again.stage, outRaw: again.outRaw, txHash: again.txHash });
      }
      if (SOURCES.includes('composer')) { G.run.composer = await sourceComposer(G.graph, G.amount); console.log(`${G.amt} USDG  basket  composer: ${G.run.composer.status}`); }
      G.run.basket = await basketThroughRouter(G.graph, G.graphHash, G.chosen, G.isolated); console.log(`${G.amt} USDG  basket through BagExecutionRouter: ${G.run.basket.status}/${G.run.basket.stage}`);
    }
  }
} catch (e) { fatal = redact(errText(e)); console.log('FATAL', fatal); }
for (const G of graphs) { G.run.basketGate = basketGate(G.run.legs.map((l: any) => l.gate)); G.run.executableForUsers = false; report.runs.push(G.run); }
if (F) { forks.at(-1).localTransactions = F.localTx.sent; forks.at(-1).changes = F.changes; await F.close(); F = undefined; }
report.relay = relay.stats;
report.publicTransactions = { relayRefusedWriteRequests: relay.stats.refusedRequests, forwardedMethods: Object.keys(relay.stats.forwardedByMethod), note: 'only allowlisted read methods ever reach the RPC; fork transactions are local' };
const statuses: Record<string, number> = {};
const tally = (s?: string) => { if (s) statuses[s] = (statuses[s] ?? 0) + 1; };
for (const r of report.runs) { for (const l of r.legs) for (const c of l.candidates) tally(c.status); tally(r.composer?.status); tally(r.basket?.status); }
report.statusCounts = statuses;
const incomplete = ['RPC_ERROR', 'PRUNED_STATE', 'API_ERROR'].some(s => statuses[s]);
const basketFailed = report.runs.some((r: any) => r.basket?.status !== 'EXECUTED');
const exitCode = fatal ? 1 : incomplete ? 3 : basketFailed ? 4 : 0;
report.exit = { code: exitCode, status: fatal ? 'FATAL' : incomplete ? 'INCOMPLETE' : basketFailed ? 'BASKET_FAILED' : 'COMPLETE', fatal };
report.routerDca = routerDcaReadiness(report);
report.finishedAt = new Date().toISOString();
writeFileSync(join(out, 'results.json'), json(report));

// Human summary
const fmt = (x?: bigint, d = 18) => (x === undefined ? '' : Number(v.formatUnits(x, d)).toPrecision(6));
let md = `# Gölge ölçüm (v2)\n\nBlok modu: **${blockMode.label}** — ${blockMode.note}\n\nFork blokları: ${forks.map(f => f.label + ' ' + f.blockNumber).join(', ')} · BAG ${bag.ref?.strategyId ?? ''} · kaynaklar: ${SOURCES.join(', ')} · public işlem 0 · çıkış ${report.exit.status} (${exitCode})\n\n`;
md += `Kanıt aşamaları: RECEIPT_VERIFIED = fork makbuzu + bakiye farkları + Transfer logları + transit/onay sıfır. Fiyat kapısı: ${PRICE_POLICY.proven ? 'kanıtlı' : '**kanıtlanmadı → hiçbir rota kullanıcı için çalıştırılabilir değil (PRICE_POLICY_UNPROVEN)**'}.\n\n`;
for (const r of report.runs) {
  md += `## ${r.amountUsdg} USDG\n\n| Bacak | Aday (kaynak · rota) | Durum / kanıt | Çıktı | En iyiye göre | Etki (bps) | Uygunluk | Kapı |\n|---|---|---|---|---|---|---|---|\n`;
  for (const l of r.legs) for (const c of l.candidates) {
    const route = c.route ? (c.route.poolId ? `v4 ${String(c.route.poolId).slice(0, 10)} fee ${c.route.fee}${c.route.hooks && c.route.hooks !== v.zeroAddress ? ' hook ' + c.route.hooks.slice(0, 8) : ''}` : `fee ${c.route.fee}`) : '';
    md += `| ${l.symbol} | ${c.source} ${route} | ${c.status} / ${c.stage} | ${fmt(c.outRaw)} | ${c.vsBestBps ?? ''} | ${c.impactBps ?? ''} | ${c.eligibility} | ${c.gate?.decision ?? ''} |\n`;
  }
  md += `\nRouter seçimleri: ${r.legs.map((l: any) => `${l.symbol}: ${l.routerPick ? l.routerPick.source + ' ' + (l.routerPick.route?.poolId ? 'v4' : 'fee ' + l.routerPick.route?.fee) : '—'} (${l.gate.decision})`).join(' · ')}\n`;
  if (r.composer) md += `\nComposer (sepet): ${r.composer.status}${r.composer.reason ? ' — ' + r.composer.reason : ''}\n`;
  md += `\nSepet, mevcut BagExecutionRouter ile: **${r.basket?.status} / ${r.basket?.stage}**${r.basket?.legs ? ' — eksik: ' + r.basket.legs.join(', ') : ''}${r.basket?.reason ? ' — ' + r.basket.reason : ''}${r.basket?.issues?.length ? ' — ' + r.basket.issues.join('; ') : ''}\n`;
  if (r.basket?.realized) md += `tx ${r.basket.txHash} · gas ${r.basket.gasUsed}\n\n` + r.basket.realized.map((x: any) => `- ${x.leg} (${x.source}): tek başına ${fmt(x.isolatedOutRaw)} → sepette ${fmt(x.realizedOutRaw)} (${x.realizedVsIsolatedBps} bps)`).join('\n') + '\n';
  md += `\nSepet kapısı: **${r.basketGate.decision}** (${r.basketGate.reasons.join(', ')}) · kullanıcı için çalıştırılabilir: hayır\n\n`;
}
md += `## Composer'sız DCA hazırlığı: **${report.routerDca.status}**\n\n` + report.routerDca.gates.map((g: any) => `- ${g.status === 'OPEN' ? '✅' : '⛔'} ${g.id}: ${g.detail}`).join('\n') + '\n';
writeFileSync(join(out, 'summary.md'), md);
console.log(`\nSHADOW ${report.exit.status} (exit ${exitCode}) -> ${out}`);
} catch (e) {
  if (!report.exit) report.exit = { code: 1, status: 'FATAL', fatal: redact(errText(e)) };
  console.log(`SHADOW ${report.exit.status}: ${report.exit.fatal ?? report.exit.detail}`);
} finally {
  report.finishedAt ??= new Date().toISOString();
  if (relay) report.relay ??= relay.stats;
  try { writeFileSync(join(out, 'results.json'), json(report)); } catch {}
  try { await F?.close(); } catch {}
  try { await relay?.close(); } catch {}
}
process.exit(report.exit?.code ?? 1);
