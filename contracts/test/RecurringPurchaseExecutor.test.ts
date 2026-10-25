import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre, { network } from 'hardhat';
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  pad,
  parseSignature,
  toEventSelector,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Hex,
} from 'viem';
import { splitByWeight } from '../../packages/bag-sdk/src/split';
import { RECURRING_EXECUTOR_ABI, recurringAuthorizationId, recurringCompositionHash, recurringLegAmounts, recurringMinimumOutputs, verifyRecurringPurchase } from '../../packages/bag-sdk/src/recurring';
import { withReceiptEvidence } from '../../packages/bag-sdk/src/adapters/receipt-rpc';

// -----------------------------------------------------------------------------
// RecurringPurchaseExecutor on Hardhat's in-process EVM: the REAL BagFactory,
// StrategyRegistry and BagExecutionRouter, with local stand-ins for the token
// (DcaTestToken, EIP-2612), the DEX (DcaMockSwapRouter02, SwapRouter02 call
// shape) and a delegating smart account (DcaMockSmartAccount + mock
// DelegationManager). NOT a real-chain test: contracts/test/fork/ runs the same
// contract against the real Robinhood Chain contracts on a fork.
//
// The point of most cases is a HOSTILE planSigner/keeper: every router plan it
// could sign that widens a signed limit must be refused, and every refused or
// failed purchase must leave the counters, balances and allowances unchanged.
// -----------------------------------------------------------------------------

const PERIOD = 3600n;
const GROSS = 5_000_000n; // 5 USDG (6 decimals)
/** The BAG app's composition hash (rows `chain:address:symbol:decimals:weightBps`, lowercase address, joined by `|`) in the given order. */
const compositionOf = (assets: readonly { asset: Hex; symbol: string; decimals: number; weightBps: number }[]) =>
  keccak256(toHex(assets.map((a) => `robinhood:${a.asset.toLowerCase()}:${a.symbol}:${a.decimals}:${a.weightBps}`).join('|')));
const DEFINITION = keccak256(toHex('bag.json v1 definition'));
const OFF_CHAIN_REF = pad('0x955df6e0', { size: 32 });

