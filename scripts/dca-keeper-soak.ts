/**
 * DCA v1 keeper soak: the production keeper (lib/dca/keeper + PostgresKeeperStore) against a LOCAL development node,
 * through scripted operational failures and a randomized repeated cycle. Never talks to Robinhood Chain directly:
 * the node must be a Hardhat/EDR/anvil dev node (chain id 31337), either plain or forking Robinhood:
 *
 *   npx hardhat node                                                   # LOCAL mode (mock Uniswap)
 *   npx hardhat node --fork <robinhood rpc> --fork-block-number <n>   # FORK mode (real USDG/TSLA/NVDA, Uniswap v3)
 *
 *   DCA_SOAK_MODE=LOCAL|FORK DCA_SOAK_RPC=http://127.0.0.1:8545 DCA_SOAK_DATABASE_URL=postgres://… \
 *   [DCA_SOAK_PG_RESTART_CMD="docker restart dca-pg"] [DCA_SOAK_CYCLES=10] [DCA_SOAK_SEED=1] npx tsx scripts/dca-keeper-soak.ts
 *
 * Signers are the dev node's unlocked accounts (no private key is read). Writes soak-evidence/<mode>-<time>.json.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  createPublicClient, createWalletClient, custom, http, HttpRequestError, keccak256, parseAbi, stringToHex, toHex, zeroHash,
  type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { DCA_AUTHORIZATION_TYPES, DCA_EXECUTOR_ABI, dcaAuthorizationId, type DcaAuthorization } from '../packages/bag-sdk/src/dca';
import { createViemKeeperChain } from '../lib/dca/keeper/chain';
import { DcaKeeper, type KeeperAlert } from '../lib/dca/keeper/keeper';
import { PostgresKeeperStore } from '../lib/dca/keeper/postgres-store';
import type { KeeperJob } from '../lib/dca/keeper/types';

const MODE = (process.env.DCA_SOAK_MODE ?? 'LOCAL').toUpperCase() as 'LOCAL' | 'FORK';
const RPC = process.env.DCA_SOAK_RPC ?? 'http://127.0.0.1:8545';
const DB = process.env.DCA_SOAK_DATABASE_URL;
const PG_RESTART = process.env.DCA_SOAK_PG_RESTART_CMD;
const CYCLES = Number(process.env.DCA_SOAK_CYCLES ?? 10);
let seed = Number(process.env.DCA_SOAK_SEED ?? 1) >>> 0;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const PERIOD = 3600n;
const T0 = Date.now();
const log = (m: string) => console.log(`[soak +${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROBINHOOD = {
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Hex, TSLA: '0x322f0929c4625ed5bad873c95208d54e1c003b2d' as Hex, NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as Hex,
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Hex, ROUTER: '0xcaf681a66d020601342297493863e78c959e5cb2' as Hex, FACTORY: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Hex,
  QUOTER: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Hex, REGISTRY: '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8' as Hex,
};
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const art = (name: string, dir = name) => JSON.parse(readFileSync(join('artifacts', 'contracts', dir.endsWith('.sol') ? dir : `${dir}.sol`, `${name}.json`), 'utf8'));

// ---------------------------------------------------------------- report
const checks: { phase: string; check: string; ok: boolean; detail?: string }[] = [];
const phases: Record<string, unknown> = {};
const brief = (j: KeeperJob) => `state ${j.state}${j.stateDetail ? ` (${j.stateDetail.slice(0, 80)})` : ''}; runs ${j.confirmed.map((c) => `${c.window}:${c.verification}${c.reorged ? ':reorged' : ''}`).join(',')}; pending ${j.pending ? `${j.pending.nonce}/${j.pending.hash?.slice(0, 10)}` : '-'}; attempts ${j.attempts.map((a) => `${a.window}:${a.outcome}`).join(',')}`;
function check(phase: string, name: string, ok: boolean, detail?: string) {
  checks.push({ phase, check: name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${phase}: ${name}${detail ? ` (${detail})` : ''}`);
}

// ---------------------------------------------------------------- node
const faults = { failNext: 0 };
const base = http(RPC);
const rpcRaw = createPublicClient({ transport: base });
const req = async (method: string, params: unknown[] = []) => {
  try {
    return await rpcRaw.request({ method: method as any, params: params as any });
  } catch (e) {
    throw new Error(`${method}(${JSON.stringify(params).slice(0, 120)}): ${(e as Error).message.split('\n')[0]}`);
  }
};
/** The keeper's transport: injects HTTP failures on demand (temporary RPC outage). */
const faultyTransport = custom({
  async request({ method, params }) {
    if (faults.failNext > 0) {
      faults.failNext--;
      throw new HttpRequestError({ url: 'soak://injected', details: 'injected RPC failure' });
    }
    return rpcRaw.request({ method, params } as any);
  },
});
const mine = () => req('evm_mine');
const automine = (on: boolean) => req('evm_setAutomine', [on]);
const latest = async () => rpcRaw.getBlock({ blockTag: 'latest' });

