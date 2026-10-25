// RESEARCH PROTOTYPE: read-only shadow measurement of execution sources for one BAG purchase.
// Same BAG, same amounts, one pinned fork block. Nothing is sent to a public network: every quote
// is taken on an isolated fork behind a read-only relay; API sources only return calldata, which is
// executed on the fork.
//
// Run from the app checkout so its `@/` imports resolve (BagExecutionGraph is built by the app's
// own code, not re-implemented here):
//   cd <BagProtocolv2 checkout> && npx tsx <proto>/shadow/measure.ts --app . --bag <bag.json> \
//     --amounts 5,100 [--sources uniswap-v3,uniswap-v4,kyberswap,0x,composer] [--env-file .env.local] \
//     [--sdk <built packages/bag-sdk>] [--kyber-chain robinhood]
//
// Keys (LIFI_API_KEY, ZEROX_API_KEY, KYBER_CLIENT_ID) and ROBINHOOD_RPC_URL are read from --env-file
// only and never written out. A source without its key/network is reported NOT_RUN, never guessed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const app = resolve(arg('--app', '.')!);
const out = resolve(arg('--out', join(here, 'out', 'shadow-' + new Date().toISOString().replaceAll(':', '-')))!);
if (existsSync(out)) throw new Error('Use a new --out directory.');
mkdirSync(out, { recursive: true });
const SOURCES = (arg('--sources', 'uniswap-v3,uniswap-v4,kyberswap,0x,composer')!).split(',');
const AMOUNTS = (arg('--amounts', '5,100')!).split(',').map(s => s.trim());
const env: Record<string, string> = {};
if (arg('--env-file')) for (const line of readFileSync(resolve(arg('--env-file')!), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2];
}
const RPC = env.ROBINHOOD_RPC_URL || env.ROBINHOOD_MAINNET_RPC_URL || arg('--rpc', 'https://rpc.mainnet.chain.robinhood.com')!;
const redact = (x: unknown) => String(x).replace(/https?:\/\/[^\s"'<>]+/g, '<url>').replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 400);

const protoRequire = createRequire(join(here, '..', 'package.json'));
const v = protoRequire('viem');
const { privateKeyToAccount, generatePrivateKey } = protoRequire('viem/accounts');
const solc23 = protoRequire('solc');
const appRequire = createRequire(join(app, 'package.json'));
const solc24 = appRequire('solc');
const { createHardhatRuntimeEnvironment } = await import(pathToFileURL(protoRequire.resolve('hardhat/hre')).href);

// ---- Policy (recorded in the report) -------------------------------------------------------
const POLICY = {
  badPriceImpactBps: 500,      // full-size unit price more than 5% below a 1% probe of the same route
  probeDivisor: 100n,
  v3FeeTiers: [100, 500, 3000, 10000],
  sdkMaxSlippageBps: 300,      // SDK V1_EXECUTION_POLICY.maxSlippageBps; the BAG rule may be stricter
};
const USDG = v.getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const USDG_HOLDER = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';   // lib/config/robinhood-chain.ts (VERIFIED)
const V3_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const V3_ROUTER02 = '0xCaf681a66D020601342297493863E78C959E5cb2';
const UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';

// ---- BAG → BagExecutionGraph with the app's own code ----------------------------------------
const bagFile = JSON.parse(readFileSync(resolve(arg('--bag')!), 'utf8'));
const bag = bagFile.bagJson ? bagFile : bagFile.bag;
assert(bag?.bagJson === 1, '--bag must be a bag.json document (or a fixture with .bag)');
const { calculateDepositAllocation } = await import(pathToFileURL(join(app, 'lib/domain/basket-protocol/deposit/allocation.ts')).href);
const { buildExecutionPlan } = await import(pathToFileURL(join(app, 'lib/domain/basket-protocol/deposit/execution-plan.ts')).href);
const { buildBagExecutionGraph, assertValidExecutionGraph, computeBagExecutionGraphHash } = await import(pathToFileURL(join(app, 'lib/execution/plan.ts')).href);
const symbolOf = (a: string) => bag.metadata?.assets?.find((m: any) => m.address.toLowerCase() === a.toLowerCase())?.symbol ?? a.slice(0, 8);
const recipe = { id: bag.ref?.strategyId ?? 'shadow', bagId: bag.ref?.strategyId ?? 'shadow', name: bag.metadata?.name ?? '', symbol: bag.metadata?.symbol ?? '', description: '',
  chain: 'robinhood', strategyType: 'STATIC_BASKET', rebalanceRule: { frequency: 'MANUAL' }, minInvestment: 0, maxAssets: 10, minWeightBps: 0, maxWeightBps: 10000,
  mutability: bag.definition.mutability ?? 'MUTABLE', version: bag.ref?.version ?? 1, createdAt: '',
  assets: bag.definition.assets.map((a: any) => ({ chain: a.chain, address: a.address, symbol: symbolOf(a.address), decimals: a.decimals, weightBps: a.weightBps })) };
const slippageBps = Math.min(bag.definition.rules?.swapSlippageBps ?? 100, POLICY.sdkMaxSlippageBps);

// ---- Read-only relay + fork at one pinned block ---------------------------------------------
const allowed = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getProof']);
const rejected: string[] = [];
// The public RPC rate-limits bursts (the fork fetches many slots at once). Bounded concurrency and
// retries keep transport failures from being misread as "no liquidity"; every retry is counted.
const relayStats = { requests: 0, retries: 0, failures: 0, upstreamErrors: {} as Record<string, number> };
let inflight = 0; const waiters: (() => void)[] = [];
const acquire = async () => { while (inflight >= 4) await new Promise<void>(r => waiters.push(r)); inflight++; };
const release = () => { inflight--; waiters.shift()?.(); };
async function upstream(body: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      const transient = r.status === 429 || r.status >= 500 || /rate limit|too many requests|-32005|-32603/i.test(text) && !/execution reverted/i.test(text);
      if (!transient || attempt >= 5) { if (transient) relayStats.failures++; return { status: r.status, text }; }
      relayStats.upstreamErrors[String(r.status)] = (relayStats.upstreamErrors[String(r.status)] ?? 0) + 1;
    } catch (e) {
      relayStats.upstreamErrors.network = (relayStats.upstreamErrors.network ?? 0) + 1;
      if (attempt >= 5) { relayStats.failures++; throw e; }
    }
    relayStats.retries++; await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
  }
}
const relay = createServer(async (req, res) => {
  try {
    let body = ''; for await (const c of req) body += c;
    const calls = ([] as any[]).concat(JSON.parse(body));
    if (calls.some(c => !allowed.has(c.method))) { rejected.push(...calls.map(c => c.method)); res.writeHead(403); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"read-only relay"}}'); return; }
    relayStats.requests++; await acquire();
    try { const r = await upstream(body); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text); } finally { release(); }
  } catch { res.writeHead(502); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream unavailable"}}'); }
});
await new Promise<void>(r => relay.listen(0, '127.0.0.1', () => r()));
const relayUrl = 'http://127.0.0.1:' + (relay.address() as any).port;
assert.equal((await fetch(relayUrl, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}' })).status, 403);
const chain = v.defineChain({ id: 4663, name: 'ISOLATED Robinhood fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [relayUrl] } } });
const remote = v.createPublicClient({ chain, transport: v.http(relayUrl) });
const firstBlock = await remote.getBlock();
let forkBlock: any = firstBlock, connection: any, transport: any, client: any, W: any = {};
const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as any);
const forks: any[] = [];
// ---- Compile: research adapters (0.8.23) and the app's existing BagExecutionRouter (0.8.24) ---
function compile(solc: any, sources: Record<string, string>, settings: any, find?: (p: string) => { contents?: string; error?: string }) {
  const o = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).map(([k, c]) => [k, { content: c }])),
    settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), find ? { import: find } : undefined));
  const errs = (o.errors ?? []).filter((e: any) => e.severity === 'error'); if (errs.length) throw new Error(errs.map((e: any) => e.formattedMessage).join('\n'));
  return (n: string) => { for (const f of Object.values(o.contracts) as any[]) if (f[n]) return { abi: f[n].abi, bytecode: '0x' + f[n].evm.bytecode.object, runtime: '0x' + f[n].evm.deployedBytecode.object }; throw new Error(n); };
}
const art = compile(solc23, { 'ShadowAdapters.sol': readFileSync(join(here, 'contracts/ShadowAdapters.sol'), 'utf8'), 'LocalArbSysRead.sol': readFileSync(join(here, '..', 'composer/contracts/LocalArbSysRead.sol'), 'utf8') },
  { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai' });
const routerSource = readFileSync(join(app, 'contracts/BagExecutionRouter.sol'), 'utf8');
const routerArt = compile(solc24, { 'contracts/BagExecutionRouter.sol': routerSource }, { optimizer: { enabled: false } },
  p => { try { return { contents: readFileSync(join(app, 'node_modules', p), 'utf8') }; } catch { return { error: 'not found: ' + p }; } })('BagExecutionRouter');
// ---- Accounts (local, random; fork only) and per-fork setup ------------------------------------
const taker = privateKeyToAccount(generatePrivateKey()), keeper = privateKeyToAccount(generatePrivateKey()), planSigner = privateKeyToAccount(generatePrivateKey());
const erc20 = v.parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)']);
const bal = (t: string, a: string) => client.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
async function send(who: string, to: string, abi: any, functionName: string, a: unknown[] = [], value = 0n) {
  const hash = await W[who].writeContract({ address: to, abi, functionName, args: a, value, gas: 15_000_000n });
  const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(functionName + ' failed'); return r;
}
const maxAmount = AMOUNTS.reduce((m, a) => (v.parseUnits(a, 6) > m ? v.parseUnits(a, 6) : m), 0n);
const deploy = async (a: { abi: any; bytecode: string }, ctor: unknown[] = []) =>
  (await client.waitForTransactionReceipt({ hash: await W.keeper.deployContract({ abi: a.abi, bytecode: a.bytecode, args: ctor, gas: 25_000_000n }) })).contractAddress as string;
const pm = await remote.readContract({ address: UNIVERSAL_ROUTER, abi: v.parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' }) as string;
let router = '', v4adapter = '', shadowFactory = '';
// A non-archive RPC prunes old state within minutes, so each comparison unit (one leg, every source
// and amount; then the basket) gets its own fresh fork. Within a unit every source sees one block.
async function newFork(label: string) {
  if (connection) await connection.close?.();
  forkBlock = await remote.getBlock();
  const hre = await createHardhatRuntimeEnvironment({ paths: { cache: join(out, 'cache') }, chainDescriptors: { 4663: { name: 'Robinhood fork (research)', chainType: 'l1', hardforkHistory: { cancun: { blockNumber: 0 } } } },
    networks: { fork: { type: 'edr-simulated', chainId: 4663, chainType: 'l1', hardfork: 'cancun', forking: { url: relayUrl, blockNumber: Number(forkBlock.number) }, throwOnTransactionFailures: true } } });
  connection = await hre.network.connect('fork');
  transport = v.custom({ request: (x: any) => connection.provider.request(x) });
  client = v.createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 10 });
  W = { taker: v.createWalletClient({ account: taker, chain, transport }), keeper: v.createWalletClient({ account: keeper, chain, transport }) };
  await rpc('hardhat_setCode', ['0x0000000000000000000000000000000000000064', art('LocalArbSysRead').runtime]); await rpc('evm_mine');
  for (const a of [taker, keeper]) await rpc('hardhat_setBalance', [a.address, v.toHex(v.parseEther('10'))]);
  await rpc('hardhat_impersonateAccount', [USDG_HOLDER]); await rpc('hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))]);
  await client.waitForTransactionReceipt({ hash: await v.createWalletClient({ account: USDG_HOLDER, chain, transport }).writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [taker.address, maxAmount * 3n], gas: 500000n }) });
  await rpc('hardhat_stopImpersonatingAccount', [USDG_HOLDER]);
  shadowFactory = await deploy(art('ShadowBagFactory'));
  router = await deploy(routerArt, [shadowFactory, keeper.address, planSigner.address]);
  v4adapter = await deploy(art('ShadowV4Adapter'), [pm]);
  v4Approved = false;
  forks.push({ label, blockNumber: forkBlock.number, blockHash: forkBlock.hash, timestamp: forkBlock.timestamp });
  return forkBlock.number;
}
let v4Approved = false;

