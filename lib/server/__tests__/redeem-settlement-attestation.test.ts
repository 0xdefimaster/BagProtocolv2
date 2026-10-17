import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, recoverTypedDataAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SETTLEMENT_TYPES, settlementDomain } from '@/lib/blockchain/redeem-settlement-eip712';
import { parseDec } from '@/lib/domain/basket-protocol/accounting/decimal';

// Two-phase settlement attestation (lib/server/redeem-settlement-attestation.ts). Phase 1 quotes and records a plan
// and signs nothing; phase 2 re-reads everything, refuses unless the state still hashes to phase 1's context,
// signs one Settlement struct and refuses a final transaction whose executor is not the attested one.

// A throwaway key generated for this test only; it controls nothing.
const ATTESTOR_KEY = `0x${'22'.repeat(32)}` as const;
const SETTLEMENT = '0x00000000000000000000000000000000000005e1';
const PROXY = '0xad834b4de0295622a4042a3caa62ce5b961578e7';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const AMKR = '0xdd356aa38f40a7b7076755ac854b6fbb1f0d305b';
const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c';
const USER = '0xb193DE199EeB9bd1143607a11AD00999Ceb956b8';
const CREATOR = '0x00000000000000000000000000000000000000c1';
const ROOT = '0x00000000000000000000000000000000000000a1';

type Plan = Record<string, unknown> | null;
let intent: Record<string, unknown>;
let bag: Record<string, unknown>;
// The root of a fork's lineage, when `bag.rootBagId` names it.
let rootBag: Record<string, unknown> | null;
let version: Record<string, unknown>;
let ledger: { seq: string }[];
let wallets: { id: string; wallet_address: string }[];
let purchaseInFlight: unknown;
let frozen: boolean | Error;
let finalProxy: string;
let legOutputs: Record<number, { amountOut: string; amountOutMin: string }>;
const savedPlans: Plan[] = [];
const savedAttested: { plan: Plan; tx: unknown; expectedContext: string }[] = [];
const finalBuilds: Record<string, unknown>[] = [];
// Other intents of the same position (besides `intent`), as the repo would return them.
let otherIntents: Record<string, unknown>[] = [];
// Called once per check; lets a test make another sale appear only after phase 2's claim.
let openOthersHook: (() => void) | null = null;
const callOrder: string[] = [];
const transitions: { from: string; to: string }[] = [];
let transitionSucceeds = true;
let basisResult: { ok: true; consumedBasisQuote: bigint; lossCarryQuote: bigint } | { ok: false; reason: string };
const basis = (b: string, c: string) => ({ ok: true as const, consumedBasisQuote: parseDec(b), lossCarryQuote: parseDec(c) });