const AUTH_TYPES = {
  Authorization: [
    { name: 'owner', type: 'address' },
    { name: 'sourceAccount', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'fundingKind', type: 'uint8' },
    { name: 'fundingContract', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'bag', type: 'BagRef' },
    { name: 'assets', type: 'AssetLimit[]' },
    { name: 'schedule', type: 'Schedule' },
    { name: 'route', type: 'Route' },
    { name: 'nonce', type: 'uint256' },
  ],
  AssetLimit: [
    { name: 'asset', type: 'address' },
    { name: 'symbol', type: 'string' },
    { name: 'weightBps', type: 'uint16' },
    { name: 'decimals', type: 'uint8' },
    { name: 'maxPriceRaw', type: 'uint256' },
  ],
  BagRef: [
    { name: 'bagId', type: 'bytes32' },
    { name: 'bagVersion', type: 'uint256' },
    { name: 'compositionHash', type: 'bytes32' },
    { name: 'definitionHash', type: 'bytes32' },
    { name: 'strategyId', type: 'bytes32' },
    { name: 'strategyVersion', type: 'uint32' },
  ],
  Route: [
    { name: 'router', type: 'address' },
    { name: 'swapTarget', type: 'address' },
    { name: 'allowedFees', type: 'uint24[]' },
  ],
  Schedule: [
    { name: 'grossAmountPerRun', type: 'uint256' },
    { name: 'totalBudget', type: 'uint256' },
    { name: 'maxExecutions', type: 'uint32' },
    { name: 'startsAt', type: 'uint64' },
    { name: 'periodSeconds', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

const PLAN_TYPES = {
  ExecutionPlan: [
    { name: 'bagId', type: 'bytes32' },
    { name: 'executionPlanHash', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'inputAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'legs', type: 'Leg[]' },
    { name: 'minOutputs', type: 'OutputCheck[]' },
  ],
  Leg: [
    { name: 'target', type: 'address' },
    { name: 'callData', type: 'bytes' },
    { name: 'value', type: 'uint256' },
    { name: 'approveToken', type: 'address' },
    { name: 'approveAmount', type: 'uint256' },
  ],
  OutputCheck: [
    { name: 'token', type: 'address' },
    { name: 'minAmountOut', type: 'uint256' },
  ],
} as const;

const SWAP_ROUTER_02_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const ERC20_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

type AssetLimit = { asset: Hex; symbol: string; weightBps: number; decimals: number; maxPriceRaw: bigint };
type Authorization = {
  owner: Hex;
  sourceAccount: Hex;
  recipient: Hex;
  fundingKind: number;
  fundingContract: Hex;
  inputToken: Hex;
  bag: { bagId: Hex; bagVersion: bigint; compositionHash: Hex; definitionHash: Hex; strategyId: Hex; strategyVersion: number };
  assets: AssetLimit[];
  schedule: { grossAmountPerRun: bigint; totalBudget: bigint; maxExecutions: number; startsAt: bigint; periodSeconds: bigint; expiresAt: bigint };
  route: { router: Hex; swapTarget: Hex; allowedFees: number[] };
  nonce: bigint;
};
type Leg = { target: Hex; callData: Hex; value: bigint; approveToken: Hex; approveAmount: bigint };
type Plan = {
  bagId: Hex;
  executionPlanHash: Hex;
  wallet: Hex;
  inputToken: Hex;
  inputAmount: bigint;
  deadline: bigint;
  legs: Leg[];
  minOutputs: { token: Hex; minAmountOut: bigint }[];
};

/** Collects every message in a viem error chain, so a revert can be matched by error name or selector. */
function errorText(e: any): string {
  const parts: string[] = [];
  for (let x = e; x; x = x.cause) parts.push(String(x.shortMessage ?? ''), String(x.details ?? ''), String(x.message ?? ''), String(x.data?.errorName ?? ''), String(x.signature ?? ''));
  return parts.join(' | ');
}

async function expectRevert(p: Promise<unknown>, error: string, signature?: string) {
  try {
    await p;
  } catch (e) {
    const text = errorText(e);
    const ok = text.includes(error) || (signature !== undefined && text.includes(toFunctionSelector(signature)));
    assert.ok(ok, `expected ${error}, got: ${text.slice(0, 600)}`);
    return;
  }
  assert.fail(`expected revert ${error}, but the call succeeded`);
}

async function setup() {
  const connection = await network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer, owner, keeper, planSigner, creator, attacker, keeper2, recipient] = await viem.getWalletClients();
  const rpc = (method: string, params: unknown[] = []) => connection.provider.request({ method, params });

  const usdg = await viem.deployContract('DcaTestToken', ['Global Dollar', 'USDG', 6]);
  const gme = await viem.deployContract('DcaTestToken', ['GameStop', 'GME', 18]);
  const aapl = await viem.deployContract('DcaTestToken', ['Apple', 'AAPL', 18]);
  const dex = await viem.deployContract('DcaMockSwapRouter02', []);
  // 25 USDG per GME and 200 USDG per AAPL: out = in * 1e18 / price
  await dex.write.setRate([gme.address, 10n ** 18n, 25_000_000n]);
  await dex.write.setRate([aapl.address, 10n ** 18n, 200_000_000n]);
  await gme.write.mint([dex.address, 10n ** 30n]);
  await aapl.write.mint([dex.address, 10n ** 30n]);

  // The BAG's registered content: the executor requires the signed asset list to reproduce this hash.
  const ASSETS: AssetLimit[] = [
    { asset: gme.address, symbol: 'GME', weightBps: 6000, decimals: 18, maxPriceRaw: 30_000_000n },
    { asset: aapl.address, symbol: 'AAPL', weightBps: 4000, decimals: 18, maxPriceRaw: 250_000_000n },
  ];
  const COMPOSITION = compositionOf(ASSETS);
  const factory = await viem.deployContract('BagFactory', [deployer.account.address, deployer.account.address, 0n, 0n]);
  const factoryAsCreator = await viem.getContractAt('BagFactory', factory.address, { client: { wallet: creator } });
  await factoryAsCreator.write.createBag([OFF_CHAIN_REF, COMPOSITION, 'ipfs://bag', true]);
  const bagId = (await factory.read.deriveBagId([creator.account.address, OFF_CHAIN_REF])) as Hex;

  const registry = await viem.deployContract('StrategyRegistry', []);
  const registryAsCreator = await viem.getContractAt('StrategyRegistry', registry.address, { client: { wallet: creator } });
  await registryAsCreator.write.registerStrategy([OFF_CHAIN_REF, DEFINITION, 'ipfs://definition']);
  const strategyId = (await registry.read.deriveStrategyId([creator.account.address, OFF_CHAIN_REF])) as Hex;

  const router = await viem.deployContract('BagExecutionRouter', [factory.address, deployer.account.address, planSigner.account.address]);
  await router.write.setAllowedTarget([dex.address, true]);
  // A second swap contract the ROUTER OWNER also allowlisted: valid call shape, but not the one the owner signed.
  const dex2 = await viem.deployContract('DcaMockSwapRouter02', []);
  await dex2.write.setRate([gme.address, 10n ** 18n, 25_000_000n]);
  await dex2.write.setRate([aapl.address, 10n ** 18n, 200_000_000n]);
  await gme.write.mint([dex2.address, 10n ** 30n]);
  await aapl.write.mint([dex2.address, 10n ** 30n]);
  await router.write.setAllowedTarget([dex2.address, true]);
  for (const t of [usdg, gme, aapl]) await router.write.setAllowedToken([t.address, true]);

  const executor = await viem.deployContract('RecurringPurchaseExecutor', [factory.address, registry.address, 'robinhood']);
  const asKeeper = await viem.getContractAt('RecurringPurchaseExecutor', executor.address, { client: { wallet: keeper } });
  const asOwner = await viem.getContractAt('RecurringPurchaseExecutor', executor.address, { client: { wallet: owner } });
  const asAttacker = await viem.getContractAt('RecurringPurchaseExecutor', executor.address, { client: { wallet: attacker } });

  await usdg.write.mint([owner.account.address, 1_000_000_000n]);
  const usdgAsOwner = await viem.getContractAt('DcaTestToken', usdg.address, { client: { wallet: owner } });

  const chainId = await publicClient.getChainId();
  const now = async () => (await publicClient.getBlock()).timestamp;
  const at = async (t: bigint) => {
    await rpc('evm_setNextBlockTimestamp', [Number(t)]);
  };
  const startsAt = (await now()) + 1000n;

  function auth(over: Partial<Authorization> & { schedule?: Partial<Authorization['schedule']>; bag?: Partial<Authorization['bag']> } = {}): Authorization {
    const schedule = { grossAmountPerRun: GROSS, totalBudget: GROSS * 3n, maxExecutions: 3, startsAt, periodSeconds: PERIOD, expiresAt: startsAt + 3n * PERIOD, ...(over.schedule ?? {}) };
    const bag = { bagId, bagVersion: 1n, compositionHash: COMPOSITION, definitionHash: DEFINITION, strategyId, strategyVersion: 1, ...(over.bag ?? {}) };
    const { schedule: _s, bag: _b, ...rest } = over;
    return {
      owner: owner.account.address,
      sourceAccount: owner.account.address,
      recipient: owner.account.address,
      fundingKind: 0,
      fundingContract: usdg.address,
      inputToken: usdg.address,
      assets: ASSETS.map((x) => ({ ...x })),
      route: { router: router.address, swapTarget: dex.address, allowedFees: [500, 3000] },
      nonce: 1n,
      ...rest,
      schedule,
      bag,
    };
  }

  const domain = { name: 'BagRecurringPurchase', version: '1', chainId, verifyingContract: executor.address } as const;
  const sign = (a: Authorization, signer = owner, verifyingContract: Hex = executor.address) =>
    signer.signTypedData({ domain: { ...domain, verifyingContract }, types: AUTH_TYPES, primaryType: 'Authorization', message: a });
  const idOf = (a: Authorization) => hashTypedData({ domain, types: AUTH_TYPES, primaryType: 'Authorization', message: a });

  const swapCall = (tokenOut: Hex, amountIn: bigint, over: Partial<{ recipient: Hex; fee: number; sqrtPriceLimitX96: bigint; tokenIn: Hex; amountOutMinimum: bigint }> = {}) =>
    encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: over.tokenIn ?? usdg.address,
          tokenOut,
          fee: over.fee ?? 3000,
          recipient: over.recipient ?? router.address,
          amountIn,
          amountOutMinimum: over.amountOutMinimum ?? 0n,
          sqrtPriceLimitX96: over.sqrtPriceLimitX96 ?? 0n,
        },
      ],
    });

  let planNonce = 0;
  /** A router plan that is exactly the signed purchase; `tweak` lets a test play a hostile planSigner. */
  async function plan(a: Authorization, tweak: (p: Plan, legIn: bigint[], minOut: bigint[]) => void = () => {}) {
    const legIn = (await executor.read.legAmounts([a.schedule.grossAmountPerRun, a.assets])) as bigint[];
    const minOut = (await executor.read.minimumOutputs([a.schedule.grossAmountPerRun, a.assets])) as bigint[];
    const p: Plan = {
      bagId: a.bag.bagId,
      executionPlanHash: keccak256(toHex(`plan-${planNonce++}`)),
      wallet: executor.address,
      inputToken: a.inputToken,
      inputAmount: a.schedule.grossAmountPerRun,
      deadline: (await now()) + 100_000n,
      legs: a.assets.map((l, i) => ({ target: dex.address, callData: swapCall(l.asset, legIn[i]), value: 0n, approveToken: a.inputToken, approveAmount: legIn[i] })),
      minOutputs: a.assets.map((l, i) => ({ token: l.asset, minAmountOut: minOut[i] })),
    };
    tweak(p, legIn, minOut);
    const planSignature = await planSigner.signTypedData({
      domain: { name: 'BagExecutionRouter', version: '1', chainId, verifyingContract: router.address },
      types: PLAN_TYPES,
      primaryType: 'ExecutionPlan',
      message: p,
    });
    return { p, planSignature, legIn, minOut };
  }

  async function execution(a: Authorization, window: bigint, tweak?: Parameters<typeof plan>[1], over: Partial<{ authorizationId: Hex; quoteDeadline: bigint }> = {}, planAuth?: Authorization) {
    const { p, planSignature } = await plan(planAuth ?? a, tweak);
    return { authorizationId: over.authorizationId ?? idOf(a), window, quoteDeadline: over.quoteDeadline ?? (await now()) + 100_000n, plan: p, planSignature };
  }

  async function run(a: Authorization, sig: Hex, window: bigint, opts: { tweak?: Parameters<typeof plan>[1]; fundingProof?: Hex; as?: typeof asKeeper; over?: Partial<{ authorizationId: Hex; quoteDeadline: bigint }>; planAuth?: Authorization } = {}) {
    const x = await execution(a, window, opts.tweak, opts.over, opts.planAuth);
    const c = opts.as ?? asKeeper;
    const hash = await c.write.execute([a, x, sig, opts.fundingProof ?? '0x'], { gas: 3_000_000n });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  const bal = (token: { read: { balanceOf: (args: [Hex]) => Promise<unknown> } }, who: Hex) => token.read.balanceOf([who]) as Promise<bigint>;
  async function snapshot(a: Authorization) {
    const id = idOf(a);
    return {
      state: await executor.read.getState([a.owner, id]),
      ownerUsdg: await bal(usdg, a.sourceAccount),
      recipientGme: await bal(gme, a.recipient),
      recipientAapl: await bal(aapl, a.recipient),
      executorUsdg: await bal(usdg, executor.address),
      executorGme: await bal(gme, executor.address),
      routerUsdg: await bal(usdg, router.address),
      routerAllowance: (await usdg.read.allowance([executor.address, router.address])) as bigint,
    };
  }

  async function permitProof(value: bigint, deadline: bigint, signer = owner) {
    const nonce = (await usdg.read.nonces([signer.account.address])) as bigint;
    const signature = await signer.signTypedData({
      domain: { name: 'Global Dollar', version: '1', chainId, verifyingContract: usdg.address },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: { owner: signer.account.address, spender: executor.address, value, nonce, deadline },
    });
    const { r, s, yParity } = parseSignature(signature);
    const v = yParity + 27;
    return {
      proof: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [value, deadline, v, r, s]),
      args: [signer.account.address, executor.address, value, deadline, v, r, s] as const,
    };
  }

  return {
    viem, publicClient, rpc, owner, keeper, keeper2, planSigner, creator, attacker, recipient, deployer,
    usdg, usdgAsOwner, gme, aapl, dex, dex2, factory, factoryAsCreator, registry, router, executor, asKeeper, asOwner, asAttacker,
    startsAt, now, at, auth, sign, idOf, plan, execution, run, snapshot, bal, permitProof, swapCall, domain, chainId, ASSETS, COMPOSITION,
  };
}