// ---- Classification helpers -----------------------------------------------------------------
type Cand = { source: string; status: string; reason?: string; outRaw?: bigint; probeOutRaw?: bigint; impactBps?: number; route?: any; target?: string; spender?: string;
  routerCompatible?: boolean; routerLeg?: (amountIn: bigint) => Promise<any>; basketLevel?: boolean; vsBestBps?: number };
const errText = (e: any) => [e?.shortMessage, e?.details, e?.cause?.details, e?.cause?.message, e?.message].filter(Boolean).join(' | ');
// "Missing or invalid parameters" is viem's label for a JSON-RPC -32602/-32000 transport answer, not a swap revert.
const isRpcError = (e: any) => /upstream|fetch failed|timeout|ECONN|429|rate.?limit|socket|503|502|Missing or invalid parameters|InvalidInputRpcError|header not found/i.test(errText(e));
const impact = (amount: bigint, out: bigint, probeIn: bigint, probeOut: bigint) =>
  probeOut > 0n ? Number(10000n - (out * probeIn * 10000n) / (probeOut * amount)) : undefined;
function finalize(c: Cand, amount: bigint, probeIn: bigint): Cand {
  if (c.status !== 'OK' || c.outRaw === undefined || c.probeOutRaw === undefined) return c;
  c.impactBps = impact(amount, c.outRaw, probeIn, c.probeOutRaw);
  if (c.impactBps !== undefined && c.impactBps > POLICY.badPriceImpactBps) { c.status = 'BAD_PRICE'; c.reason = `full-size price ${c.impactBps} bps below a 1% probe of the same route (thin liquidity)`; }
  return c;
}