vi.mock('@/lib/config/robinhood-chain', async (orig) => ({ ...(await orig<object>()), DEPLOYED_CONTRACTS: { redeemSettlement: SETTLEMENT } }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({
  getRedeemIntentForUser: async () => ({ ok: true, intent }),
  updateRedeemIntentStatus: async (_a: unknown, u: { from: string; to: string }) => {
    transitions.push({ from: u.from, to: u.to });
    if (!transitionSucceeds) return null;
    intent = { ...intent, status: u.to };
    return intent;
  },
  setRedeemSettlementPlan: async (_a: unknown, _id: string, _s: string, plan: Plan) => {
    savedPlans.push(plan);
    intent = { ...intent, settlementPlan: plan };
    return intent;
  },
  setRedeemSettlementAttested: async (_a: unknown, _id: string, _s: string, expectedContext: string, plan: Plan, tx: unknown) => {
    savedAttested.push({ plan, tx, expectedContext });
    return intent;
  },
  claimRedeemSettlementAttestation: async (_a: unknown, _id: string, _s: string, plan: Plan) => {
    callOrder.push('claim');
    intent = { ...intent, settlementPlan: plan };
    return intent;
  },
  listOpenRedeemIntentsForBag: async () => {
    callOrder.push('checkOthers');
    openOthersHook?.();
    const all = [intent, ...otherIntents];
    return all.filter((i) => ['DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMING'].includes(i.status as string));
  },
  listLiveSettlementAttestations: async () => {
    const now = Math.floor(Date.now() / 1000);
    return [intent, ...otherIntents].filter((i) => {
      const d = (i.settlementPlan as { deadline?: number } | null)?.deadline;
      return typeof d === 'number' && d >= now;
    });
  },
}));
vi.mock('@/lib/server/sale-coverage', () => ({ checkSaleCoverage: async () => 'COVERED' }));
vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: async (_a: unknown, id: string) => (rootBag && id === rootBag.id ? rootBag : bag),
  getCurrentBagVersion: async () => version,
}));
vi.mock('@/lib/server/ledger-repo', () => ({ listAllLedgerEventsForPosition: async () => ledger }));
vi.mock('@/lib/server/fee-redemption-lock', () => ({ purchaseInFlightFor: async () => purchaseInFlight }));
vi.mock('@/lib/domain/basket-protocol/accounting/position-pnl', () => ({ computePositionPnl: () => ({}) }));
vi.mock('@/lib/domain/basket-protocol/redeem/performance-fee-b0', async (orig) => ({
  ...(await orig<object>()),
  feeBasisFromPositionPnl: () => basisResult,
}));
vi.mock('@/lib/server/asset-repo', () => ({
  getAssetsByIdentities: async (_a: unknown, ids: { chain: string; address: string }[]) => ids.map((i) => ({ ...i, decimals: 18 })),
}));
// AMKR $56.50, SPY $770 → 0.02 AMKR ≈ $1.13, 0.0017 SPY ≈ $1.309
vi.mock('@/lib/server/price-provider', () => ({
  getPriceProvider: () => ({ getPrice: async ({ address }: { address: string }) => ({ price: address.toLowerCase() === AMKR ? '56.5' : '770' }) }),
}));
vi.mock('@/lib/blockchain/robinhood-public-client', () => ({
  getRobinhoodPublicClient: () => ({
    readContract: async () => {
      if (frozen instanceof Error) throw frozen;
      return frozen;
    },
  }),
}));
vi.mock('@/lib/blockchain/lifi-composer-adapter', async (orig) => ({
  ...(await orig<object>()),
  buildComposerSweep: async (req: { inputs: unknown[] }) => ({
    userProxy: PROXY,
    approvals: [],
    transactionRequest: { to: PROXY, data: '0x', value: '0' },
    outputs: Object.fromEntries(req.inputs.map((_x, i) => [`sweep_${i}.amountOut`, out(legOutputs[i].amountOut, legOutputs[i].amountOutMin)])),
    kept: req.inputs,
  }),
  buildComposerSettlementRedeem: async (req: Record<string, unknown>) => {
    callOrder.push('signedAndBuilt');
    finalBuilds.push(req);
    return {
      userProxy: finalProxy,
      approvals: [{ token: AMKR, spender: finalProxy, amountRaw: '20000000000000000' }],
      transactionRequest: { to: finalProxy, data: `0xdeadbeef${SETTLEMENT.slice(2)}`, value: '0', chainId: 4663 },
      outputs: {},
    };
  },
}));

const svc = await import('../redeem-settlement-attestation');
const { out } = await import('@/lib/blockchain/__tests__/composer-fixtures');
const { ExecutionPriceTooLowError } = await import('../redeem-fee-attestation');
const { quoteSettlement, attestSettlement } = svc;

const admin = {
  from: () => ({ select: () => ({ in: async () => ({ data: wallets, error: null }) }) }),
} as never;