describe('RecurringPurchaseExecutor — identity and split', () => {
  it('authorizationIdOf equals the EIP-712 digest a wallet signs (nested BagRef/AssetLimit/Schedule/Route)', async () => {
    const t = await setup();
    const a = t.auth();
    assert.equal(await t.executor.read.authorizationIdOf([a]), t.idOf(a));
    assert.equal(await t.executor.read.domainSeparator(), keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toHex('BagRecurringPurchase')), keccak256(toHex('1')), BigInt(t.chainId), t.executor.address],
    )));
    // any field change changes the id
    for (const b of [t.auth({ recipient: t.attacker.account.address }), t.auth({ nonce: 2n }), t.auth({ schedule: { maxExecutions: 4, totalBudget: GROSS * 4n } }), t.auth({ route: { router: t.router.address, swapTarget: t.dex.address, allowedFees: [3000] } })]) {
      assert.notEqual(await t.executor.read.authorizationIdOf([b]), t.idOf(a));
    }
  });

  it('the SDK (packages/bag-sdk recurring.ts) computes the same id, split and minimums as the contract', async () => {
    const t = await setup();
    for (const a of [t.auth(), t.auth({ schedule: { grossAmountPerRun: 7_777_777n, totalBudget: 7_777_777n * 3n } }), t.auth({ recipient: t.attacker.account.address, nonce: 42n })]) {
      assert.equal(recurringAuthorizationId(a, { chainId: t.chainId, executor: t.executor.address }), await t.executor.read.authorizationIdOf([a]));
      assert.deepEqual(recurringLegAmounts(a), await t.executor.read.legAmounts([a.schedule.grossAmountPerRun, a.assets]));
      assert.deepEqual(recurringMinimumOutputs(a), await t.executor.read.minimumOutputs([a.schedule.grossAmountPerRun, a.assets]));
    }
  });

  it('legAmounts reproduces the SDK splitByWeight exactly (largest remainder, ties by address)', async () => {
    const t = await setup();
    const addresses = [t.gme.address, t.aapl.address, t.usdg.address, t.dex.address].map((x) => x as Hex);
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let c = 0; c < 60; c++) {
      const n = 2 + rnd(3);
      const weights: number[] = [];
      let left = 10_000;
      for (let i = 0; i < n - 1; i++) {
        const w = 1 + rnd(left - (n - 1 - i));
        weights.push(w);
        left -= w;
      }
      weights.push(left);
      const assets = weights.map((w, i) => ({ asset: addresses[i], symbol: `T${i}`, weightBps: w, decimals: 18, maxPriceRaw: 1n }));
      const amount = BigInt(1 + rnd(1_000_000_007));
      const onchain = (await t.executor.read.legAmounts([amount, assets])) as bigint[];
      const sdk = splitByWeight(amount, { assets: assets.map((x) => ({ chain: 'robinhood', address: x.asset, weightBps: x.weightBps, decimals: 18 })) as any });
      assert.deepEqual(onchain, assets.map((x) => sdk.get(`robinhood:${x.asset.toLowerCase()}`)), `case ${c}: amount ${amount} weights ${weights}`);
      assert.equal(onchain.reduce((s, x) => s + x, 0n), amount);
    }
  });

  it('minimumOutputs = ceil(legInput × 10^decimals / maxPrice), and checks decimals on chain', async () => {
    const t = await setup();
    const a = t.auth();
    const legIn = (await t.executor.read.legAmounts([GROSS, a.assets])) as bigint[];
    const min = (await t.executor.read.minimumOutputs([GROSS, a.assets])) as bigint[];
    assert.deepEqual(min, [(legIn[0] * 10n ** 18n + 30_000_000n - 1n) / 30_000_000n, (legIn[1] * 10n ** 18n + 250_000_000n - 1n) / 250_000_000n]);
    await expectRevert(t.executor.read.minimumOutputs([GROSS, [{ ...a.assets[0], decimals: 6 }, a.assets[1]]]), 'AssetDecimalsMismatch');
  });
});