// ---- Source: Uniswap v3 (QuoterV2, every fee tier) -------------------------------------------
const quoterAbi = v.parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']);
const factoryAbi = v.parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const router02Abi = v.parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)']);
async function v3Quote(token: string, amount: bigint, fee: number) {
  const { result } = await client.simulateContract({ address: V3_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDG, tokenOut: token, amountIn: amount, fee, sqrtPriceLimitX96: 0n }] });
  return result[0] as bigint;
}
async function sourceV3(token: string, amount: bigint, probeIn: bigint): Promise<Cand> {
  const tiers: any[] = []; let rpcErr = false;
  for (const fee of POLICY.v3FeeTiers) {
    try {
      const pool = await remote.readContract({ address: V3_FACTORY, abi: factoryAbi, functionName: 'getPool', args: [USDG, token, fee], blockNumber: forkBlock.number });
      if (pool === v.zeroAddress) { tiers.push({ fee, status: 'NO_POOL' }); continue; }
      const outRaw = await v3Quote(token, amount, fee), probeOutRaw = await v3Quote(token, probeIn, fee);
      tiers.push(finalize({ source: 'uniswap-v3', status: 'OK', outRaw, probeOutRaw, route: { fee, pool } }, amount, probeIn));
    } catch (e) { if (isRpcError(e)) { rpcErr = true; tiers.push({ fee, status: 'RPC_ERROR', reason: redact(e) }); } else tiers.push({ fee, status: 'NO_LIQUIDITY', reason: redact(errText(e)) }); }
  }
  const ok = tiers.filter(t => t.status === 'OK').sort((a, b) => (b.outRaw > a.outRaw ? 1 : -1));
  const best = ok[0] ?? tiers.find(t => t.status === 'BAD_PRICE');
  const base: Cand = best ? { ...best } : { source: 'uniswap-v3', status: rpcErr ? 'RPC_ERROR' : tiers.every(t => t.status === 'NO_POOL') ? 'NO_POOL' : 'NO_LIQUIDITY' };
  base.source = 'uniswap-v3'; base.target = V3_ROUTER02; base.spender = V3_ROUTER02; base.routerCompatible = true;
  (base as any).tiers = tiers.map(t => ({ fee: t.route?.fee ?? t.fee, status: t.status, outRaw: t.outRaw, impactBps: t.impactBps, reason: t.reason }));
  if (best) base.routerLeg = async (amountIn: bigint) => ({ target: V3_ROUTER02, value: 0n, approveToken: USDG, approveAmount: amountIn,
    callData: v.encodeFunctionData({ abi: router02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: USDG, tokenOut: token, fee: best.route.fee, recipient: router, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });
  return base;
}

// ---- Source: Uniswap v4 (pools from PoolManager Initialize logs; swapped on the fork) ---------
const initEvent = v.parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const adapterAbi = v.parseAbi(['function swapExactIn((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint256 amountIn,uint256 minOut) returns (uint256 out,uint256 spent)']);
const v4Pools = new Map<string, any[]>();
async function poolsFor(token: string) {
  const [c0, c1] = BigInt(USDG) < BigInt(token) ? [USDG, v.getAddress(token)] : [v.getAddress(token), USDG];
  const k = c0 + c1; if (v4Pools.has(k)) return v4Pools.get(k)!;
  const logs: any[] = [];
  for (let from = 0n; from <= firstBlock.number; from += 10_000_000n) {
    const to = from + 9_999_999n > firstBlock.number ? firstBlock.number : from + 9_999_999n;
    logs.push(...await remote.getLogs({ address: pm, event: initEvent, args: { currency0: c0, currency1: c1 }, fromBlock: from, toBlock: to }));
  }
  const keys: any[] = logs.map(l => ({ id: l.args.id, key: { currency0: c0, currency1: c1, fee: l.args.fee, tickSpacing: l.args.tickSpacing, hooks: l.args.hooks } }));
  // In-range liquidity of every pool in ONE call (PoolManager.extsload(bytes32[]); pools mapping at slot 6, liquidity at +3).
  const slots = keys.map(p => v.toHex(BigInt(v.keccak256(v.encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [p.id, 6n]))) + 3n, { size: 32 }));
  if (slots.length) {
    const words = await remote.readContract({ address: pm, abi: v.parseAbi(['function extsload(bytes32[]) view returns (bytes32[])']), functionName: 'extsload', args: [slots], blockNumber: firstBlock.number }) as string[];
    keys.forEach((p, i) => { p.liquidity = BigInt(words[i]) & ((1n << 128n) - 1n); });
  }
  v4Pools.set(k, keys); return keys;
}
async function sourceV4(token: string, amount: bigint, probeIn: bigint): Promise<Cand> {
  let pools: any[];
  try { pools = await poolsFor(token); } catch (e) { return { source: 'uniswap-v4', status: 'RPC_ERROR', reason: redact(e) }; }
  if (!pools.length) return { source: 'uniswap-v4', status: 'NO_POOL', target: v4adapter, spender: v4adapter, routerCompatible: true };
  if (!v4Approved) { await send('taker', USDG, erc20, 'approve', [v4adapter, 2n ** 255n]); v4Approved = true; }
  const results: any[] = [];
  const live = pools.filter(p => p.liquidity && p.liquidity > 0n).sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
  (sourceV4 as any).lastScan = { pools: pools.length, withInRangeLiquidity: live.length, feesOfLivePools: live.map(p => p.key.fee) };
  if (!live.length) return { source: 'uniswap-v4', status: 'NO_LIQUIDITY', reason: `${pools.length} pool(s) initialized, none with in-range liquidity`, target: v4adapter, spender: v4adapter, routerCompatible: true };
  for (const p of live.slice(0, 3)) {
    const zeroForOne = p.key.currency0 === USDG;
    const q = async (amt: bigint) => (await client.simulateContract({ account: taker, address: v4adapter, abi: adapterAbi, functionName: 'swapExactIn', args: [p.key, zeroForOne, amt, 0n] })).result as [bigint, bigint];
    try {
      const [o, spent] = await q(amount); const [po] = await q(probeIn);
      const c = finalize({ source: 'uniswap-v4', status: spent < amount ? 'NO_LIQUIDITY' : 'OK', reason: spent < amount ? `partial fill: ${spent} of ${amount}` : undefined, outRaw: o, probeOutRaw: po, route: { poolId: p.id, ...p.key, zeroForOne } }, amount, probeIn);
      results.push(c);
    } catch (e) { results.push({ source: 'uniswap-v4', status: isRpcError(e) ? 'RPC_ERROR' : p.key.hooks !== v.zeroAddress ? 'UNSUPPORTED' : 'NO_LIQUIDITY',
      reason: (p.key.hooks !== v.zeroAddress ? `hooked pool (${p.key.hooks}): ` : '') + redact(errText(e)), route: { poolId: p.id, ...p.key } }); }
  }
  const ok = results.filter(r => r.status === 'OK').sort((a, b) => (b.outRaw > a.outRaw ? 1 : -1));
  const best: Cand = { ...(ok[0] ?? results.find(r => r.status === 'BAD_PRICE') ?? { source: 'uniswap-v4', status: results.some(r => r.status === 'RPC_ERROR') ? 'RPC_ERROR' : 'NO_LIQUIDITY' }) };
  best.target = v4adapter; best.spender = v4adapter; best.routerCompatible = true;
  (best as any).scan = (sourceV4 as any).lastScan;
  (best as any).pools = results.map(r => ({ poolId: r.route?.poolId, fee: r.route?.fee, tickSpacing: r.route?.tickSpacing, hooks: r.route?.hooks, status: r.status, outRaw: r.outRaw, impactBps: r.impactBps, reason: r.reason }));
  (best as any).note = 'executed through a research v4 adapter (caller approves the adapter, which is also the call target). The Universal Router path instead pulls through Permit2: call target != spender.';
  const route = ok[0]?.route;
  if (route) best.routerLeg = async (amountIn: bigint) => ({ target: v4adapter, value: 0n, approveToken: USDG, approveAmount: amountIn,
    callData: v.encodeFunctionData({ abi: adapterAbi, functionName: 'swapExactIn', args: [{ currency0: route.currency0, currency1: route.currency1, fee: route.fee, tickSpacing: route.tickSpacing, hooks: route.hooks }, route.zeroForOne, amountIn, 0n] }) });
  return best;
}

// ---- API sources: the returned calldata is executed on the fork, never broadcast -------------
async function executeOnFork(tx: { to: string; data: string; value?: bigint }, spender: string, amount: bigint, token: string) {
  const snap = await rpc('evm_snapshot');
  try {
    await send('taker', USDG, erc20, 'approve', [spender, amount]);
    const before = await bal(token, taker.address), usdgBefore = await bal(USDG, taker.address);
    const hash = await W.taker.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: 15_000_000n });
    const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('reverted');
    const received = (await bal(token, taker.address)) - before, spent = usdgBefore - (await bal(USDG, taker.address));
    return { received, spent };
  } finally { await rpc('evm_revert', [snap]); v4Approved = false; }
}
async function apiJson(url: string, init: any = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let body: any; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}
const KYBER_CHAIN = arg('--kyber-chain', 'robinhood')!;
async function sourceKyber(token: string, amount: bigint, probeIn: bigint): Promise<Cand> {
  const base = `https://aggregator-api.kyberswap.com/${KYBER_CHAIN}/api/v1`, headers: any = { 'x-client-id': env.KYBER_CLIENT_ID || 'bag-shadow-measure', 'content-type': 'application/json' };
  const build = async (amt: bigint, who: string) => {
    const r = await apiJson(`${base}/routes?tokenIn=${USDG}&tokenOut=${token}&amountIn=${amt}`, { headers });
    if (r.status !== 200 || !r.body?.data?.routeSummary) return { error: r };
    const b = await apiJson(`${base}/route/build`, { method: 'POST', headers, body: JSON.stringify({ routeSummary: r.body.data.routeSummary, sender: who, recipient: who, slippageTolerance: slippageBps }) });
    if (b.status !== 200 || !b.body?.data?.data) return { error: b };
    return { to: b.body.data.routerAddress, data: b.body.data.data, spender: b.body.data.routerAddress, quoted: BigInt(b.body.data.amountOut) };
  };
  try {
    const full: any = await build(amount, taker.address), probe: any = await build(probeIn, taker.address);
    if (full.error) return { source: 'kyberswap', status: /route|not found|4008|4011/i.test(JSON.stringify(full.error.body)) ? 'NO_ROUTE' : 'API_ERROR', reason: `HTTP ${full.error.status}: ${redact(JSON.stringify(full.error.body))}` };
    const ex = await executeOnFork(full, full.spender, amount, token), exp = probe.error ? null : await executeOnFork(probe, probe.spender, probeIn, token);
    const c = finalize({ source: 'kyberswap', status: ex.received > 0n ? 'OK' : 'UNSUPPORTED', reason: ex.received > 0n ? undefined : 'output did not reach the taker (recipient mismatch)',
      outRaw: ex.received, probeOutRaw: exp?.received, target: full.to, spender: full.spender, routerCompatible: full.to.toLowerCase() === full.spender.toLowerCase(), route: { quotedOutRaw: full.quoted } }, amount, probeIn);
    c.routerLeg = async (amountIn: bigint) => { const r: any = await build(amountIn, router); if (r.error) throw new Error('kyber rebuild failed');
      if (r.to.toLowerCase() !== r.spender.toLowerCase()) throw new Error('target != spender'); return { target: r.to, value: 0n, approveToken: USDG, approveAmount: amountIn, callData: r.data }; };
    return c;
  } catch (e) { return { source: 'kyberswap', status: isRpcError(e) ? 'API_ERROR' : 'UNSUPPORTED', reason: redact((e as any)?.message ?? e) }; }
}
async function source0x(token: string, amount: bigint, probeIn: bigint): Promise<Cand> {
  if (!env.ZEROX_API_KEY) return { source: '0x', status: 'NOT_RUN', reason: 'ZEROX_API_KEY not in --env-file' };
  const q = async (amt: bigint, who: string) => {
    const r = await apiJson(`https://api.0x.org/swap/allowance-holder/quote?chainId=4663&sellToken=${USDG}&buyToken=${token}&sellAmount=${amt}&taker=${who}&slippageBps=${slippageBps}`,
      { headers: { '0x-api-key': env.ZEROX_API_KEY, '0x-version': 'v2' } });
    if (r.status !== 200) return { error: r };
    if (r.body?.liquidityAvailable === false) return { noRoute: true };
    const tx = r.body?.transaction; if (!tx?.to) return { error: r };
    return { to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), spender: r.body?.issues?.allowance?.spender ?? tx.to, quoted: BigInt(r.body.buyAmount) };
  };
  try {
    const full: any = await q(amount, taker.address);
    if (full.noRoute) return { source: '0x', status: 'NO_ROUTE' };
    if (full.error) return { source: '0x', status: 'API_ERROR', reason: `HTTP ${full.error.status}: ${redact(JSON.stringify(full.error.body))}` };
    const probe: any = await q(probeIn, taker.address);
    const ex = await executeOnFork(full, full.spender, amount, token), exp = probe.to ? await executeOnFork(probe, probe.spender, probeIn, token) : null;
    const c = finalize({ source: '0x', status: ex.received > 0n ? 'OK' : 'UNSUPPORTED', reason: ex.received > 0n ? undefined : 'output did not reach the taker (recipient mismatch)',
      outRaw: ex.received, probeOutRaw: exp?.received, target: full.to, spender: full.spender, routerCompatible: full.to.toLowerCase() === full.spender.toLowerCase(), route: { quotedOutRaw: full.quoted } }, amount, probeIn);
    c.routerLeg = async (amountIn: bigint) => { const r: any = await q(amountIn, router); if (!r.to) throw new Error('0x requote failed');
      if (r.to.toLowerCase() !== r.spender.toLowerCase()) throw new Error('target != spender'); return { target: r.to, value: r.value, approveToken: USDG, approveAmount: amountIn, callData: r.data }; };
    return c;
  } catch (e) { return { source: '0x', status: isRpcError(e) ? 'API_ERROR' : 'UNSUPPORTED', reason: redact((e as any)?.message ?? e) }; }
}