async function main() {
  const version = String(await req('web3_clientVersion'));
  const chainId = Number(await req('eth_chainId'));
  if (!/hardhat|edr|anvil/i.test(version) || chainId !== 31337) throw new Error(`refusing: not a local dev node (client "${version.slice(0, 40)}", chain ${chainId})`);
  if (!DB) throw new Error('DCA_SOAK_DATABASE_URL is required (a throwaway database; the soak creates the dca_keeper schema)');
  const accounts = (await req('eth_accounts')) as Hex[];
  const [keeperAddr, ownerAddr, owner2Addr, recipientAddr, creatorAddr] = accounts.map((a) => a.toLowerCase() as Hex);
  const wallet = (a: Hex) => createWalletClient({ account: a, transport: base });
  const pc = rpcRaw as unknown as PublicClient;
  const send = async (from: Hex, p: any) => {
    const hash = await wallet(from).writeContract({ ...p, account: from, chain: null });
    if (p.wait !== false) await pc.waitForTransactionReceipt({ hash });
    return hash;
  };
  const deploy = async (name: string, args: unknown[], dir?: string) => {
    const a = art(name, dir);
    const hash = await wallet(keeperAddr).deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: keeperAddr, chain: null });
    return (await pc.waitForTransactionReceipt({ hash })).contractAddress!.toLowerCase() as Hex;
  };
  await automine(true);
  await mine(); // an Orbit fork needs one local block before eth_call (the forked header lacks excess_blob_gas)
  log(`node ${version.slice(0, 30)}, chain ${chainId}, mode ${MODE}`);

  // ---------------------------------------------------------------- deployment
  let usdg: Hex, tsla: Hex, nvda: Hex, router: Hex, v3: Hex, quoter: Hex, registry: Hex;
  if (MODE === 'LOCAL') {
    usdg = await deploy('DcaToken', ['USD Global', 'USDG', 6], 'mocks/dca/DcaV1Mocks.sol');
    tsla = await deploy('DcaToken', ['Tesla', 'TSLA', 18], 'mocks/dca/DcaV1Mocks.sol');
    nvda = await deploy('DcaToken', ['Nvidia', 'NVDA', 18], 'mocks/dca/DcaV1Mocks.sol');
    v3 = await deploy('DcaMockV3Factory', [], 'mocks/dca/DcaV1Mocks.sol');
    router = await deploy('DcaMockSwapRouter02', [v3], 'mocks/dca/DcaV1Mocks.sol');
    quoter = await deploy('DcaMockQuoterV2', [router, v3], 'mocks/dca/DcaV1Mocks.sol');
    registry = await deploy('StrategyRegistry', []);
    const mocks = art('DcaMockSwapRouter02', 'mocks/dca/DcaV1Mocks.sol').abi;
    const fac = art('DcaMockV3Factory', 'mocks/dca/DcaV1Mocks.sol').abi;
    for (const [t, price] of [[tsla, 400n], [nvda, 200n]] as const) {
      await send(keeperAddr, { address: v3, abi: fac, functionName: 'setPool', args: [usdg, t, 3000, '0x0000000000000000000000000000000000003000'] });
      await send(keeperAddr, { address: t, abi: ERC20, functionName: 'mint', args: [router, 10n ** 30n] });
      await send(keeperAddr, { address: router, abi: mocks, functionName: 'setRate', args: [t, 10n ** 18n, price * 1_000_000n] });
    }
    for (const o of [ownerAddr, owner2Addr]) await send(keeperAddr, { address: usdg, abi: ERC20, functionName: 'mint', args: [o, 10_000_000_000n] });
  } else {
    ({ USDG: usdg, TSLA: tsla, NVDA: nvda, ROUTER: router, FACTORY: v3, QUOTER: quoter, REGISTRY: registry } = ROBINHOOD);
    // fund both owners from a USDG/WETH pool's balance on the fork (impersonated; fork-local only)
    const poolAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
    let funded = false;
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = ((await pc.readContract({ address: v3, abi: poolAbi, functionName: 'getPool', args: [usdg, ROBINHOOD.WETH, fee] })) as Hex).toLowerCase() as Hex;
      if (/^0x0{40}$/.test(pool) || ((await pc.readContract({ address: usdg, abi: ERC20, functionName: 'balanceOf', args: [pool] })) as bigint) < 2_000_000_000n) continue;
      await req('hardhat_impersonateAccount', [pool]);
      await req('hardhat_setBalance', [pool, '0xde0b6b3a7640000']);
      for (const o of [ownerAddr, owner2Addr]) await send(pool, { address: usdg, abi: ERC20, functionName: 'transfer', args: [o, 900_000_000n] });
      await req('hardhat_stopImpersonatingAccount', [pool]);
      funded = true;
      break;
    }
    if (!funded) throw new Error('no USDG/WETH pool on the fork can fund the soak owners');
  }
  const adapter = await deploy('UniswapV3ExactInAdapter', [router, v3], 'dca/UniswapV3ExactInAdapter.sol');
  const bagFactory = await deploy('BagFactory', [creatorAddr, creatorAddr, 0n, 10n ** 16n]);
  const executor = await deploy('BagDcaExecutor', [bagFactory, registry, adapter, 'robinhood'], 'dca/BagDcaExecutor.sol');
  const executorCodeHash = keccak256((await pc.getCode({ address: executor }))!);
  const assetsBase = [
    { asset: nvda, symbol: 'NVDA', weightBps: 5000, decimals: 18 },
    { asset: tsla, symbol: 'TSLA', weightBps: 5000, decimals: 18 },
  ];
  const comp = keccak256(stringToHex(assetsBase.map((x) => `robinhood:${x.asset}:${x.symbol}:${x.decimals}:${x.weightBps}`).join('|')));
  const ref = keccak256(toHex('bag:dca-soak'));
  await send(creatorAddr, { address: bagFactory, abi: art('BagFactory').abi, functionName: 'createBag', args: [ref, comp, 'bag:dca-soak', true] });
  const bagId = (await pc.readContract({ address: bagFactory, abi: art('BagFactory').abi, functionName: 'deriveBagId', args: [creatorAddr, ref] })) as Hex;

  // ceilings: LOCAL market 200/400 → 210/420; FORK: QuoterV2 + 5 %
  const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)']);
  const fees: number[] = [];
  const ceilings: bigint[] = [];
  for (const a of assetsBase) {
    let best: { fee: number; out: bigint } | null = null;
    for (const fee of MODE === 'LOCAL' ? [3000] : [100, 500, 3000, 10000]) {
      try {
        const { result } = await pc.simulateContract({ address: quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: usdg, tokenOut: a.asset, amountIn: 5_000_000n, fee, sqrtPriceLimitX96: 0n }] });
        if (!best || result[0] > best.out) best = { fee, out: result[0] };
      } catch { /* no pool */ }
    }
    if (!best) throw new Error(`no quote for ${a.symbol}`);
    fees.push(best.fee);
    ceilings.push(((5_000_000n * 10n ** 18n) / best.out) * 105n / 100n);
  }
  const head0 = await latest();
  const startsAt = head0.timestamp + 120n;
  const chain4663 = 31337;
  const deployment = { chainId: chain4663, executor };
  const mkAuth = (owner: Hex, nonce: bigint, ceilingFactor = 1n, ceilingDiv = 1n): DcaAuthorization => ({
    owner, recipient: recipientAddr, inputToken: usdg, allowedCaller: keeperAddr,
    bag: { bagId, bagVersion: 1n, compositionHash: comp, definitionHash: keccak256(toHex('soak-definition')), strategyId: zeroHash, strategyVersion: 0 },
    assets: assetsBase.map((a, i) => ({ ...a, maxPriceRaw: (ceilings[i] * ceilingFactor) / ceilingDiv })),
    schedule: { amountPerRun: 10_000_000n, totalBudget: 10_000_000n * 40n, maxRuns: 40, startsAt, periodSeconds: PERIOD, expiresAt: startsAt + 40n * PERIOD },
    route: { adapter, swapRouter: router, allowedFees: [...new Set(fees)].sort((x, y) => x - y) },
    nonce,
  });
  const sign = async (a: DcaAuthorization) =>
    (await wallet(a.owner).signTypedData({ account: a.owner, domain: { name: 'BagDcaExecutor', version: '1', chainId: chain4663, verifyingContract: executor }, types: DCA_AUTHORIZATION_TYPES, primaryType: 'DcaAuthorization', message: a as any })) as Hex;
  const authA = mkAuth(ownerAddr, 1n);
  const authB = mkAuth(owner2Addr, 2n);
  const authC = mkAuth(ownerAddr, 3n, 1n, 2n); // ceilings at half the market: every window WAITING_PRICE (missed)
  for (const o of [ownerAddr, owner2Addr]) await send(o, { address: usdg, abi: ERC20, functionName: 'approve', args: [executor, 10n ** 15n] });
  const ids = { A: dcaAuthorizationId(authA, deployment).toLowerCase() as Hex, B: dcaAuthorizationId(authB, deployment).toLowerCase() as Hex, C: dcaAuthorizationId(authC, deployment).toLowerCase() as Hex };
  log(`deployed executor ${executor}, adapter ${adapter}, BAG ${bagId.slice(0, 10)}…; fees ${fees.join('/')}`);

  // ---------------------------------------------------------------- keepers
  const alerts: (KeeperAlert & { worker: string })[] = [];
  const pools: Pool[] = [];
  const mkPool = () => {
    const p = new Pool({ connectionString: DB, max: 5 });
    p.on('error', () => {}); // idle connection lost (database restart): dropped; the next query reconnects
    pools.push(p);
    return p;
  };
  const store0 = new PostgresKeeperStore(mkPool());
  await store0.migrate();
  await mkPool().query('truncate dca_keeper.events, dca_keeper.jobs, dca_keeper.accounts');
  const chainClient = createPublicClient({ transport: faultyTransport });
  const keeperChain = createViemKeeperChain({ publicClient: chainClient as any, walletClient: wallet(keeperAddr) as any, quoter, v3Factory: v3 });
  const tokens = [tsla, nvda];
  const mkKeeper = (holder: string, store = new PostgresKeeperStore(mkPool())) => ({
    holder, store,
    keeper: new DcaKeeper({
      store, chain: keeperChain, mode: 'SEND', holder, executorCodeHash, assetAllowed: (a) => tokens.includes(a.toLowerCase() as Hex),
      leaseMs: 4_000, retryMs: 1_000, replaceAfterMs: 8_000, dropGraceMs: 1_500, pendingTimeoutMs: 20_000, inclusionSlackSeconds: 60n,
      onAlert: (a) => alerts.push({ ...a, worker: holder }),
    }),
  });
  let w1 = mkKeeper('worker-1');
  const w2 = mkKeeper('worker-2');
  for (const [a, s] of [[authA, await sign(authA)], [authB, await sign(authB)], [authC, await sign(authC)]] as const) await w1.keeper.addJob({ authorization: a, ownerSignature: s, deployment });
  const due = async () => {
    for (const j of await store0.list()) await store0.setNextCheck(j.id, 0);
  };
  const tick = async (w: typeof w1) => {
    await due();
    return w.keeper.tick();
  };
  const job = async (id: Hex) => (await store0.get(id))!;
  const executorEvents = async (eventName: 'PurchaseExecuted') =>
    (await pc.getContractEvents({ address: executor, abi: DCA_EXECUTOR_ABI, eventName, fromBlock: 0n, toBlock: 'latest' })) as any[];
  const windowsOnChain = async (id: Hex) => (await executorEvents('PurchaseExecuted')).filter((l) => l.args.authorizationId.toLowerCase() === id).map((l) => BigInt(l.args.window));
  let windowIndex = -1n;
  /** Moves the node to `k` windows after the start (offset grows so the ≥ one-period gap always holds). */
  const goToWindow = async (k: bigint) => {
    const target = startsAt + k * PERIOD + 300n + k * 60n;
    const now = (await latest()).timestamp;
    if (target > now) await req('evm_setNextBlockTimestamp', [Number(target)]);
    await mine();
    windowIndex = k;
  };
  const keeperNonce = async () => pc.getTransactionCount({ address: keeperAddr, blockTag: 'latest' });
  const oneRunPerWindow = async (phase: string, id: Hex) => {
    const w = await windowsOnChain(id);
    check(phase, `at most one PurchaseExecuted per window for ${id.slice(0, 10)}`, new Set(w.map(String)).size === w.length, `windows ${w.join(',')}`);
    return w;
  };

  // ================================================================ scripted phases
  // P1 first scheduled run
  await goToWindow(0n);
  await tick(w1);
  let jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  check('P1 scheduled run', 'window 0 bought and VERIFIED (executor code hash checked)', jA.confirmed.some((c) => c.window === 0n && c.verification === 'VERIFIED' && c.codeChecked === true), JSON.stringify(jA.confirmed.map((c) => [String(c.window), c.verification])));
  check('P1 scheduled run', 'job C (ceilings at half the market) is WAITING_PRICE, nothing sent', (await job(ids.C)).state === 'WAITING_PRICE');

  // P2 keeper restart with a transaction in flight
  await goToWindow(1n);
  await automine(false);
  await tick(w1);
  // the process dies mid-flight: it still holds the leases it took (a real crash never releases them)
  await due();
  await w1.store.claimDue('worker-1', 0, 4_000, 10);
  jA = await job(ids.A);
  const inflight = jA.pending;
  check('P2 restart', 'write-ahead record with nonce and hash stored before the crash', !!inflight?.hash && inflight.nonce >= 0, `nonce ${inflight?.nonce}`);
  w1 = mkKeeper('worker-1-restarted');
  const early = await tick(w1);
  check('P2 restart', 'the restarted keeper cannot take the job while the dead process\'s lease is valid', !early.some((j) => j.id === ids.A));
  await sleep(4_500);
  jA = (await tick(w1)).find((j) => j.id === ids.A)!;
  check('P2 restart', 'after lease expiry the restarted keeper reconciles: tx still in the mempool → waits, sends nothing new', jA.state === 'PENDING_TX' && jA.pending?.nonce === inflight?.nonce && jA.pending?.hash === inflight?.hash);
  await mine();
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  await automine(true);
  check('P2 restart', 'the in-flight purchase recorded once after mining', jA.confirmed.filter((c) => c.window === 1n && !c.reorged).length === 1 && !jA.pending, brief(jA));

  // P3 same window not bought twice
  const n3 = await keeperNonce();
  await tick(w1);
  await tick(w2);
  check('P3 no double purchase', 'no new transaction in an already bought window', (await keeperNonce()) === n3);
  const sigA = (await job(ids.A)).ownerSignature;
  let direct = 'no revert';
  try {
    await pc.simulateContract({ address: executor, abi: DCA_EXECUTOR_ABI, functionName: 'execute', account: keeperAddr, args: [authA as any, { authorizationId: ids.A, window: 1n, deadline: (await latest()).timestamp + 600n, fees, minOutFloors: [] }, sigA] });
  } catch (e) {
    direct = String((e as any)?.cause?.data?.errorName ?? (e as Error).message.split('\n')[0]);
  }
  check('P3 no double purchase', 'a direct second execute in the window is refused by the contract', /NotDue/.test(direct), direct);
  await oneRunPerWindow('P3 no double purchase', ids.A);

  // P4 next period
  await goToWindow(2n);
  await tick(w1);
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  check('P4 next period', 'window 2 bought', jA.confirmed.some((c) => c.window === 2n && c.verification === 'VERIFIED'), brief(jA));

  // P5 dropped transaction
  await goToWindow(3n);
  await automine(false);
  await tick(w1);
  const dropped = (await job(ids.A)).pending!;
  const dropOk = await req('hardhat_dropTransaction', [dropped.hash]);
  await sleep(1_700);
  await tick(w1); // DROPPED → re-sent with a fresh nonce in the same window
  await mine();
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  await automine(true);
  check('P5 dropped', 'node dropped the transaction', dropOk === true);
  check('P5 dropped', 'DROPPED recorded and the window bought by the re-send', jA.attempts.some((a) => a.outcome === 'DROPPED') && jA.confirmed.some((c) => c.window === 3n && !c.reorged));

  // P6 reverted transaction (owner pulls the allowance first in the same block)
  await goToWindow(4n);
  await automine(false);
  await tick(w1);
  const keeperTx = (await job(ids.A)).pending!;
  await wallet(ownerAddr).writeContract({ address: usdg, abi: ERC20, functionName: 'approve', args: [executor, 0n], account: ownerAddr, chain: null, gasPrice: (keeperTx.gasPrice ?? 10n ** 9n) * 10n } as any);
  await mine();
  const rcpt = await pc.getTransactionReceipt({ hash: keeperTx.hash! });
  await automine(true);
  await send(ownerAddr, { address: usdg, abi: ERC20, functionName: 'approve', args: [executor, 10n ** 15n] });
  await tick(w1); // REVERTED recorded → same tick re-sends
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  check('P6 reverted', 'the keeper transaction reverted on chain', rcpt.status === 'reverted');
  check('P6 reverted', 'REVERTED recorded, the window then bought once', jA.attempts.some((a) => a.outcome === 'REVERTED') && jA.confirmed.filter((c) => c.window === 4n && !c.reorged).length === 1);

  // P7 temporary RPC failure
  await goToWindow(5n);
  const n7 = await keeperNonce();
  faults.failNext = 1_000_000; // the RPC is down for the whole tick
  const t7 = await tick(w1);
  faults.failNext = 0;
  check('P7 RPC failure', 'every job RPC_ERROR, nothing sent during the outage', t7.length === 3 && t7.every((j) => j.state === 'RPC_ERROR') && (await keeperNonce()) === n7, t7.map((j) => j.state).join(','));
  check('P7 RPC failure', 'RPC_ERROR alerts raised', alerts.filter((a) => a.kind === 'RPC_ERROR').length >= 3);
  faults.failNext = 0;
  await tick(w1);
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  check('P7 RPC failure', 'recovered: window 5 bought after the outage', jA.confirmed.some((c) => c.window === 5n && !c.reorged));

  // P8 Postgres restart with a write-ahead record
  if (PG_RESTART) {
    await goToWindow(6n);
    await automine(false);
    await tick(w1);
    const wal = (await job(ids.A)).pending!;
    execSync(PG_RESTART, { stdio: 'ignore' });
    let failedDuringRestart = false;
    try {
      await tick(w1);
    } catch {
      failedDuringRestart = true;
    }
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      try {
        await store0.get(ids.A);
        back = true;
      } catch {
        await sleep(500);
      }
    }
    const walAfter = (await job(ids.A)).pending;
    await mine();
    await sleep(4_500); // any lease taken just before the restart expires
    jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
    await automine(true);
    check('P8 Postgres restart', 'database back after the restart', back, failedDuringRestart ? 'ticks failed during the outage (expected)' : 'restart completed between queries');
    check('P8 Postgres restart', 'write-ahead record survived the restart unchanged', walAfter?.hash === wal.hash && walAfter?.nonce === wal.nonce);
    check('P8 Postgres restart', 'the in-flight purchase reconciled once', jA.confirmed.filter((c) => c.window === 6n && !c.reorged).length === 1 && !jA.pending);
  } else {
    check('P8 Postgres restart', 'SKIPPED: DCA_SOAK_PG_RESTART_CMD not set', true);
  }

  // P9 two workers, two jobs, same keeper account
  await goToWindow(7n);
  for (let r = 0; r < 4; r++) await Promise.all([tick(w1), tick(w2)]);
  const wA = await oneRunPerWindow('P9 two workers', ids.A);
  const wB = await oneRunPerWindow('P9 two workers', ids.B);
  check('P9 two workers', 'both jobs bought window 7 exactly once', wA.filter((w) => w === 7n).length === 1 && wB.filter((w) => w === 7n).length === 1);

  // P10 missed windows: two windows with no keeper at all, then C (always above its ceiling)
  await goToWindow(10n); // windows 8 and 9 never observed
  await tick(w1);
  await tick(w1);
  jA = await job(ids.A);
  const missed89 = jA.missed.filter((m) => m.window === 8n || m.window === 9n);
  check('P10 missed windows', 'windows 8 and 9 recorded NOT_OBSERVED for A; never made up', missed89.length === 2 && missed89.every((m) => m.reason === 'NOT_OBSERVED') && !jA.confirmed.some((c) => c.window === 8n || c.window === 9n));
  const jC = await job(ids.C);
  check('P10 missed windows', 'job C: every closed window recorded WAITING_PRICE (or NOT_OBSERVED), no run', jC.confirmed.length === 0 && jC.missed.length >= 9 && jC.missed.filter((m) => m.reason === 'WAITING_PRICE').length >= 5, `${jC.missed.length} missed`);

  // P11 reorg: a recorded run disappears from the chain (evm_revert), the keeper sees it and re-buys
  await goToWindow(11n);
  const snap = await req('evm_snapshot');
  await tick(w1);
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  const before11 = jA.confirmed.filter((c) => c.window === 11n && !c.reorged).length;
  await req('evm_revert', [snap]);
  for (let i = 0; i < 3; i++) await mine();
  await tick(w1);
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  check('P11 reorg', 'run recorded, then marked reorged after its block disappeared', before11 === 1 && jA.confirmed.some((c) => c.window === 11n && c.reorged));
  check('P11 reorg', 'REORG alert raised', alerts.some((a) => a.kind === 'REORG'));
  check('P11 reorg', 'the window bought again on the new chain, exactly one live run', jA.confirmed.filter((c) => c.window === 11n && !c.reorged).length === 1 && (await windowsOnChain(ids.A)).filter((w) => w === 11n).length === 1);

  // P12 stuck transaction replaced with the same nonce
  await goToWindow(12n);
  await automine(false);
  await tick(w1);
  const stuck = (await job(ids.A)).pending!;
  await sleep(8_300);
  await tick(w1);
  const replaced = (await job(ids.A)).pending!;
  await mine();
  jA = (await tick(w1)).find((j) => j.id === ids.A) ?? (await job(ids.A));
  await automine(true);
  check('P12 replacement', 'replacement sent with the same nonce and a higher gas price', replaced.nonce === stuck.nonce && replaced.hash !== stuck.hash && (replaced.gasPrice ?? 0n) > (stuck.gasPrice ?? 0n));
  check('P12 replacement', 'exactly one transaction mined for that nonce, one run', jA.confirmed.filter((c) => c.window === 12n && !c.reorged).length === 1);

  // ================================================================ randomized repeated cycle
  const kinds = ['none', 'drop', 'rpc', 'restartKeeper', 'revert', 'replace', 'twoWorkers', ...(PG_RESTART ? ['pgRestart'] : [])];
  const cycleLog: string[] = [];
  for (let i = 0; i < CYCLES; i++) {
    const k = 13n + BigInt(i);
    if (k >= 39n) break;
    const fault = kinds[Math.floor(rand() * kinds.length)];
    await goToWindow(k);
    try {
      if (fault === 'none') { await tick(w1); }
      else if (fault === 'rpc') { faults.failNext = 1 + Math.floor(rand() * 6); await tick(w1); faults.failNext = 0; await tick(w1); } // a partial outage hits some calls
      else if (fault === 'twoWorkers') { for (let r = 0; r < 3; r++) await Promise.all([tick(w1), tick(w2)]); }
      else if (fault === 'restartKeeper') { await automine(false); await tick(w1); w1 = mkKeeper(`worker-1-r${i}`); await sleep(4_500); await tick(w1); await mine(); await automine(true); }
      else if (fault === 'drop') { await automine(false); await tick(w1); const p = (await store0.list()).flatMap((j) => (j.pending?.hash ? [j.pending.hash] : [])); for (const h of p) await req('hardhat_dropTransaction', [h]); await sleep(1_700); await tick(w1); await mine(); await automine(true); }
      else if (fault === 'replace') { await automine(false); await tick(w1); await sleep(8_300); await tick(w1); await mine(); await automine(true); }
      else if (fault === 'revert') { await automine(false); await tick(w1); await wallet(ownerAddr).writeContract({ address: usdg, abi: ERC20, functionName: 'approve', args: [executor, 0n], account: ownerAddr, chain: null, gasPrice: 10n ** 12n } as any); await mine(); await automine(true); await send(ownerAddr, { address: usdg, abi: ERC20, functionName: 'approve', args: [executor, 10n ** 15n] }); }
      else if (fault === 'pgRestart') { await automine(false); await tick(w1); execSync(PG_RESTART!, { stdio: 'ignore' }); await sleep(3_000); await mine(); await automine(true); await sleep(4_500); }
    } catch (e) {
      cycleLog.push(`window ${k} ${fault}: tick error ${(e as Error).message.split('\n')[0].slice(0, 80)} (retried)`);
    }
    // settle: keep ticking until neither job has a pending record (bounded)
    for (let r = 0; r < 8; r++) {
      try { await tick(w1); } catch { await sleep(1_000); }
      const js = [await job(ids.A), await job(ids.B)];
      if (js.every((j) => !j.pending) && js.every((j) => j.confirmed.some((c) => c.window === k && !c.reorged))) break;
      await mine();
      await sleep(300);
    }
    const a = await job(ids.A);
    const b = await job(ids.B);
    cycleLog.push(`window ${k} ${fault}: A ${a.confirmed.some((c) => c.window === k && !c.reorged) ? 'bought' : 'not bought'}, B ${b.confirmed.some((c) => c.window === k && !c.reorged) ? 'bought' : 'not bought'}`);
  }
  phases.cycle = cycleLog;

  // ================================================================ final invariants
  await automine(true);
  for (let r = 0; r < 3; r++) { await mine(); await tick(w1); }
  for (const [name, id] of Object.entries(ids)) {
    const j = await job(id);
    const onChain = await windowsOnChain(id);
    const live = j.confirmed.filter((c) => !c.reorged);
    const state = (await pc.readContract({ address: executor, abi: DCA_EXECUTOR_ABI, functionName: 'getState', args: [j.authorization.owner, id] })) as any;
    check('final', `${name}: one run per window on chain`, new Set(onChain.map(String)).size === onChain.length);
    check('final', `${name}: keeper record = chain (windows)`, JSON.stringify(live.map((c) => String(c.window)).sort()) === JSON.stringify(onChain.map(String).sort()), `keeper ${live.length}, chain ${onChain.length}`);
    check('final', `${name}: chain counter = PurchaseExecuted count`, Number(state.runs) === onChain.length);
    check('final', `${name}: every live run VERIFIED with the code hash`, live.every((c) => c.verification === 'VERIFIED' && c.codeChecked));
    check('final', `${name}: no unresolved write-ahead record`, !j.pending);
    const bought = new Set(live.map((c) => String(c.window)));
    const missed = new Set(j.missed.map((m) => String(m.window)));
    const overlap = [...bought].filter((w) => missed.has(w));
    const gaps = [];
    for (let w = 0n; w < j.accountedThrough; w++) if (!bought.has(String(w)) && !missed.has(String(w))) gaps.push(w);
    check('final', `${name}: every closed window is bought or recorded missed, never both`, overlap.length === 0 && gaps.length === 0, `accounted through ${j.accountedThrough}, bought ${bought.size}, missed ${missed.size}`);
    phases[`job${name}`] = { runs: live.length, windows: onChain.map(String), missed: j.missed.map((m) => `${m.window}:${m.reason}`), attempts: j.attempts.map((a) => `${a.window}:${a.outcome}`) };
  }
  const events = await store0.events(ids.A);
  check('final', 'Postgres append-only log holds the runs and the missed windows', events.filter((e) => e.kind === 'RUN').length >= (await windowsOnChain(ids.A)).length && events.some((e) => e.kind === 'MISSED_WINDOW'));

  const report = {
    schema: 'bag-dca-keeper-soak/v1', mode: MODE, evidenceClass: MODE === 'FORK' ? 'TEST_KEY_FORK (local dev node forking Robinhood; nothing broadcast)' : 'LOCAL_NODE (mock Uniswap)',
    commit: execSync('git rev-parse HEAD').toString().trim(), node: version.slice(0, 40), postgresRestart: PG_RESTART ? 'ran' : 'skipped',
    cycles: CYCLES, seed: Number(process.env.DCA_SOAK_SEED ?? 1), durationS: Math.round((Date.now() - T0) / 1000),
    passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length,
    alerts: Object.entries(alerts.reduce((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {} as Record<string, number>)),
    checks, phases,
  };
  mkdirSync('soak-evidence', { recursive: true });
  const file = join('soak-evidence', `${MODE.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  log(`report ${file}: ${report.passed} passed, ${report.failed} failed`);
  await Promise.allSettled(pools.map((p) => p.end()));
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`soak aborted: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`);
  process.exit(2);
});