describe('RecurringPurchaseExecutor — calendar, budget and delivery', () => {
  it('window 0: exact debit from the owner EOA, outputs to the recipient, nothing left in executor or router', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await expectRevert(t.run(a, sig, 0n), 'NotDue');
    await t.at(t.startsAt);
    const before = await t.snapshot(a);
    const r = await t.run(a, sig, 0n);
    assert.equal(r.status, 'success');
    const after = await t.snapshot(a);
    assert.equal(before.ownerUsdg - after.ownerUsdg, GROSS, 'owner debit is exactly one run');
    const legIn = (await t.executor.read.legAmounts([GROSS, a.assets])) as bigint[];
    assert.equal(after.recipientGme - before.recipientGme, (legIn[0] * 10n ** 18n) / 25_000_000n);
    assert.equal(after.recipientAapl - before.recipientAapl, (legIn[1] * 10n ** 18n) / 200_000_000n);
    assert.equal(after.executorUsdg, 0n);
    assert.equal(after.executorGme, 0n);
    assert.equal(after.routerUsdg, 0n);
    assert.equal(after.routerAllowance, 0n);
    assert.deepEqual(after.state, { executions: 1, grossUsed: GROSS, lastWindow: 0n, lastExecutionAt: after.state.lastExecutionAt, revoked: false });
    const events = await t.executor.getEvents.PurchaseExecuted();
    assert.equal(events.length, 1);
    assert.equal(events[0].args.authorizationId, t.idOf(a));
    assert.equal(events[0].args.sourceDebit, GROSS);
  });

  it('one purchase per calendar window, no accumulation of missed windows, expiry ends it', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt + 10n);
    await t.run(a, sig, 0n);
    const s0 = await t.snapshot(a);
    await expectRevert(t.run(a, sig, 0n), 'NotDue'); // same window
    assert.deepEqual(await t.snapshot(a), s0);
    // window 1 is skipped entirely; in window 2 only ONE purchase is possible
    await t.at(t.startsAt + 2n * PERIOD + 5n);
    await expectRevert(t.run(a, sig, 1n), 'WrongWindow'); // a quote built for the missed window cannot be used late
    await t.run(a, sig, 2n);
    await expectRevert(t.run(a, sig, 2n), 'NotDue');
    const s2 = await t.snapshot(a);
    assert.equal(s2.state.executions, 2);
    assert.equal(s2.state.grossUsed, 2n * GROSS);
    await t.at(a.schedule.expiresAt);
    await expectRevert(t.run(a, sig, 3n), 'Expired');
    assert.deepEqual(await t.snapshot(a), s2);
  });

  it('run count and total budget: the (maxExecutions+1)th purchase is refused even before expiry', async () => {
    const t = await setup();
    const a = t.auth({ schedule: { maxExecutions: 2, totalBudget: 2n * GROSS, expiresAt: t.startsAt + 10n * PERIOD } });
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, 100n * GROSS]); // more allowance than the budget
    for (const w of [0n, 1n]) {
      await t.at(t.startsAt + w * PERIOD);
      await t.run(a, sig, w);
    }
    await t.at(t.startsAt + 2n * PERIOD);
    const s = await t.snapshot(a);
    await expectRevert(t.run(a, sig, 2n), 'Exhausted');
    assert.deepEqual(await t.snapshot(a), s);
    assert.equal(s.state.grossUsed, a.schedule.totalBudget);
  });

  it('a stale quote (deadline passed) or a quote for another window is refused', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt + 100n);
    await expectRevert(t.run(a, sig, 0n, { over: { quoteDeadline: t.startsAt + 50n } }), 'QuoteExpired');
    await expectRevert(t.run(a, sig, 1n), 'WrongWindow');
  });
});

describe('RecurringPurchaseExecutor — revocation', () => {
  it('the owner revokes; nobody else can revoke for them; a revoked id stays dead even if allowance or a permit comes back (V-A3/V-A4)', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    const id = t.idOf(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    await t.run(a, sig, 0n);

    await t.asAttacker.write.revoke([id]); // attacker's own namespace
    assert.equal((await t.executor.read.getState([a.owner, id])).revoked, false);

    await t.asOwner.write.revoke([id]);
    assert.equal((await t.executor.read.getState([a.owner, id])).revoked, true);
    await t.at(t.startsAt + PERIOD);
    await expectRevert(t.run(a, sig, 1n), 'RevokedAuthorization');

    // V-A4: a fresh approve does not revive it; V-A3: neither does a permit submitted later
    await t.usdgAsOwner.write.approve([t.executor.address, 10n ** 12n]);
    await expectRevert(t.run(a, sig, 1n), 'RevokedAuthorization');
    const p = await t.permitProof(10n ** 12n, t.startsAt + 100n * PERIOD);
    await expectRevert(t.run(a, sig, 1n, { fundingProof: p.proof }), 'RevokedAuthorization');
  });

  it('an authorization can be revoked before it ever ran, gaslessly through revokeBySig submitted by anyone', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    const id = t.idOf(a);
    const revocation = await t.owner.signTypedData({
      domain: t.domain,
      types: { Revocation: [{ name: 'owner', type: 'address' }, { name: 'authorizationId', type: 'bytes32' }] },
      primaryType: 'Revocation',
      message: { owner: a.owner, authorizationId: id },
    });
    await expectRevert(t.asAttacker.write.revokeBySig([t.attacker.account.address, id, revocation]), 'InvalidOwnerSignature');
    await t.asKeeper.write.revokeBySig([a.owner, id, revocation]);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    await expectRevert(t.run(a, sig, 0n), 'RevokedAuthorization');
  });
});