// ---- Composer (basket-level: one compiled transaction for the whole BAG) ----------------------
async function sourceComposer(graph: any, amount: bigint): Promise<any> {
  if (!env.LIFI_API_KEY) return { source: 'composer', status: 'NOT_RUN', reason: 'LIFI_API_KEY not in --env-file' };
  if (!arg('--sdk')) return { source: 'composer', status: 'NOT_RUN', reason: '--sdk <built packages/bag-sdk> not given' };
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
      const before: Record<string, bigint> = {}; for (const l of graph.legs) before[l.targetAsset.address.toLowerCase()] = await bal(l.targetAsset.address, taker.address);
      const r = await client.waitForTransactionReceipt({ hash: await W.taker.sendTransaction({ to: compiled.transaction.to, data: compiled.transaction.data, value: BigInt(compiled.transaction.value ?? 0), gas: 25_000_000n }) });
      if (r.status !== 'success') throw new Error('composer tx reverted on fork');
      const outs: Record<string, bigint> = {}; for (const l of graph.legs) { const t = l.targetAsset.address.toLowerCase(); outs[t] = (await bal(t, taker.address)) - before[t]; }
      return { source: 'composer', status: 'OK', basketLevel: true, outs, target: compiled.transaction.to, spender: compiled.approvals.map((a: any) => a.spender).join(','),
        routerCompatible: false, reason: 'one Composer program per basket; approvals go to the per-signer proxy, the call to the factory/proxy', priceImpactBps: compiled.quote.priceImpactBps };
    } finally { await rpc('evm_revert', [snap]); v4Approved = false; }
  } catch (e) { return { source: 'composer', status: isRpcError(e) ? 'API_ERROR' : 'UNSUPPORTED', reason: redact((e as any)?.code ? `${(e as any).code}: ${(e as any).message}` : (e as any)?.message ?? e) }; }
}