beforeEach(() => {
  transitions.length = 0;
  transitionSucceeds = true;
  process.env.REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY = ATTESTOR_KEY;
  process.env.LIFI_API_KEY = 'test-key';
  intent = {
    id: '6f1c2b3a-0000-4000-8000-000000000001',
    bagId: '11111111-2222-3333-4444-555555555555',
    walletAddress: USER,
    status: 'READY',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    sharesRaw: '100',
    steps: [
      { action: 'SWAP', inputAsset: { chain: 'robinhood', address: AMKR }, inputAmountRaw: '20000000000000000' },
      { action: 'SWAP', inputAsset: { chain: 'robinhood', address: SPY }, inputAmountRaw: '1700000000000000' },
    ],
    settlementPlan: null,
  };
  bag = { id: intent.bagId, creatorId: 'creator', performanceFeeBpsLocked: 1000, contractAddress: '0x00000000000000000000000000000000000000b1' };
  rootBag = null;
  version = { version: 3, compositionHash: 'c0ffee12', recipe: { performanceFeeBps: 1000 } };
  ledger = [{ seq: '810' }, { seq: '812' }];
  wallets = [
    { id: 'creator', wallet_address: CREATOR },
    { id: 'user', wallet_address: USER },
  ];
  purchaseInFlight = null;
  frozen = false;
  finalProxy = PROXY;
  legOutputs = { 0: { amountOut: '1129985', amountOutMin: '1118685' }, 1: { amountOut: '1314781', amountOutMin: '1301633' } };
  basisResult = basis('2', '0');
  otherIntents = [];
  openOthersHook = null;
  callOrder.length = 0;
  savedPlans.length = 0;
  savedAttested.length = 0;
  finalBuilds.length = 0;
});