describe('RecurringPurchaseExecutor — the planSigner cannot widen a signed limit', () => {
  const cases: { name: string; error: string; tweak: (p: Plan, legIn: bigint[], minOut: bigint[], t: Awaited<ReturnType<typeof setup>>) => void }[] = [
    { name: 'router minimums below the owner price limit', error: 'RouteViolation', tweak: (p) => (p.minOutputs[0].minAmountOut -= 1n) },
    { name: 'swap output sent to the attacker instead of the router', error: 'RouteViolation', tweak: (p, legIn, _m, t) => (p.legs[0].callData = t.swapCall(t.gme.address, legIn[0], { recipient: t.attacker.account.address })) },
    { name: 'a different leg amount than the signed split', error: 'RouteViolation', tweak: (p, legIn, _m, t) => (p.legs[0].callData = t.swapCall(t.gme.address, legIn[0] - 1n)) },
    { name: 'approval larger than the leg', error: 'RouteViolation', tweak: (p) => (p.legs[0].approveAmount += 1n) },
    { name: 'another swap contract the router owner allowlisted (valid call shape)', error: 'RouteViolation', tweak: (p, _l, _m, t) => (p.legs[0].target = t.dex2.address) },
    { name: 'leg target is the input token: transferFrom(owner, attacker)', error: 'RouteViolation', tweak: (p, _l, _m, t) => (p.legs[0] = { ...p.legs[0], target: t.usdg.address, callData: encodeFunctionData({ abi: ERC20_TRANSFER_FROM_ABI, functionName: 'transferFrom', args: [t.owner.account.address, t.attacker.account.address, 10n ** 9n] }) }) },
    { name: 'another BAG', error: 'PlanMismatch', tweak: (p) => (p.bagId = keccak256(toHex('other bag'))) },
    { name: 'the owner as router wallet (router would pull from the owner directly)', error: 'PlanMismatch', tweak: (p, _l, _m, t) => (p.wallet = t.owner.account.address) },
    { name: 'a larger input amount', error: 'PlanMismatch', tweak: (p) => (p.inputAmount += 1n) },
    { name: 'an extra leg', error: 'PlanMismatch', tweak: (p) => p.legs.push(p.legs[1]) },
    { name: 'a fee tier the owner did not allow (1%)', error: 'RouteViolation', tweak: (p, legIn, _m, t) => (p.legs[0].callData = t.swapCall(t.gme.address, legIn[0], { fee: 10000 })) },
    { name: 'a price limit on the swap (partial fill)', error: 'RouteViolation', tweak: (p, legIn, _m, t) => (p.legs[1].callData = t.swapCall(t.aapl.address, legIn[1], { sqrtPriceLimitX96: 1n })) },
    { name: 'outputs in swapped order', error: 'RouteViolation', tweak: (p) => (p.minOutputs = [p.minOutputs[1], p.minOutputs[0]]) },
    { name: 'a native value on a leg', error: 'RouteViolation', tweak: (p) => (p.legs[0].value = 1n) },
  ];
  for (const c of cases) {
    it(`refuses ${c.name}; counters, balances and allowances unchanged`, async () => {
      const t = await setup();
      const a = t.auth();
      const sig = await t.sign(a);
      await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
      await t.at(t.startsAt);
      const before = await t.snapshot(a);
      await expectRevert(t.run(a, sig, 0n, { tweak: (p, l, m) => c.tweak(p, l, m, t) }), c.error);
      assert.deepEqual(await t.snapshot(a), before);
      // the honest plan still works in the same window: a refused attempt consumed nothing
      assert.equal((await t.run(a, sig, 0n)).status, 'success');
    });
  }

  it('a plan for one authorization cannot be used with another (authorizationId binding)', async () => {
    const t = await setup();
    const a = t.auth();
    const b = t.auth({ nonce: 2n, recipient: t.attacker.account.address });
    const sigA = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    await expectRevert(t.run(a, sigA, 0n, { over: { authorizationId: t.idOf(b) } }), 'AuthorizationMismatch');
    // presenting the owner's signature for A with B's terms
    await expectRevert(t.run(b, sigA, 0n), 'InvalidOwnerSignature');
  });
});

describe('RecurringPurchaseExecutor — price limit and failed swaps consume nothing', () => {
  it('a price worse than the owner limit reverts; the same window works once the price is back within the limit', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    await t.dex.write.setRate([t.gme.address, 10n ** 18n, 31_000_000n]); // 31 USDG per GME > 30 limit
    const before = await t.snapshot(a);
    await expectRevert(t.run(a, sig, 0n), 'InsufficientOutput', 'InsufficientOutput(address,uint256,uint256)');
    assert.deepEqual(await t.snapshot(a), before);
    await t.dex.write.setRate([t.gme.address, 10n ** 18n, 29_000_000n]);
    assert.equal((await t.run(a, sig, 0n)).status, 'success');
  });

  it('a partial fill (router refunds unspent input) reverts the whole purchase', async () => {
    const t = await setup();
    const u = t.auth();
    const sig = await t.sign(u);
    await t.usdgAsOwner.write.approve([t.executor.address, u.schedule.totalBudget]);
    await t.at(t.startsAt);
    await t.dex.write.setConsumeBps([9000n]);
    // set the price generous enough that 90 % of the input still clears the owner's minimum
    await t.dex.write.setRate([t.gme.address, 10n ** 18n, 1_000_000n]);
    await t.dex.write.setRate([t.aapl.address, 10n ** 18n, 1_000_000n]);
    const before = await t.snapshot(u);
    await expectRevert(t.run(u, sig, 0n), 'InputNotFullySpent');
    assert.deepEqual(await t.snapshot(u), before);
  });
});