// ---- Basket: chosen legs through the existing BagExecutionRouter, in call order ---------------
const routerAbi = routerArt.abi;
async function basketThroughRouter(graph: any, graphHash: string, chosen: Map<string, Cand>, isolated: Map<string, bigint>) {
  const missing = graph.legs.filter((l: any) => !chosen.get(l.id));
  if (missing.length) return { status: 'MISSING_LEGS', legs: missing.map((l: any) => symbolOf(l.targetAsset.address)) };
  const snap = await rpc('evm_snapshot');
  try {
    const legs: any[] = []; const minOutputs: any[] = [];
    for (const l of graph.legs) {
      const c = chosen.get(l.id)!; const leg = await c.routerLeg!(BigInt(l.amountRaw));
      await send('keeper', router, routerAbi, 'setAllowedTarget', [leg.target, true]);
      legs.push(leg);
      const iso = isolated.get(l.id)!; minOutputs.push({ token: v.getAddress(l.targetAsset.address), minAmountOut: (iso * BigInt(10000 - slippageBps)) / 10000n });
    }
    for (const t of [USDG, ...graph.legs.map((l: any) => v.getAddress(l.targetAsset.address))]) await send('keeper', router, routerAbi, 'setAllowedToken', [t, true]);
    const inputAmount = graph.legs.reduce((a: bigint, l: any) => a + BigInt(l.amountRaw), 0n);
    const plan = { bagId: v.keccak256(v.toBytes(graph.bagId)), executionPlanHash: ('0x' + graphHash.replace(/^0x/, '').padStart(64, '0')) as `0x${string}`, wallet: taker.address,
      inputToken: USDG, inputAmount, deadline: (await client.getBlock()).timestamp + 600n, legs, minOutputs };
    const signature = await planSigner.signTypedData({ domain: { name: 'BagExecutionRouter', version: '1', chainId: 4663, verifyingContract: router }, primaryType: 'ExecutionPlan',
      types: { ExecutionPlan: [{ name: 'bagId', type: 'bytes32' }, { name: 'executionPlanHash', type: 'bytes32' }, { name: 'wallet', type: 'address' }, { name: 'inputToken', type: 'address' },
        { name: 'inputAmount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'legs', type: 'Leg[]' }, { name: 'minOutputs', type: 'OutputCheck[]' }],
        Leg: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }, { name: 'value', type: 'uint256' }, { name: 'approveToken', type: 'address' }, { name: 'approveAmount', type: 'uint256' }],
        OutputCheck: [{ name: 'token', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }] }, message: plan });
    await send('taker', USDG, erc20, 'approve', [router, inputAmount]);
    try {
      const { result } = await client.simulateContract({ account: taker, address: router, abi: routerAbi, functionName: 'execute', args: [plan, signature] });
      await send('taker', router, routerAbi, 'execute', [plan, signature]);
      const realized = graph.legs.map((l: any, i: number) => { const iso = isolated.get(l.id)!; const got = (result as bigint[])[i];
        return { leg: symbolOf(l.targetAsset.address), source: chosen.get(l.id)!.source, isolatedOutRaw: iso, realizedOutRaw: got, realizedVsIsolatedBps: Number(((got - iso) * 10000n) / iso) }; });
      return { status: 'EXECUTED', router: 'BagExecutionRouter (app main, unchanged)', minOutputRule: `isolated quote - ${slippageBps} bps`, realized };
    } catch (e) { return { status: 'REVERTED', reason: redact(errText(e)) }; }
  } finally { await rpc('evm_revert', [snap]); v4Approved = false; }
}