describe('phase 1 — quoteSettlement: quote, price quality, plan; signs nothing', () => {
  it('records a plan: context hash, executor = the Composer proxy, ledger basis, locked rate, floor from Σ enforced minimums', async () => {
    const q = await quoteSettlement(admin, 'user', intent.id as string);
    expect(q.plan).toMatchObject({
      schema: 1,
      settlement: getAddress(SETTLEMENT),
      executor: getAddress(PROXY),
      user: getAddress(USER),
      creator: getAddress(CREATOR),
      consumedBasisRaw: '2000000',
      lossCarryRaw: '0',
      feeRateBps: 1000,
      grossMinimumRaw: '2420318', // 1118685 + 1301633
    });
    // floor: 2420318 − floor((2420318 − 2000000) × 10%) = 2420318 − 42031
    expect(q.plan.minUserProceedsRaw).toBe('2378287');
    expect(q.feeAtMinimumRaw).toBe('42031');
    expect(q.plan.contextHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Date(q.plan.expiresAt).getTime()).toBeLessThanOrEqual(new Date(intent.expiresAt as string).getTime());
    expect(savedPlans).toHaveLength(1);
    expect(finalBuilds).toHaveLength(0); // no final transaction, no signature in phase 1
  });

  it('#16: a leg quoted more than 5% below its verified value is refused', async () => {
    legOutputs[1] = { amountOut: '1200000', amountOutMin: '1188000' }; // SPY worth 1.309 → 8.3% below
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(ExecutionPriceTooLowError);
    expect(savedPlans).toHaveLength(0);
  });

  it('a purchase in flight, unknown basis, or an expired intent: no plan', async () => {
    purchaseInFlight = { id: 'p' };
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toThrow(/purchase of this Bag/);
    purchaseInFlight = null;
    basisResult = { ok: false, reason: 'BASIS_UNKNOWN' };
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toThrow(/BASIS_UNKNOWN/);
    basisResult = basis('2', '0');
    intent = { ...intent, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toThrow(/expired/);
    expect(savedPlans).toHaveLength(0);
  });

  it('the plan never outlives the intent', async () => {
    intent = { ...intent, expiresAt: new Date(Date.now() + 60 * 1000).toISOString() };
    const q = await quoteSettlement(admin, 'user', intent.id as string);
    expect(q.plan.expiresAt).toBe(intent.expiresAt);
  });
});

describe('phase 2 — attestSettlement: re-check, sign, final transaction', () => {
  it('signs exactly the Settlement struct — every field bound — and the attestor recovers from it', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    const a = await attestSettlement(admin, 'user', intent.id as string);
    expect(Object.keys(a.message).sort()).toEqual(SETTLEMENT_TYPES.Settlement.map((f) => f.name).sort());
    const plan = savedPlans[0] as Record<string, string>;
    expect(a.message).toMatchObject({
      user: getAddress(USER),
      creator: getAddress(CREATOR),
      executor: getAddress(PROXY),
      contextHash: plan.contextHash,
      consumedBasis: '2000000',
      lossCarry: '0',
      feeRateBps: '1000',
      minUserProceeds: plan.minUserProceedsRaw,
    });
    const recovered = await recoverTypedDataAddress({
      domain: settlementDomain(4663, getAddress(SETTLEMENT)),
      types: SETTLEMENT_TYPES,
      primaryType: 'Settlement',
      message: {
        ...a.message,
        consumedBasis: BigInt(a.message.consumedBasis),
        lossCarry: BigInt(a.message.lossCarry),
        feeRateBps: BigInt(a.message.feeRateBps),
        minUserProceeds: BigInt(a.message.minUserProceeds),
        deadline: BigInt(a.message.deadline),
      } as never,
      signature: a.signature,
    });
    expect(recovered).toBe(privateKeyToAccount(ATTESTOR_KEY).address);
    // The final flow carries the same signed values, and no fee amount anywhere.
    const settle = finalBuilds[0].settle as Record<string, unknown>;
    expect(Object.keys(settle).sort()).toEqual([...SETTLEMENT_TYPES.Settlement.map((f) => f.name), 'r', 'vs'].sort());
    expect(JSON.stringify(finalBuilds[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/"fee(Amount)?"/);
    expect(savedAttested).toHaveLength(1);
    expect(savedAttested[0].expectedContext).toBe(plan.contextHash);
    // The wallet signs next: the intent moves to AWAITING_SIGNATURE so the step reports and verification take over.
    expect(transitions).toEqual([{ from: 'READY', to: 'AWAITING_SIGNATURE' }]);
  });

  it('the intent moved on while attesting (READY → AWAITING_SIGNATURE refused): the attestation is not handed out', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    transitionSucceeds = false;
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.SettlementStateChangedError);
  });

  it('expiry: the deadline is never past the intent or the plan', async () => {
    intent = { ...intent, expiresAt: new Date(Date.now() + 90 * 1000).toISOString() };
    await quoteSettlement(admin, 'user', intent.id as string);
    const a = await attestSettlement(admin, 'user', intent.id as string);
    expect(a.deadline * 1000).toBeLessThanOrEqual(new Date(intent.expiresAt as string).getTime());
    expect(a.deadline * 1000).toBeLessThanOrEqual(new Date((savedPlans[0] as Record<string, string>).expiresAt).getTime());
  });

  it('TOCTOU: any change to the state phase 1 checked → refused, nothing signed or compiled', async () => {
    const changes: [string, () => void][] = [
      ['a new ledger event', () => ledger.push({ seq: '813' })],
      ['a different basis', () => (basisResult = basis('1.9', '0'))],
      ['a loss carry appeared', () => (basisResult = basis('2', '0.1'))],
      ['a different locked rate', () => (bag = { ...bag, performanceFeeBpsLocked: 1500 })],
      ['a new strategy version', () => (version = { ...version, version: 4 })],
      ['a different creator wallet', () => (wallets = [{ id: 'creator', wallet_address: '0x00000000000000000000000000000000000000c2' }, wallets[1]])],
      ['a different quantity sold', () => (intent = { ...intent, steps: [{ ...(intent.steps as object[])[0], inputAmountRaw: '19000000000000000' }, (intent.steps as object[])[1]] })],
    ];
    for (const [name, change] of changes) {
      // fresh intent/state for each case
      const snapshot = { intent: { ...intent, settlementPlan: null }, bag: { ...bag }, version: { ...version }, ledger: [...ledger], wallets: [...wallets] };
      basisResult = basis('2', '0');
      await quoteSettlement(admin, 'user', intent.id as string);
      change();
      await expect(attestSettlement(admin, 'user', intent.id as string), name).rejects.toBeInstanceOf(svc.SettlementStateChangedError);
      expect(finalBuilds, name).toHaveLength(0);
      expect(savedAttested, name).toHaveLength(0);
      ({ intent, bag, version, ledger, wallets } = snapshot);
    }
  });

  it('a purchase that starts between the phases is refused too', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    purchaseInFlight = { id: 'p' };
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toThrow(/purchase of this Bag/);
    expect(finalBuilds).toHaveLength(0);
  });

  it('no plan, or an expired plan → nothing signed', async () => {
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.SettlementPlanMissingError);
    await quoteSettlement(admin, 'user', intent.id as string);
    intent = { ...intent, settlementPlan: { ...(intent.settlementPlan as object), expiresAt: new Date(Date.now() - 1).toISOString() } };
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.SettlementPlanMissingError);
    expect(finalBuilds).toHaveLength(0);
  });

  it('executor: a final transaction compiled for another proxy is refused and not recorded', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    finalProxy = '0x00000000000000000000000000000000000000e9';
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.ExecutorMismatchError);
    expect(savedAttested).toHaveLength(0);
  });

  it('creator freeze preflight: frozen → refused; an unreadable freeze state does not block (the contract still fails closed)', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    frozen = true;
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.CreatorFrozenError);
    frozen = new Error('no isFrozen on this token');
    await expect(attestSettlement(admin, 'user', intent.id as string)).resolves.toMatchObject({ deadline: expect.any(Number) });
  });

  it('not a fork: rootCreator is signed as the zero address and recorded as null', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    const a = await attestSettlement(admin, 'user', intent.id as string);
    expect(a.message.rootCreator).toBe(zeroAddress);
    expect((savedPlans[0] as Record<string, unknown>).rootCreator).toBeNull();
  });

  it('a fork by someone else: the ROOT bag\'s creator wallet is signed, in the context hash and in the final flow', async () => {
    rootBag = { id: 'root-bag', creatorId: 'root' };
    bag = { ...bag, rootBagId: 'root-bag' };
    wallets = [...wallets, { id: 'root', wallet_address: ROOT }];
    await quoteSettlement(admin, 'user', intent.id as string);
    const plan = savedPlans[0] as Record<string, unknown>;
    expect(plan.rootCreator).toBe(getAddress(ROOT));
    const a = await attestSettlement(admin, 'user', intent.id as string);
    expect(a.message.rootCreator).toBe(getAddress(ROOT));
    expect((finalBuilds[0].settle as Record<string, unknown>).rootCreator).toBe(getAddress(ROOT));
    // The same Bag without the root in its lineage hashes differently: the root creator is part of the context.
    rootBag = null;
    bag = { ...bag, rootBagId: null };
    intent = { ...intent, status: 'READY', settlementPlan: null };
    savedPlans.length = 0;
    await quoteSettlement(admin, 'user', intent.id as string);
    expect((savedPlans[0] as Record<string, unknown>).contextHash).not.toBe(plan.contextHash);
  });

  it('a fork whose root creator is its own creator pays no royalty; a root creator with no wallet blocks the sale rather than skipping the royalty', async () => {
    rootBag = { id: 'root-bag', creatorId: 'creator' };
    bag = { ...bag, rootBagId: 'root-bag' };
    await quoteSettlement(admin, 'user', intent.id as string);
    expect((savedPlans[0] as Record<string, unknown>).rootCreator).toBeNull();
    rootBag = { id: 'root-bag', creatorId: 'root' };
    intent = { ...intent, settlementPlan: null };
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toThrow(/root creator has no wallet_address/);
  });

  it('TOCTOU: the root creator\'s wallet changing between the phases → refused, nothing signed', async () => {
    rootBag = { id: 'root-bag', creatorId: 'root' };
    bag = { ...bag, rootBagId: 'root-bag' };
    wallets = [...wallets, { id: 'root', wallet_address: ROOT }];
    await quoteSettlement(admin, 'user', intent.id as string);
    wallets = [...wallets.slice(0, 2), { id: 'root', wallet_address: '0x00000000000000000000000000000000000000a2' }];
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.SettlementStateChangedError);
    expect(finalBuilds).toHaveLength(0);
    expect(savedAttested).toHaveLength(0);
  });

  it('a creator selling their own Bag: rate 0 is signed, so the contract charges nothing', async () => {
    wallets = [{ id: 'user', wallet_address: USER }];
    bag = { ...bag, creatorId: 'user' };
    await quoteSettlement(admin, 'user', intent.id as string);
    const a = await attestSettlement(admin, 'user', intent.id as string);
    expect(a.message.feeRateBps).toBe('0');
    expect(a.message.consumedBasis).toBe('0');
  });

  // ChatGPT's scenario (§9): A is attested, then another valid sale changes the ledger, then A's old signature is
  // submitted before its deadline. The contract cannot tell the context is stale — so step 2 must be impossible.
  it('stale-attestation scenario: while A\'s attestation is valid on-chain, no other sale of the position can be quoted or attested — even after A is FAILED in the database', async () => {
    // 1. A is attested.
    await quoteSettlement(admin, 'user', intent.id as string);
    const a = await attestSettlement(admin, 'user', intent.id as string);
    expect(a.deadline * 1000).toBeGreaterThan(Date.now());
    // A's transaction reverted (e.g. slippage); the database marks it FAILED. Its signature is still valid until its
    // deadline and the wallet still holds the transaction.
    const attestedA: Record<string, unknown> = { ...intent, status: 'FAILED' };
    // 2. Another sale B of the same position tries to start.
    otherIntents = [attestedA];
    intent = { ...intent, id: '6f1c2b3a-0000-4000-8000-0000000000b2', status: 'READY', settlementPlan: null };
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.AnotherSaleOpenError);
    finalBuilds.length = 0;
    // Even a B that already has a plan cannot be attested.
    otherIntents = [];
    await quoteSettlement(admin, 'user', intent.id as string);
    otherIntents = [attestedA];
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.AnotherSaleOpenError);
    expect(finalBuilds).toHaveLength(0);
    // Once A's deadline has passed, A's signature is dead on-chain and B may proceed.
    otherIntents = [{ ...attestedA, settlementPlan: { ...(attestedA.settlementPlan as object), deadline: Math.floor(Date.now() / 1000) - 1 } }];
    await expect(attestSettlement(admin, 'user', intent.id as string)).resolves.toMatchObject({ deadline: expect.any(Number) });
  });

  it('an open (non-terminal) other sale of the position blocks both phases', async () => {
    otherIntents = [{ id: 'other', status: 'SUBMITTED', settlementPlan: null }];
    await expect(quoteSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.AnotherSaleOpenError);
  });

  it('write-then-check: phase 2 records its claim before it looks for other sales and before it signs; a sale appearing after the claim is still caught', async () => {
    await quoteSettlement(admin, 'user', intent.id as string);
    callOrder.length = 0;
    // A concurrent sale B writes its intent just after phase 2 claimed.
    openOthersHook = () => {
      if (callOrder.includes('claim')) otherIntents = [{ id: 'concurrent', status: 'READY', settlementPlan: null }];
    };
    await expect(attestSettlement(admin, 'user', intent.id as string)).rejects.toBeInstanceOf(svc.AnotherSaleOpenError);
    expect(callOrder.indexOf('claim')).toBeGreaterThan(-1);
    expect(callOrder.lastIndexOf('checkOthers')).toBeGreaterThan(callOrder.indexOf('claim'));
    expect(callOrder).not.toContain('signedAndBuilt');
  });
});