describe('RecurringPurchaseExecutor — funding', () => {
  it('EIP-2612 permit instead of an approve transaction; a front-run permit does not block the purchase', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    const p = await t.permitProof(a.schedule.totalBudget, t.startsAt + 100n * PERIOD);
    await t.at(t.startsAt);
    await t.usdg.write.permit([...p.args], { account: t.attacker.account }); // someone submits it first
    assert.equal((await t.run(a, sig, 0n, { fundingProof: p.proof })).status, 'success');
    const t2 = await setup();
    const a2 = t2.auth();
    const sig2 = await t2.sign(a2);
    const p2 = await t2.permitProof(a2.schedule.totalBudget, t2.startsAt + 100n * PERIOD);
    await t2.at(t2.startsAt);
    assert.equal((await t2.run(a2, sig2, 0n, { fundingProof: p2.proof })).status, 'success');
    assert.equal((await t2.usdg.read.allowance([a2.owner, t2.executor.address])) as bigint, a2.schedule.totalBudget - GROSS);
  });

  it('no allowance → the purchase reverts and consumes nothing; a source other than the signer is refused', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.at(t.startsAt);
    const before = await t.snapshot(a);
    await expectRevert(t.run(a, sig, 0n), 'ERC20InsufficientAllowance');
    assert.deepEqual(await t.snapshot(a), before);
    const b = t.auth({ sourceAccount: t.recipient.account.address });
    await expectRevert(t.run(b, await t.sign(b), 0n), 'InvalidTerms');
  });

  it('DELEGATION: a smart account owner signs through ERC-1271, funding comes from the account; a funding contract that moves another amount is refused', async () => {
    const t = await setup();
    const dm = await t.viem.deployContract('DcaMockDelegationManager', []);
    const account = await t.viem.deployContract('DcaMockSmartAccount', [t.owner.account.address, dm.address]);
    await dm.write.setAllowedDelegate([t.executor.address]);
    await t.usdg.write.mint([account.address, 100n * GROSS]);
    const a = t.auth({ owner: account.address, sourceAccount: account.address, recipient: t.owner.account.address, fundingKind: 1, fundingContract: dm.address });
    const sig = await t.sign(a); // the EOA owner signs; the account validates it (1271)
    const proof = encodeAbiParameters([{ type: 'bytes' }], [encodeAbiParameters([{ type: 'address' }], [account.address])]);
    await t.at(t.startsAt);
    const accBefore = await t.bal(t.usdg, account.address);
    assert.equal((await t.run(a, sig, 0n, { fundingProof: proof })).status, 'success');
    assert.equal(accBefore - (await t.bal(t.usdg, account.address)), GROSS);
    await dm.write.setAmountOverride([GROSS + 1n]);
    await t.at(t.startsAt + PERIOD);
    const before = await t.snapshot(a);
    await expectRevert(t.run(a, sig, 1n, { fundingProof: proof }), 'FundingMismatch');
    assert.deepEqual(await t.snapshot(a), before);
    // revocation for a contract owner: its EOA signs, anyone submits
    const id = t.idOf(a);
    const revocation = await t.owner.signTypedData({ domain: t.domain, types: { Revocation: [{ name: 'owner', type: 'address' }, { name: 'authorizationId', type: 'bytes32' }] }, primaryType: 'Revocation', message: { owner: account.address, authorizationId: id } });
    await t.asKeeper.write.revokeBySig([account.address, id, revocation]);
    await dm.write.setAmountOverride([0n]);
    await expectRevert(t.run(a, sig, 1n, { fundingProof: proof }), 'RevokedAuthorization');
  });
});

describe('RecurringPurchaseExecutor — BAG registry', () => {
  it('BagFactory: a new recorded version or another composition stops the authorization; an unknown bag is refused', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    await t.run(a, sig, 0n);
    await t.factoryAsCreator.write.recordBagVersion([OFF_CHAIN_REF, 1n, keccak256(toHex('composition-v2')), 'ipfs://bag-v2']);
    await t.at(t.startsAt + PERIOD);
    await expectRevert(t.run(a, sig, 1n), 'BagChanged');
    const b = t.auth({ bag: { bagId: keccak256(toHex('never created')) } });
    await expectRevert(t.run(b, await t.sign(b), 1n), 'UnknownBag');
  });

  it('StrategyRegistry: definitionHash must match the registered version; strategyId 0 means BagFactory-only', async () => {
    const t = await setup();
    await t.usdgAsOwner.write.approve([t.executor.address, 100n * GROSS]);
    await t.at(t.startsAt);
    const wrong = t.auth({ bag: { definitionHash: keccak256(toHex('edited definition')) } });
    await expectRevert(t.run(wrong, await t.sign(wrong), 0n), 'StrategyNotRegistered');
    const v2 = t.auth({ bag: { strategyVersion: 2 } });
    await expectRevert(t.run(v2, await t.sign(v2), 0n), 'StrategyNotRegistered');
    const factoryOnly = t.auth({ bag: { strategyId: pad('0x0', { size: 32 }), strategyVersion: 0 } });
    assert.equal((await t.run(factoryOnly, await t.sign(factoryOnly), 0n)).status, 'success');
  });
});

describe('RecurringPurchaseExecutor — signature and terms', () => {
  it('wrong signer, or a signature for another executor deployment, is refused', async () => {
    const t = await setup();
    const a = t.auth();
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    await expectRevert(t.run(a, await t.sign(a, t.attacker), 0n), 'InvalidOwnerSignature');
    await expectRevert(t.run(a, await t.sign(a, t.owner, t.router.address), 0n), 'InvalidOwnerSignature');
  });

  const terms: { name: string; over: (t: Awaited<ReturnType<typeof setup>>) => Partial<Authorization> & { schedule?: Partial<Authorization['schedule']> } }[] = [
    { name: 'total budget ≠ per-run × runs', over: () => ({ schedule: { totalBudget: GROSS * 3n + 1n } }) },
    { name: 'weights not summing to 10000', over: (t) => ({ assets: [{ asset: t.gme.address, symbol: 'GME', weightBps: 6000, decimals: 18, maxPriceRaw: 30_000_000n }, { asset: t.aapl.address, symbol: 'AAPL', weightBps: 3999, decimals: 18, maxPriceRaw: 250_000_000n }] }) },
    { name: 'the input token as an asset', over: (t) => ({ assets: [{ asset: t.usdg.address, symbol: 'USDG', weightBps: 10000, decimals: 6, maxPriceRaw: 1n }] }) },
    { name: 'a duplicate asset', over: (t) => ({ assets: [{ asset: t.gme.address, symbol: 'GME', weightBps: 5000, decimals: 18, maxPriceRaw: 30_000_000n }, { asset: t.gme.address, symbol: 'GME', weightBps: 5000, decimals: 18, maxPriceRaw: 30_000_000n }] }) },
    { name: 'an unlimited price', over: (t) => ({ assets: [{ asset: t.gme.address, symbol: 'GME', weightBps: 6000, decimals: 18, maxPriceRaw: 2n ** 256n - 1n }, { asset: t.aapl.address, symbol: 'AAPL', weightBps: 4000, decimals: 18, maxPriceRaw: 250_000_000n }] }) },
    { name: 'a fee tier outside 100/500/3000/10000', over: (t) => ({ route: { router: t.router.address, swapTarget: t.dex.address, allowedFees: [2500] } }) },
    { name: 'a zero recipient', over: () => ({ recipient: zeroAddress }) },
    { name: 'the executor as recipient', over: (t) => ({ recipient: t.executor.address }) },
    { name: 'expiry not after start', over: (t) => ({ schedule: { expiresAt: t.startsAt } }) },
    { name: 'an unknown funding kind', over: () => ({ fundingKind: 2 }) },
  ];
  for (const c of terms) {
    it(`refuses ${c.name} (InvalidTerms)`, async () => {
      const t = await setup();
      const a = t.auth(c.over(t));
      await t.usdgAsOwner.write.approve([t.executor.address, 100n * GROSS]);
      await t.at(t.startsAt);
      // the router plan is built from VALID terms, so the refusal can only come from execute()'s term check
      await expectRevert(t.run(a, await t.sign(a), 0n, { planAuth: t.auth(), over: { authorizationId: t.idOf(a) } }), 'InvalidTerms');
    });
  }

  it('the split and minimum views refuse invalid weights and limits instead of panicking', async () => {
    const t = await setup();
    const a = t.auth();
    await expectRevert(t.executor.read.legAmounts([GROSS, [{ ...a.assets[0], weightBps: 5999 }, a.assets[1]]]), 'InvalidTerms');
    await expectRevert(t.executor.read.minimumOutputs([GROSS, [{ ...a.assets[0], maxPriceRaw: 2n ** 256n - 1n }, a.assets[1]]]), 'InvalidTerms');
  });
});