// =============================================================================================
const report: any = { scope: 'SHADOW_MEASUREMENT_READ_ONLY_FORK', discoveryBlock: firstBlock.number, forks,
  bag: { definitionHash: bag.definitionHash ?? null, ref: bag.ref ?? null, assets: recipe.assets.map((a: any) => ({ symbol: a.symbol, address: a.address, weightBps: a.weightBps })) },
  policy: { ...POLICY, probeDivisor: String(POLICY.probeDivisor), slippageBps }, sources: SOURCES, publicTransactions: 0,
  sourceHashes: { 'measure.ts': createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    'ShadowAdapters.sol': createHash('sha256').update(readFileSync(join(here, 'contracts/ShadowAdapters.sol'))).digest('hex'),
    'BagExecutionRouter.sol (app)': createHash('sha256').update(routerSource).digest('hex') },
  addresses: { poolManager: pm, v3Factory: V3_FACTORY, v3Quoter: V3_QUOTER, v3Router02: V3_ROUTER02, universalRouter: UNIVERSAL_ROUTER }, runs: [] };
const fns: Record<string, (t: string, a: bigint, p: bigint) => Promise<Cand>> = { 'uniswap-v3': sourceV3, 'uniswap-v4': sourceV4, kyberswap: sourceKyber, '0x': source0x };
// Discovery first, while the pinned block is fresh (the public RPC prunes old state).
const graphs = AMOUNTS.map(amt => {
  const amount = v.parseUnits(amt, 6);
  const deposit = calculateDepositAllocation({ bagId: recipe.bagId, inputAsset: { chain: 'robinhood', address: USDG }, amountRaw: amount.toString() }, recipe);
  const graph = buildBagExecutionGraph(buildExecutionPlan(deposit), { wallet: taker.address, chainId: 'robinhood', defaultSlippageBps: slippageBps });
  assertValidExecutionGraph(graph);
  return { amt, amount, graph, graphHash: computeBagExecutionGraphHash(graph) as string, run: { amountUsdg: amt, graphHash: computeBagExecutionGraphHash(graph), legs: [] as any[] } as any,
    chosen: new Map<string, Cand>(), isolated: new Map<string, bigint>() };
});
if (SOURCES.includes('uniswap-v4')) for (const leg of graphs[0].graph.legs) { try { await poolsFor(leg.targetAsset.address); } catch (e) { console.log('v4 discovery failed for', leg.targetAsset.address, redact(errText(e))); } }
try {
// Leg-major: one fresh fork per leg; every source and amount for that leg sees the same block.
for (let i = 0; i < graphs[0].graph.legs.length; i++) {
  const legBlock = await newFork('leg ' + symbolOf(graphs[0].graph.legs[i].targetAsset.address));
  for (const G of graphs) {
    const leg = G.graph.legs[i], amt = G.amt;
    const token = v.getAddress(leg.targetAsset.address), legAmount = BigInt(leg.amountRaw), probeIn = legAmount / POLICY.probeDivisor > 0n ? legAmount / POLICY.probeDivisor : 1n;
    const cands: Cand[] = [];
    for (const s of SOURCES) if (fns[s]) { process.stdout.write(`${amt} USDG  ${symbolOf(token)}  ${s} ... `); const c = await fns[s](token, legAmount, probeIn); console.log(c.status); cands.push(c); }
    const ok = cands.filter(c => c.status === 'OK');
    const best = ok.reduce((m: bigint, c) => (c.outRaw! > m ? c.outRaw! : m), 0n);
    for (const c of ok) c.vsBestBps = best > 0n ? Number(((c.outRaw! - best) * 10000n) / best) : undefined;
    const pick = ok.filter(c => c.routerCompatible && c.routerLeg).sort((a, b) => (b.outRaw! > a.outRaw! ? 1 : -1))[0];
    if (pick) { G.chosen.set(leg.id, pick); G.isolated.set(leg.id, pick.outRaw!); }
    G.run.legs.push({ id: leg.id, symbol: symbolOf(token), token, forkBlock: legBlock, amountRaw: leg.amountRaw, weightBps: leg.weightBps,
      candidates: cands.map(({ routerLeg, ...c }) => c), routerPick: pick?.source ?? null });
  }
}
// Basket: a fresh fork; each chosen route is re-quoted at that block, then all legs go through the
// existing router in call order. The basket compares against these same-block isolated quotes.
for (const G of graphs) {
  G.run.basketForkBlock = await newFork('basket ' + G.amt + ' USDG');
  for (const leg of G.graph.legs) {
    const pick = G.chosen.get(leg.id); if (!pick) continue;
    const legAmount = BigInt(leg.amountRaw), probeIn = legAmount / POLICY.probeDivisor > 0n ? legAmount / POLICY.probeDivisor : 1n;
    const again = await fns[pick.source](v.getAddress(leg.targetAsset.address), legAmount, probeIn);
    if (again.status === 'OK' && again.routerLeg) { G.chosen.set(leg.id, again); G.isolated.set(leg.id, again.outRaw!); } else { G.chosen.delete(leg.id); }
  }
  if (SOURCES.includes('composer')) { process.stdout.write(`${G.amt} USDG  basket  composer ... `); G.run.composer = await sourceComposer(G.graph, G.amount); console.log(G.run.composer.status); }
  process.stdout.write(`${G.amt} USDG  basket through BagExecutionRouter ... `);
  G.run.basket = await basketThroughRouter(G.graph, G.graphHash, G.chosen, G.isolated); console.log(G.run.basket.status);
  report.runs.push(G.run);
}
} catch (e) { report.fatal = redact(errText(e)); console.log('FATAL', report.fatal); for (const G of graphs) if (!report.runs.includes(G.run)) report.runs.push(G.run); }
report.relayRejectedMethods = [...new Set(rejected)];
report.relayStats = relayStats;
// A non-archive RPC prunes the pinned block's state during a long run; those results are RPC_ERROR, never "no liquidity".
report.prunedStateErrors = JSON.stringify(report.runs, (_k, a) => (typeof a === 'bigint' ? a.toString() : a)).split('historical state').length - 1;
if (report.prunedStateErrors) console.log(`NOTE: ${report.prunedStateErrors} result(s) hit pruned state at block ${forkBlock.number}; use an archive-capable ROBINHOOD_RPC_URL.`);
const json = (x: unknown) => JSON.stringify(x, (_k, a) => (typeof a === 'bigint' ? a.toString() : a), 2);
writeFileSync(join(out, 'results.json'), json(report));

