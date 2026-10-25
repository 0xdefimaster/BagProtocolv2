import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, pad, type Hex as VHex } from 'viem';
import {
  BagSdkError,
  bagFactoryCompositionHash,
  buildRecurringAuthorization,
  compareRecurringAuthorization,
  computeDefinitionHash,
  decodeRecurringAuthorizationTypedData,
  parseBag,
  recurringAuthorizationId,
  recurringAuthorizationTypedData,
  recurringLegAmounts,
  recurringMinimumOutputs,
  recurringRevocationTypedData,
  recurringWindowAt,
  splitByWeight,
  summarizeRecurringAuthorization,
  checkRecurringPlan,
  RECURRING_EXECUTOR_ABI,
  recurringCompositionHash,
  recurringExecutionHash,
  recurringRegisteredAssets,
  verifyRecurringPurchase,
  type BagDocument,
  type RecurringPurchaseIntent,
  type Hex,
  type RecurringAuthorization,
  type RecurringTermsInput,
} from '../src';
import { buildRecurringRunPlan, ownerLimitSqrtPriceX96, routerPlanTypedData, ROBINHOOD_UNISWAP_V3, SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI } from '../src/adapters/uniswap-v3';

const load = (name: string): BagDocument => {
  const r = parseBag(JSON.parse(readFileSync(new URL(`./fixtures/${name}.bag.json`, import.meta.url), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};
const BAG = load('robinhood-955df6e0-b6ea-44ba-a5eb-1288a80c0a06'); // GME/ASML/COIN/AAPL
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Hex;
const OWNER = '0x1111111111111111111111111111111111111111' as Hex;
const EXECUTOR = '0x2222222222222222222222222222222222222222' as Hex;
const ROUTER = '0x3333333333333333333333333333333333333333' as Hex;
const DEPLOYMENT = { chainId: 4663, executor: EXECUTOR };
const BAG_ID = '0x37f16d57d87fcda8bc3c1863fc5b3d75fb7ad5e5ba89060ff20ce56b27be40eb' as Hex;
const COMPOSITION = '0xb01f70750ffa0fbcecf99958683aac3ceca89ff55e18f09913ecbf3dde5e0148' as Hex;
const assetsOf = (bag: BagDocument) => bag.definition.assets.map((a) => a.address.toLowerCase() as Hex);

function terms(over: Partial<RecurringTermsInput> = {}): RecurringTermsInput {
  return {
    bag: BAG,
    owner: OWNER,
    funding: { kind: 'ALLOWANCE' },
    inputToken: USDG,
    registry: { bagId: BAG_ID, bagVersion: BigInt(1), compositionHash: COMPOSITION },
    amountPerRunRaw: BigInt(5_000_000),
    runs: 5,
    totalBudgetRaw: BigInt(25_000_000),
    startsAt: BigInt(1_800_000_000),
    periodSeconds: BigInt(7 * 86_400),
    maxPriceRaw: Object.fromEntries(assetsOf(BAG).map((a) => [a, BigInt(1_000_000_000)])),
    route: { router: ROUTER, swapTarget: ROBINHOOD_UNISWAP_V3.swapRouter02 },
    nonce: BigInt(1),
    ...over,
  };
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BagSdkError);
    expect((e as BagSdkError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('buildRecurringAuthorization', () => {
  it('5 runs × 5 USDG = 25 USDG; the asset list is the registered composition; funds stay with the owner (ALLOWANCE)', () => {
    const auth = buildRecurringAuthorization(terms());
    // registered order (sorted by symbol), weights and decimals from the definition, symbols from metadata
    expect(auth.assets.map((a) => a.symbol)).toEqual(['AAPL', 'ASML', 'COIN', 'GME']);
    const def = new Map(BAG.definition.assets.map((a) => [a.address.toLowerCase(), a]));
    auth.assets.forEach((a) => expect([a.weightBps, a.decimals]).toEqual([def.get(a.asset)!.weightBps, def.get(a.asset)!.decimals]));
    expect(recurringCompositionHash('robinhood', auth.assets)).toBe(COMPOSITION);
    expect(auth.bag.definitionHash).toBe(computeDefinitionHash(BAG.definition));
    expect(auth.schedule).toEqual({ grossAmountPerRun: BigInt(5_000_000), totalBudget: BigInt(25_000_000), maxExecutions: 5, startsAt: BigInt(1_800_000_000), periodSeconds: BigInt(604_800), expiresAt: BigInt(1_800_000_000 + 5 * 604_800) });
    expect(auth.sourceAccount).toBe(OWNER);
    expect(auth.fundingContract).toBe(USDG);
    expect(summarizeRecurringAuthorization(auth).fundsStayInOwnerAddress).toBe(true);
    expect(auth.bag.strategyId).toBe(pad('0x0', { size: 32 }));
  });

  it('a total that is not runs × amount is refused, never corrected', () => {
    expectCode(() => buildRecurringAuthorization(terms({ totalBudgetRaw: BigInt(30_000_000) })), 'RECURRING_TERMS_INVALID');
  });

  it('refuses a missing price limit, an unlimited one, a disallowed fee tier, and the input token as an asset', () => {
    const [first] = assetsOf(BAG);
    const limits = Object.fromEntries(assetsOf(BAG).map((a) => [a, BigInt(1)]));
    delete limits[first];
    expectCode(() => buildRecurringAuthorization(terms({ maxPriceRaw: limits })), 'RECURRING_TERMS_INVALID');
    expectCode(() => buildRecurringAuthorization(terms({ maxPriceRaw: Object.fromEntries(assetsOf(BAG).map((a) => [a, (BigInt(1) << BigInt(256)) - BigInt(1)])) })), 'RECURRING_TERMS_INVALID');
    expectCode(() => buildRecurringAuthorization(terms({ route: { router: ROUTER, swapTarget: ROUTER, allowedFees: [2500] } })), 'RECURRING_TERMS_INVALID');
    expectCode(() => buildRecurringAuthorization(terms({ inputToken: assetsOf(BAG)[0] })), 'RECURRING_TERMS_INVALID');
  });

  it('applies the bag.json v1 rules to every run: valid document, minInvestment, no performance fee, BLOCK, no zero leg', () => {
    const withRules = (rules: Partial<BagDocument['definition']['rules']>): BagDocument => {
      const definition = { ...BAG.definition, rules: { ...BAG.definition.rules, ...rules } };
      return { ...BAG, definition, definitionHash: computeDefinitionHash(definition) };
    };
    expectCode(() => buildRecurringAuthorization(terms({ bag: { ...BAG, definitionHash: COMPOSITION } })), 'RECURRING_TERMS_INVALID');
    expectCode(() => buildRecurringAuthorization(terms({ bag: withRules({ performanceFeeBps: 100 }) })), 'RECURRING_TERMS_INVALID');
    expectCode(() => buildRecurringAuthorization(terms({ bag: withRules({ noRouteAssetPolicy: 'HOLD_INPUT' }) })), 'RECURRING_TERMS_INVALID');
    expect(buildRecurringAuthorization(terms({ bag: withRules({ noRouteAssetPolicy: null, performanceFeeBps: null }) })).bag.definitionHash).not.toBe(computeDefinitionHash(BAG.definition));
    const min10 = withRules({ minInvestment: { amount: '10', measuredAs: 'PAYMENT_TOKEN_AMOUNT' } });
    expectCode(() => buildRecurringAuthorization(terms({ bag: min10 })), 'RECURRING_TERMS_INVALID'); // decimals needed
    expectCode(() => buildRecurringAuthorization(terms({ bag: min10, inputTokenDecimals: 6 })), 'RECURRING_TERMS_INVALID'); // 5 < 10 per run
    expect(buildRecurringAuthorization(terms({ bag: min10, inputTokenDecimals: 6, amountPerRunRaw: BigInt(10_000_000), totalBudgetRaw: BigInt(50_000_000) })).schedule.grossAmountPerRun).toBe(BigInt(10_000_000));
    const minFrac = withRules({ minInvestment: { amount: '5.0000001', measuredAs: 'PAYMENT_TOKEN_AMOUNT' } });
    expectCode(() => buildRecurringAuthorization(terms({ bag: minFrac, inputTokenDecimals: 6 })), 'RECURRING_TERMS_INVALID'); // rounds up to 5.000001
    expectCode(() => buildRecurringAuthorization(terms({ amountPerRunRaw: BigInt(3), totalBudgetRaw: BigInt(15) })), 'RECURRING_TERMS_INVALID'); // some asset gets 0
    expectCode(() => buildRecurringAuthorization(terms({ inputToken: '0x0000000000000000000000000000000000000000' })), 'RECURRING_TERMS_INVALID');
  });

  it('the token/weight list must reproduce the registered compositionHash; symbols are required and cannot break a row', () => {
    const A3 = load('robinhood-a3caff05-d606-486b-959f-30865a4cbfa7');
    // the real 955df6e0 identity with another BAG's registered composition, and vice versa
    expectCode(() => buildRecurringAuthorization(terms({ registry: { bagId: BAG_ID, bagVersion: BigInt(1), compositionHash: bagFactoryCompositionHash(A3)! } })), 'RECURRING_TERMS_INVALID');
    const swapped = { ...BAG, definition: { ...BAG.definition, assets: BAG.definition.assets.map((a, i, all) => ({ ...a, weightBps: all[(i + 1) % all.length].weightBps })) } };
    const swappedDoc = { ...swapped, definitionHash: computeDefinitionHash(swapped.definition) };
    expectCode(() => buildRecurringAuthorization(terms({ bag: swappedDoc })), 'RECURRING_TERMS_INVALID');
    expectCode(() => buildRecurringAuthorization(terms({ bag: { ...BAG, metadata: undefined } as BagDocument })), 'RECURRING_TERMS_INVALID');
    const injected = { ...BAG, metadata: { ...BAG.metadata!, assets: BAG.metadata!.assets.map((m, i) => (i === 0 ? { ...m, symbol: 'GME|robinhood' } : m)) } };
    expectCode(() => buildRecurringAuthorization(terms({ bag: injected as BagDocument })), 'RECURRING_TERMS_INVALID');
    // the hash depends on the order: the same rows in another order are another composition
    const auth = buildRecurringAuthorization(terms());
    expect(recurringCompositionHash('robinhood', [...auth.assets].reverse())).not.toBe(COMPOSITION);
  });

  it('the summary states the fixed price ceiling and what each run depends on', () => {
    const s = summarizeRecurringAuthorization(buildRecurringAuthorization(terms()));
    expect(s.priceLimit).toEqual({ kind: 'FIXED_MAX_PRICE_PER_ASSET', isSlippageProtection: false, windowSkippedWhileAbove: true, catchUp: false, mayEndBeforeAllRuns: true });
    expect(s.dependencies).toEqual({ composer: 'NOT_USED', planSignerSignatureEachRun: true, keeperTransactionEachRun: true, routerOwnerAllowlist: true, canExceedSignedLimits: false, canStopOrDelayPurchases: true });
    expect(s.assets.map((a) => a.symbol)).toEqual(['AAPL', 'ASML', 'COIN', 'GME']);
  });

  it('DELEGATION funds come from a separate smart account; the summary says the funds do not stay in an EOA', () => {
    const auth = buildRecurringAuthorization(terms({ funding: { kind: 'DELEGATION', delegationManager: '0xdb9b1e94b5b69df7e401ddbede43491141047db3' } }));
    expect(auth.fundingKind).toBe(1);
    expect(summarizeRecurringAuthorization(auth).fundsStayInOwnerAddress).toBe(false);
  });
});

describe('typed data, id and decoding', () => {
  it('the id is the EIP-712 digest; any field change changes it', () => {
    const auth = buildRecurringAuthorization(terms());
    const id = recurringAuthorizationId(auth, DEPLOYMENT);
    expect(id).toBe(hashTypedData(recurringAuthorizationTypedData(auth, DEPLOYMENT)));
    expect(recurringAuthorizationId({ ...auth, recipient: ROUTER }, DEPLOYMENT)).not.toBe(id);
    expect(recurringAuthorizationId(auth, { ...DEPLOYMENT, executor: ROUTER })).not.toBe(id);
    expect(recurringRevocationTypedData(OWNER, id, DEPLOYMENT).message).toEqual({ owner: OWNER, authorizationId: id });
  });

  it('round-trips through the JSON a wallet receives; tampered domain, types or values are refused or reported', () => {
    const auth = buildRecurringAuthorization(terms());
    const wire = JSON.parse(JSON.stringify(recurringAuthorizationTypedData(auth, DEPLOYMENT), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const decoded = decodeRecurringAuthorizationTypedData(wire, DEPLOYMENT);
    expect(compareRecurringAuthorization(decoded, auth)).toEqual([]);
    expectCode(() => decodeRecurringAuthorizationTypedData({ ...wire, domain: { ...wire.domain, chainId: 1 } }, DEPLOYMENT), 'RECURRING_TERMS_INVALID');
    expectCode(() => decodeRecurringAuthorizationTypedData({ ...wire, domain: { ...wire.domain, verifyingContract: ROUTER } }, DEPLOYMENT), 'RECURRING_TERMS_INVALID');
    expectCode(() => decodeRecurringAuthorizationTypedData({ ...wire, types: { ...wire.types, Extra: [] } }, DEPLOYMENT), 'RECURRING_TERMS_INVALID');
    const swapped = decodeRecurringAuthorizationTypedData({ ...wire, message: { ...wire.message, recipient: ROUTER, schedule: { ...wire.message.schedule, totalBudget: '30000000' } } }, DEPLOYMENT);
    expect(compareRecurringAuthorization(swapped, auth)).toEqual([`recipient: ${ROUTER} ≠ ${OWNER}`, 'schedule.totalBudget: 30000000 ≠ 25000000']);
  });
});

describe('split, minimums and calendar', () => {
  it('leg amounts are the bag.json v1 split; minimums are ceil(leg × 10^decimals / maxPrice)', () => {
    const limits = Object.fromEntries(assetsOf(BAG).map((a, i) => [a, BigInt(10_000_000 * (i + 1) + 7)]));
    const auth = buildRecurringAuthorization(terms({ maxPriceRaw: limits }));
    const legIn = recurringLegAmounts(auth);
    const split = splitByWeight(auth.schedule.grossAmountPerRun, BAG.definition);
    expect(legIn).toEqual(auth.assets.map((a) => split.get(`robinhood:${a.asset}`))); // per asset, in the authorization's (registered) order
    expect(recurringMinimumOutputs(auth)).toEqual(auth.assets.map((a, i) => (legIn[i] * BigInt(10) ** BigInt(a.decimals) + a.maxPriceRaw - BigInt(1)) / a.maxPriceRaw));
  });

  it('calendar windows: none before the start or at/after expiry; window = floor((t − start) / period)', () => {
    const auth = buildRecurringAuthorization(terms());
    expect(recurringWindowAt(auth, BigInt(1_799_999_999))).toBeNull();
    expect(recurringWindowAt(auth, BigInt(1_800_000_000))).toBe(BigInt(0));
    expect(recurringWindowAt(auth, BigInt(1_800_000_000 + 604_800 * 2 + 5))).toBe(BigInt(2));
    expect(recurringWindowAt(auth, auth.schedule.expiresAt)).toBeNull();
  });
});

describe('bagFactoryCompositionHash (BAG app convention, verification helper)', () => {
  it('reproduces the compositionHash recorded on chain for both Robinhood fixtures', () => {
    expect(bagFactoryCompositionHash(BAG)).toBe(COMPOSITION);
    expect(bagFactoryCompositionHash(load('robinhood-a3caff05-d606-486b-959f-30865a4cbfa7'))).toBe('0x2dbb1733ab3eb7f0a632d5a7ac51056625d2050bedfe9ee85ad2b9e0d935cde0');
    expect(bagFactoryCompositionHash({ ...BAG, metadata: undefined })).toBeNull();
    expect(recurringRegisteredAssets(BAG)!.map((a) => a.symbol)).toEqual(['AAPL', 'ASML', 'COIN', 'GME']);
  });
});

describe('checkRecurringPlan and verifyRecurringPurchase (prepared intent + transaction-scoped balances)', () => {
  const auth = buildRecurringAuthorization(terms({ maxPriceRaw: Object.fromEntries(assetsOf(BAG).map((a) => [a, BigInt(500_000_000)])) }));
  const id = recurringAuthorizationId(auth, DEPLOYMENT);
  const legIn = recurringLegAmounts(auth);
  const floors = recurringMinimumOutputs(auth);
  const KEEPER = '0x4444444444444444444444444444444444444444' as Hex;
  const DEX = ROBINHOOD_UNISWAP_V3.swapRouter02;
  const TX = pad('0xab', { size: 32 }) as Hex;
  const BLOCK = pad('0xbb', { size: 32 }) as Hex;
  let intent: RecurringPurchaseIntent;
  beforeAll(async () => {
    const quotes = { async simulateContract({ args }: { args: readonly unknown[] }) { const p = args[0] as { tokenOut: string }; return { result: [floors[auth.assets.findIndex((a) => a.asset === p.tokenOut)] * BigInt(2), BigInt(1), 0, BigInt(0)] }; } };
    const run = await buildRecurringRunPlan({ client: quotes, auth, deployment: DEPLOYMENT, quoter: ROBINHOOD_UNISWAP_V3.quoterV2, nowSeconds: auth.schedule.startsAt + BigInt(10) });
    intent = { execution: { ...run.execution, plan: run.plan, planSignature: `0x${'22'.repeat(65)}` as Hex }, ownerSignature: `0x${'11'.repeat(65)}` as Hex, fundingProof: '0x' };
  });
  const received = (i: number) => intent.execution.plan.minOutputs[i].minAmountOut + BigInt(5);
  const T_ABI = [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }] as const;
  const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) => ({ address: token, topics: encodeEventTopics({ abi: T_ABI, eventName: 'Transfer', args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) as Hex });
  type World = { execution?: RecurringPurchaseIntent['execution']; executionHash?: Hex; window?: bigint; status?: 'success' | 'reverted'; head?: bigint; balances?: Record<string, [bigint, bigint]>; logs?: (l: ReturnType<typeof transfer>[]) => ReturnType<typeof transfer>[]; reader?: boolean };
  const key = (a: string, t: string) => `${a.toLowerCase()}:${t.toLowerCase()}`;
  function world(w: World = {}) {
    const execution = w.execution ?? intent.execution;
    const input = encodeFunctionData({ abi: RECURRING_EXECUTOR_ABI, functionName: 'execute', args: [auth, execution, intent.ownerSignature, intent.fundingProof] as never });
    const g = auth.schedule.grossAmountPerRun;
    const base = [
      transfer(USDG, OWNER, EXECUTOR, g),
      transfer(USDG, EXECUTOR, ROUTER, g),
      ...auth.assets.flatMap((a, i) => [transfer(USDG, ROUTER, DEX, legIn[i]), transfer(a.asset, DEX, ROUTER, received(i)), transfer(a.asset, ROUTER, EXECUTOR, received(i)), transfer(a.asset, EXECUTOR, OWNER, received(i))]),
      { address: EXECUTOR, topics: encodeEventTopics({ abi: RECURRING_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner: OWNER, authorizationId: id, executionHash: w.executionHash ?? recurringExecutionHash(execution.plan) } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [w.window ?? execution.window, BigInt(0), g, g]) as Hex },
    ];
    const logs = (w.logs ? w.logs(base) : base).map((l, i) => ({ ...l, logIndex: i, transactionHash: TX, blockHash: BLOCK, blockNumber: BigInt(10), removed: false }));
    const balances: Record<string, [bigint, bigint]> = { [key(OWNER, USDG)]: [BigInt(100_000_000), BigInt(100_000_000) - g] };
    auth.assets.forEach((a, i) => (balances[key(OWNER, a.asset)] = [BigInt(0), received(i)]));
    Object.assign(balances, w.balances ?? {});
    return {
      getChainId: async () => 4663,
      getTransaction: async () => ({ hash: TX, from: KEEPER, to: EXECUTOR, input, value: BigInt(0), chainId: 4663, blockHash: BLOCK, blockNumber: BigInt(10) }),
      getTransactionReceipt: async () => ({ transactionHash: TX, blockHash: BLOCK, blockNumber: BigInt(10), from: KEEPER, to: EXECUTOR, status: w.status ?? ('success' as const), logs }),
      getBlock: async () => ({ hash: BLOCK, transactions: [TX] }),
      getBlockNumber: async () => w.head ?? BigInt(10),
      ...(w.reader === false ? {} : {
        getPurchaseBalanceChanges: async (ctx: { transactionHash: Hex; blockHash: Hex; blockNumber: bigint; owner: Hex; tokens: readonly string[] }) => ({
          ...ctx, scope: 'SINGLE_TRANSACTION_BLOCK' as const, balances: ctx.tokens.map((t) => { const b = balances[key(ctx.owner, t)] ?? [BigInt(0), BigInt(0)]; return { token: t, beforeRaw: b[0], afterRaw: b[1] }; }),
        }),
      }),
    };
  }
  const verify = (c: ReturnType<typeof world>, over: { intent?: RecurringPurchaseIntent | null; verification?: 'BALANCE_DELTA' | 'TRANSFER_LOGS'; confirmations?: number } = {}) =>
    verifyRecurringPurchase({ client: c, transactionHash: TX, auth, deployment: DEPLOYMENT, intent: over.intent === null ? undefined : (over.intent ?? intent), verification: over.verification, confirmations: over.confirmations });
  const codes = async (c: ReturnType<typeof world>, over = {}) => (await verify(c, over)).issues.map((i) => i.code);

  it('checkRecurringPlan: the built plan passes; every widening is listed with the executor code', () => {
    expect(checkRecurringPlan(auth, intent.execution.plan, DEPLOYMENT)).toEqual([]);
    const tamper = (f: (p: RecurringPurchaseIntent['execution']['plan']) => void) => { const p = structuredClone(intent.execution.plan); f(p); return checkRecurringPlan(auth, p, DEPLOYMENT).join(' | '); };
    expect(tamper((p) => { p.wallet = ROUTER; })).toContain('PlanMismatch(1)');
    expect(tamper((p) => { p.inputAmount *= BigInt(2); })).toContain('PlanMismatch(3)');
    expect(tamper((p) => { p.bagId = pad('0x99', { size: 32 }) as Hex; })).toContain('PlanMismatch(4)');
    expect(tamper((p) => { (p.legs as unknown as { target: Hex }[])[0].target = ROUTER; })).toContain('RouteViolation(0,1)');
    const call = (f: (a: { recipient: Hex; sqrtPriceLimitX96: bigint; fee: number }) => void) => (p: RecurringPurchaseIntent['execution']['plan']) => {
      const { args } = decodeFunctionData({ abi: SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI, data: p.legs[0].callData as VHex });
      const a = { ...args[0] }; f(a as never);
      (p.legs as unknown as { callData: Hex }[])[0].callData = encodeFunctionData({ abi: SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI, functionName: 'exactInputSingle', args: [a] }) as Hex;
    };
    expect(tamper(call((a) => { a.recipient = OWNER; }))).toContain('RouteViolation(0,6)');
    expect(tamper(call((a) => { a.sqrtPriceLimitX96 = BigInt(1); }))).toContain('RouteViolation(0,8)');
    expect(tamper(call((a) => { a.fee = 2500; }))).toContain('RouteViolation(0,9)');
    expect(tamper((p) => { (p.minOutputs as unknown as { minAmountOut: bigint }[])[1].minAmountOut = floors[1] - BigInt(1); })).toContain('RouteViolation(1,11)');
  });

  it('VERIFIED: the mined call is the prepared one, and balances show one run debited, deliveries at or above the limits, no transit', async () => {
    const r = await verify(world());
    expect(r.issues).toEqual([]);
    expect([r.status, r.transactionBinding, r.evidence, r.balanceScope]).toEqual(['VERIFIED', 'PREPARED_INTENT', 'TRANSACTION_AND_BALANCE_DELTAS', 'SINGLE_TRANSACTION_BLOCK']);
    expect(r.source).toMatchObject({ debitRaw: auth.schedule.grossAmountPerRun, beforeRaw: BigInt(100_000_000) });
    r.deliveries.forEach((d, i) => expect([d.receivedRaw, d.balanceAfterRaw, d.priceLimitFloorRaw]).toEqual([received(i), received(i), floors[i]]));
    expect(r.transit.every((t) => t.netRaw === BigInt(0))).toBe(true);
    // without a prepared intent: the mined call is decoded and checked, and labelled as the weaker binding
    const decoded = await verify(world(), { intent: null });
    expect([decoded.status, decoded.transactionBinding]).toEqual(['VERIFIED', 'DECODED_CALL']);
  });

  it('FAILED: another call than the prepared one, another plan or window in the event, a plan outside the authorization, another authorization', async () => {
    expect(await codes(world(), { intent: { ...intent, fundingProof: '0x1234' } })).toContain('CALL_MISMATCH');
    expect(await codes(world({ executionHash: pad('0x01', { size: 32 }) as Hex }))).toContain('EXECUTION_HASH_MISMATCH');
    expect(await codes(world({ window: BigInt(7) }))).toContain('WINDOW_MISMATCH');
    const wide = structuredClone(intent.execution);
    (wide.plan.minOutputs as unknown as { minAmountOut: bigint }[])[0].minAmountOut = BigInt(1);
    expect(await codes(world({ execution: wide }), { intent: null })).toContain('PLAN_OUTSIDE_AUTHORIZATION');
    expect(await codes(world({ execution: { ...intent.execution, authorizationId: pad('0x77', { size: 32 }) as Hex } }), { intent: null })).toContain('AUTHORIZATION_MISMATCH');
  });

  it('FAILED on balances even when the logs look right: short delivery, double debit, residue with the router', async () => {
    const a0 = auth.assets[0].asset;
    expect(await codes(world({ balances: { [key(OWNER, a0)]: [BigInt(0), floors[0] - BigInt(1)] } }))).toEqual(expect.arrayContaining(['BELOW_PRICE_LIMIT', 'LOG_BALANCE_MISMATCH']));
    expect(await codes(world({ balances: { [key(OWNER, USDG)]: [BigInt(100_000_000), BigInt(100_000_000) - BigInt(2) * auth.schedule.grossAmountPerRun] } }))).toContain('SOURCE_DEBIT_MISMATCH');
    expect(await codes(world({ balances: { [key(ROUTER, a0)]: [BigInt(0), BigInt(7)] } }))).toContain('TRANSIT_BALANCE');
  });

  it('INDETERMINATE without a balance reader unless event-only evidence is requested (and labelled); reverted is FAILED; depth is respected', async () => {
    const none = await verify(world({ reader: false }));
    expect([none.status, none.issues[0].code]).toEqual(['INDETERMINATE', 'BALANCE_EVIDENCE_UNAVAILABLE']);
    const logs = await verify(world({ reader: false }), { verification: 'TRANSFER_LOGS' });
    expect([logs.status, logs.evidence]).toEqual(['VERIFIED', 'TRANSACTION_AND_TRANSFER_LOGS']);
    expect(await codes(world({ status: 'reverted' }))).toContain('TRANSACTION_REVERTED');
    expect((await verify(world(), { confirmations: 3 })).issues[0].code).toBe('INSUFFICIENT_CONFIRMATIONS');
  });
});

describe('buildRecurringRunPlan (Composer-free, on-chain quotes through the caller client)', () => {
  const auth = buildRecurringAuthorization(terms({ maxPriceRaw: Object.fromEntries(assetsOf(BAG).map((a) => [a, BigInt(1_000_000_000)])) }));
  const legIn = recurringLegAmounts(auth);
  const floors = recurringMinimumOutputs(auth);
  const NOW = auth.schedule.startsAt + BigInt(10);
  const revert = () => Object.assign(new Error('reverted'), { name: 'ContractFunctionExecutionError', cause: Object.assign(new Error('r'), { name: 'ContractFunctionRevertedError' }) });
  /** Quotes: tier 500 best for asset 0, tier 3000 best otherwise; tier 100 has no pool (revert). */
  const quoteClient = (factor = BigInt(2)) => ({
    calls: 0,
    limits: [] as bigint[],
    async simulateContract({ args }: { args: readonly unknown[] }) {
      this.calls++;
      const p = args[0] as { tokenOut: string; amountIn: bigint; fee: number; sqrtPriceLimitX96: bigint };
      const i = auth.assets.findIndex((a) => a.asset === p.tokenOut);
      this.limits[i] = p.sqrtPriceLimitX96;
      if (p.fee === 100) throw revert();
      const base = floors[i] * factor;
      const best = i === 0 ? 500 : 3000;
      return { result: [p.fee === best ? base : base - BigInt(1), BigInt(0), 0, BigInt(0)] };
    },
  });

  it('quotes every allowed tier, takes the best per asset, and builds the exact plan the executor accepts', async () => {
    const c = quoteClient();
    const r = await buildRecurringRunPlan({ client: c, auth, deployment: DEPLOYMENT, quoter: ROBINHOOD_UNISWAP_V3.quoterV2, nowSeconds: NOW, slippageBps: 100 });
    expect(c.calls).toBe(auth.assets.length * auth.route.allowedFees.length);
    // every quote is bounded by the owner's limit; the swap itself is not (sqrtPriceLimitX96 = 0 below)
    auth.assets.forEach((a, i) => expect(c.limits[i]).toBe(ownerLimitSqrtPriceX96(USDG, a.asset, a.decimals, a.maxPriceRaw)));
    expect(r.legs.map((l) => l.quoteSqrtPriceLimitX96)).toEqual(c.limits);
    expect(r.evidence).toBe('SIMULATED_ON_CHAIN_QUOTE');
    expect(r.legs.map((l) => l.fee)).toEqual(auth.assets.map((_, i) => (i === 0 ? 500 : 3000)));
    expect(r.execution).toEqual({ authorizationId: recurringAuthorizationId(auth, DEPLOYMENT), window: BigInt(0), quoteDeadline: NOW + BigInt(300) });
    expect(r.plan.wallet).toBe(EXECUTOR);
    expect(r.plan.inputAmount).toBe(auth.schedule.grossAmountPerRun);
    r.plan.legs.forEach((leg, i) => {
      const { args } = decodeFunctionData({ abi: SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI, data: leg.callData as VHex });
      const p = args[0];
      expect([p.tokenIn.toLowerCase(), p.tokenOut.toLowerCase(), p.recipient.toLowerCase()]).toEqual([USDG, auth.assets[i].asset, ROUTER]);
      expect([p.amountIn, p.sqrtPriceLimitX96]).toEqual([legIn[i], BigInt(0)]);
      expect(leg).toMatchObject({ target: ROBINHOOD_UNISWAP_V3.swapRouter02, value: BigInt(0), approveToken: USDG, approveAmount: legIn[i] });
      // max(price-limit floor, quote − 1 %)
      const q = floors[i] * BigInt(2);
      expect(r.plan.minOutputs[i]).toEqual({ token: auth.assets[i].asset, minAmountOut: q - q / BigInt(100) });
    });
    expect(routerPlanTypedData(r.plan, { chainId: 4663, router: ROUTER }).domain.name).toBe('BagExecutionRouter');
  });

  it('builds nothing below the price limit (PRICE_LIMIT_NOT_MET), without any pool (NO_ROUTE), or outside the calendar', async () => {
    const tooLow = { async simulateContract({ args }: { args: readonly unknown[] }) { const p = args[0] as { tokenOut: string }; const i = auth.assets.findIndex((a) => a.asset === p.tokenOut); return { result: [floors[i] - BigInt(1)] }; } };
    await expect(buildRecurringRunPlan({ client: tooLow, auth, deployment: DEPLOYMENT, quoter: ROBINHOOD_UNISWAP_V3.quoterV2, nowSeconds: NOW })).rejects.toMatchObject({ code: 'PRICE_LIMIT_NOT_MET', message: expect.stringMatching(/market price ~\d+ is above the FIXED max price \d+.*not made up later/) });
    const none = { async simulateContract() { throw revert(); } };
    await expect(buildRecurringRunPlan({ client: none, auth, deployment: DEPLOYMENT, quoter: ROBINHOOD_UNISWAP_V3.quoterV2, nowSeconds: NOW })).rejects.toMatchObject({ code: 'NO_ROUTE' });
    await expect(buildRecurringRunPlan({ client: quoteClient(), auth, deployment: DEPLOYMENT, quoter: ROBINHOOD_UNISWAP_V3.quoterV2, nowSeconds: auth.schedule.startsAt - BigInt(1) })).rejects.toMatchObject({ code: 'RECURRING_TERMS_INVALID' });
  });

  it('a quote that stops at the owner limit (or a pool already past it) is unusable; another tier can still serve', async () => {
    const run = (mode: 'stop' | 'spl' | 'mixed') =>
      buildRecurringRunPlan({
        client: {
          async simulateContract({ args }: { args: readonly unknown[] }) {
            const p = args[0] as { tokenOut: string; fee: number; sqrtPriceLimitX96: bigint };
            const i = auth.assets.findIndex((a) => a.asset === p.tokenOut);
            if (mode === 'spl' && i === 1) throw Object.assign(new Error('reverted'), { name: 'ContractFunctionExecutionError', cause: Object.assign(new Error('SPL'), { name: 'ContractFunctionRevertedError', reason: 'SPL' }) });
            const stops = (mode === 'stop' && i === 1) || (mode === 'mixed' && i === 1 && p.fee !== 10000);
            return { result: [floors[i] * BigInt(2), stops ? p.sqrtPriceLimitX96 : BigInt(1), 0, BigInt(0)] };
          },
        },
        auth,
        deployment: DEPLOYMENT,
        quoter: ROBINHOOD_UNISWAP_V3.quoterV2,
        nowSeconds: NOW,
      });
    await expect(run('stop')).rejects.toMatchObject({ code: 'PRICE_LIMIT_NOT_MET' });
    await expect(run('spl')).rejects.toMatchObject({ code: 'PRICE_LIMIT_NOT_MET' });
    const mixed = await run('mixed');
    expect(mixed.legs[1].fee).toBe(10000);
    expect(mixed.legs[1].alternatives.filter((a) => a.status === 'PRICE_LIMIT_REACHED').map((a) => a.fee)).toEqual([100, 500, 3000]);
  });

  it('ownerLimitSqrtPriceX96: the pool price of the owner limit, never looser, for either token order', () => {
    const unit = BigInt(10) ** BigInt(18);
    const max = BigInt(25_000_000); // 25 USDG (6 decimals) per whole token
    const Q = BigInt(1) << BigInt(192);
    // input is token0 (0x11 < 0x22): price = asset/input falls to unit/max; the bound is at or above it
    const lo = ownerLimitSqrtPriceX96('0x1100000000000000000000000000000000000000', '0x2200000000000000000000000000000000000000', 18, max);
    expect(lo * lo * max >= unit * Q).toBe(true);
    expect((lo - BigInt(1)) * (lo - BigInt(1)) * max < unit * Q).toBe(true);
    // input is token1: price = input/asset rises to max/unit; the bound is at or below it
    const hi = ownerLimitSqrtPriceX96('0x2200000000000000000000000000000000000000', '0x1100000000000000000000000000000000000000', 18, max);
    expect(hi * hi * unit <= max * Q).toBe(true);
    expect((hi + BigInt(1)) * (hi + BigInt(1)) * unit > max * Q).toBe(true);
    expectCode(() => ownerLimitSqrtPriceX96(USDG, ROUTER, 18, BigInt(0)), 'INVALID_ARGUMENT');
  });

  it('a transport failure is RPC_READ_FAILED, never "no liquidity"', async () => {
    const down = { async simulateContract() { throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' }); } };
    await expect(buildRecurringRunPlan({ client: down, auth, deployment: DEPLOYMENT, quoter: ROBINHOOD_UNISWAP_V3.quoterV2, nowSeconds: NOW })).rejects.toMatchObject({ code: 'RPC_READ_FAILED' });
  });
});