describe('RecurringPurchaseExecutor — concurrency and attack surface', () => {
  it('two keepers in the same block and window: exactly one purchase, counters move once', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    const x1 = await t.execution(a, 0n);
    const x2 = await t.execution(a, 0n);
    const k2 = await t.viem.getContractAt('RecurringPurchaseExecutor', t.executor.address, { client: { wallet: t.keeper2 } });
    await t.rpc('evm_setAutomine', [false]);
    let hashes: Hex[];
    try {
      hashes = [await t.asKeeper.write.execute([a, x1, sig, '0x'], { gas: 3_000_000n }), await k2.write.execute([a, x2, sig, '0x'], { gas: 3_000_000n })];
      await t.rpc('evm_mine');
    } finally {
      await t.rpc('evm_setAutomine', [true]);
    }
    const statuses = await Promise.all(hashes.map(async (h) => (await t.publicClient.getTransactionReceipt({ hash: h })).status));
    assert.deepEqual([...statuses].sort(), ['reverted', 'success']);
    const s = await t.snapshot(a);
    assert.equal(s.state.executions, 1);
    assert.equal(s.state.grossUsed, GROSS);
  });

  it('only execute/revoke/revokeBySig change state; a forged authorization naming another owner cannot pull their allowance', async () => {
    const t = await setup();
    const abi = (await import('../../artifacts/contracts/dca/RecurringPurchaseExecutor.sol/RecurringPurchaseExecutor.json', { with: { type: 'json' } })).default.abi as { type: string; name: string; stateMutability?: string }[];
    const writes = abi.filter((x) => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure').map((x) => x.name).sort();
    assert.deepEqual(writes, ['execute', 'revoke', 'revokeBySig']);

    await t.usdgAsOwner.write.approve([t.executor.address, 10n ** 12n]); // a large standing allowance
    await t.at(t.startsAt);
    const forged = t.auth({ recipient: t.attacker.account.address, nonce: 99n });
    const before = await t.bal(t.usdg, t.owner.account.address);
    await expectRevert(t.run(forged, await t.sign(forged, t.attacker), 0n, { as: t.asAttacker }), 'InvalidOwnerSignature');
    // the router itself cannot be pointed at the owner: wallet must be the caller
    const { p, planSignature } = await t.plan(t.auth(), (pl) => (pl.wallet = t.owner.account.address));
    const routerAsAttacker = await t.viem.getContractAt('BagExecutionRouter', t.router.address, { client: { wallet: t.attacker } });
    await expectRevert(routerAsAttacker.write.execute([p, planSignature], { gas: 3_000_000n }), 'WalletMismatch', 'WalletMismatch(address,address)');
    assert.equal(await t.bal(t.usdg, t.owner.account.address), before);
  });
});

describe('RecurringPurchaseExecutor — the signed asset list IS the BAG\'s registered content', () => {
  it('compositionHashOf rebuilds the BAG app composition string; the SDK computes the same; the chain label is fixed at deployment', async () => {
    const t = await setup();
    const a = t.auth();
    assert.equal(await t.executor.read.compositionHashOf([a.assets]), t.COMPOSITION);
    assert.equal(recurringCompositionHash('robinhood', a.assets), t.COMPOSITION);
    assert.equal(await t.executor.read.chainLabel(), 'robinhood');
    for (const label of ['', 'robin:hood', 'a|b']) {
      await expectRevert(t.viem.deployContract('RecurringPurchaseExecutor', [t.factory.address, t.registry.address, label]), 'InvalidChainLabel', 'InvalidChainLabel()');
    }
  });

  it('the real BAG id, version and compositionHash next to ANY other token/weight list is refused (CompositionMismatch); nothing moves', async () => {
    const t = await setup();
    const other = await t.viem.deployContract('DcaTestToken', ['Microsoft', 'MSFT', 18]);
    await t.usdgAsOwner.write.approve([t.executor.address, 100n * GROSS]);
    await t.at(t.startsAt);
    const [g, p] = t.auth().assets;
    const lists: [string, AssetLimit[]][] = [
      ['weights swapped', [{ ...g, weightBps: 4000 }, { ...p, weightBps: 6000 }]],
      ['a token replaced', [g, { ...p, asset: other.address }]],
      ['a symbol changed', [g, { ...p, symbol: 'AAPLX' }]],
      ['the same rows in another order', [p, g]],
      ['decimals changed', [{ ...g, decimals: 6 }, p]],
      ['an asset dropped, its weight moved', [{ ...g, weightBps: 10_000 }]],
    ];
    for (const [name, assets] of lists) {
      const a = t.auth({ assets });
      assert.equal(a.bag.compositionHash, t.COMPOSITION, name); // the signed hash IS the real one; only the list differs
      const before = await t.snapshot(a);
      await expectRevert(t.run(a, await t.sign(a), 0n, { planAuth: t.auth() }), 'CompositionMismatch', 'CompositionMismatch(bytes32,bytes32)');
      assert.deepEqual(await t.snapshot(a), before, name);
    }
    // the honest list still buys in the same window
    const honest = t.auth();
    await t.run(honest, await t.sign(honest), 0n);
    assert.equal(((await t.executor.read.getState([honest.owner, t.idOf(honest)])) as { executions: number }).executions, 1);
  });

  it('two registered BAGs: the identity of one with the list of the other is refused both ways; each with its own list buys', async () => {
    const t = await setup();
    const REF_B = pad('0xb2', { size: 32 });
    const listB: AssetLimit[] = [{ asset: t.aapl.address, symbol: 'AAPL', weightBps: 10_000, decimals: 18, maxPriceRaw: 250_000_000n }];
    await t.factoryAsCreator.write.createBag([REF_B, compositionOf(listB), 'ipfs://bag-b', true]);
    const bagB = { bagId: (await t.factory.read.deriveBagId([t.creator.account.address, REF_B])) as Hex, compositionHash: compositionOf(listB), strategyId: pad('0x0', { size: 32 }), strategyVersion: 0 };
    await t.usdgAsOwner.write.approve([t.executor.address, 100n * GROSS]);
    await t.at(t.startsAt);
    const idBListA = t.auth({ bag: bagB });
    await expectRevert(t.run(idBListA, await t.sign(idBListA), 0n), 'CompositionMismatch', 'CompositionMismatch(bytes32,bytes32)');
    const idAListB = t.auth({ assets: listB });
    await expectRevert(t.run(idAListB, await t.sign(idAListB), 0n, { planAuth: idAListB }), 'CompositionMismatch', 'CompositionMismatch(bytes32,bytes32)');
    const okB = t.auth({ bag: bagB, assets: listB, nonce: 7n });
    const receipt = await t.run(okB, await t.sign(okB), 0n);
    assert.equal(receipt.status, 'success');
  });

  it('a symbol that could forge a composition row (":" or "|") or is empty is refused before any registry read (InvalidTerms 14)', async () => {
    const t = await setup();
    await t.at(t.startsAt);
    const [g, p] = t.auth().assets;
    for (const symbol of ['', 'GME|robinhood', 'GME:18']) {
      const a = t.auth({ assets: [{ ...g, symbol }, p] });
      await expectRevert(t.run(a, await t.sign(a), 0n, { planAuth: t.auth() }), 'InvalidTerms', 'InvalidTerms(uint256)');
    }
  });
});