// Human summary
const fmt = (x?: bigint, d = 18) => (x === undefined ? '' : Number(v.formatUnits(x, d)).toPrecision(6));
let md = `# Gölge ölçüm\n\nFork blokları: ${forks.map(f => f.label + ' ' + f.blockNumber).join(', ')} · BAG ${bag.ref?.strategyId ?? ''} · kaynaklar: ${SOURCES.join(', ')} · public işlem 0\n\n`;
if (report.prunedStateErrors) md += `> ${report.prunedStateErrors} sonuç, RPC düğümü sabitlenen bloğun durumunu sildiği için RPC_ERROR. Arşiv destekli RPC ile yeniden çalıştırılmalı.\n\n`;
for (const r of report.runs) {
  md += `## ${r.amountUsdg} USDG\n\n| Bacak | ${SOURCES.filter(s => fns[s]).join(' | ')} | Router seçimi |\n|---|${SOURCES.filter(s => fns[s]).map(() => '---').join('|')}|---|\n`;
  for (const l of r.legs) md += `| ${l.symbol} | ${l.candidates.map((c: any) => c.status === 'OK' || c.status === 'BAD_PRICE' ? `${c.status} ${fmt(c.outRaw)}${c.vsBestBps !== undefined ? ` (${c.vsBestBps} bps)` : ''}${c.impactBps !== undefined ? ` · etki ${c.impactBps}` : ''}` : c.status).join(' | ')} | ${l.routerPick ?? '—'} |\n`;
  if (r.composer) md += `\nComposer (sepet): ${r.composer.status}${r.composer.reason ? ' — ' + r.composer.reason : ''}\n`;
  md += `\nSepet, mevcut BagExecutionRouter ile: **${r.basket.status}**${r.basket.legs ? ' — eksik: ' + r.basket.legs.join(', ') : ''}${r.basket.reason ? ' — ' + r.basket.reason : ''}\n`;
  if (r.basket.realized) md += r.basket.realized.map((x: any) => `- ${x.leg} (${x.source}): tek başına ${fmt(x.isolatedOutRaw)} → sepette ${fmt(x.realizedOutRaw)} (${x.realizedVsIsolatedBps} bps)`).join('\n') + '\n';
  md += '\n';
}
writeFileSync(join(out, 'summary.md'), md);
console.log(`\nSHADOW done -> ${out}`);
relay.close(); await connection.close?.();
process.exit(0);