describe('RecurringPurchaseExecutor — SDK purchase verification on a real EVM', () => {
  it('verifyRecurringPurchase with the SDK balance reader: VERIFIED against the prepared call; another prepared call, another authorization and a reverted purchase are not', async () => {
    const t = await setup();
    const a = t.auth();
    const sig = await t.sign(a);
    await t.usdgAsOwner.write.approve([t.executor.address, a.schedule.totalBudget]);
    await t.at(t.startsAt);
    const x = await t.execution(a, 0n);
    const hash = await t.asKeeper.write.execute([a, x, sig, '0x'], { gas: 3_000_000n });
    await t.publicClient.waitForTransactionReceipt({ hash });
    const client = withReceiptEvidence(t.publicClient as any); // SINGLE_TRANSACTION_BLOCK: eth_call balanceOf at the parent and at this block
    const deployment = { chainId: t.chainId, executor: t.executor.address };
    const intent = { execution: x, ownerSignature: sig, fundingProof: '0x' as Hex };
    const ok = await verifyRecurringPurchase({ client, transactionHash: hash, auth: a as any, deployment, intent });
    assert.deepEqual(ok.issues, []);
    assert.deepEqual([ok.status, ok.transactionBinding, ok.evidence, ok.balanceScope], ['VERIFIED', 'PREPARED_INTENT', 'TRANSACTION_AND_BALANCE_DELTAS', 'SINGLE_TRANSACTION_BLOCK']);
    assert.equal(ok.source?.debitRaw, a.schedule.grossAmountPerRun);
    assert.ok(ok.deliveries.every((d) => d.balanceAfterRaw !== null && d.receivedRaw >= d.minimumRaw && d.receivedRaw === d.logReceivedRaw));
    // a call that was not the prepared one (same purchase, another planned minimum) is not this purchase
    const other = { ...intent, execution: { ...x, plan: { ...x.plan, minOutputs: x.plan.minOutputs.map((m, i) => (i === 0 ? { ...m, minAmountOut: m.minAmountOut + 1n } : m)) } } };
    assert.equal((await verifyRecurringPurchase({ client, transactionHash: hash, auth: a as any, deployment, intent: other })).issues[0].code, 'CALL_MISMATCH');
    // checked against another authorization: the event is not for it
    const b = t.auth({ nonce: 99n });
    const wrong = await verifyRecurringPurchase({ client, transactionHash: hash, auth: b as any, deployment });
    assert.equal(wrong.status, 'FAILED');
    // a mined revert (same window again) is FAILED, never VERIFIED
    const again = await t.asKeeper.write.execute([a, await t.execution(a, 0n), sig, '0x'], { gas: 3_000_000n }).catch(() => null);
    if (again) assert.equal((await verifyRecurringPurchase({ client, transactionHash: again, auth: a as any, deployment, intent })).status, 'FAILED');
  });
});

describe('RecurringPurchaseExecutor — SDK ABI', () => {
  it('every function, event and error in the SDK\'s RECURRING_EXECUTOR_ABI matches the compiled contract', async () => {
    const compiled = (await hre.artifacts.readArtifact('RecurringPurchaseExecutor')).abi as any[];
    const key = (x: any) => (x.type === 'event' ? `event:${toEventSelector(x)}:${x.inputs.map((i: any) => !!i.indexed).join()}` : `${x.type}:${toFunctionSelector(x)}:${(x.outputs ?? []).map((o: any) => o.type).join()}`);
    const have = new Set(compiled.filter((x) => x.type !== 'constructor').map(key));
    const sdk = (RECURRING_EXECUTOR_ABI as readonly any[]).filter((x) => x.type !== 'struct');
    for (const item of sdk) assert.ok(have.has(key(item)), `SDK ABI item not in the contract: ${item.type} ${item.name}`);
    // every error the contract can raise is decodable by the SDK
    const sdkErrors = new Set(sdk.filter((x) => x.type === 'error').map(key));
    for (const e of compiled.filter((x) => x.type === 'error' && x.name !== 'ZeroAddress' && x.name !== 'InvalidChainLabel' && !x.name.startsWith('Strings') && !x.name.startsWith('SafeERC20') && !x.name.startsWith('ECDSA') && x.name !== 'ReentrancyGuardReentrantCall' && x.name !== 'InvalidShortString' && x.name !== 'StringTooLong')) {
      assert.ok(sdkErrors.has(key(e)), `contract error missing from the SDK ABI: ${e.name}`);
    }
  });
});
