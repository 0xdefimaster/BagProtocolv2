import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeFunctionData, parseUnits, zeroAddress, keccak256, toHex, pad } from 'viem';

// -----------------------------------------------------------------------------
// Item 7 — BagExecutionRouter security-boundary tests.
//
// These deliberately concentrate on the boundaries that separate this
// contract from contracts/spike/BagRouterSpike.sol, because "it compiles and
// the happy path works" is exactly what a spike already does. The cases that
// matter are the ones where a plan, a signature, a target, or an injected
// balance is HOSTILE — those are the tests that would fail against the spike.
// -----------------------------------------------------------------------------

const SWAP_POOL_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const ERC20_ABI = [
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

const RATE_NUM = 2n; // 1 input token -> 2 output tokens
const RATE_DEN = 1n;

const INPUT_AMOUNT = parseUnits('100', 18);
const LEG_A_IN = parseUnits('60', 18);
const LEG_B_IN = parseUnits('40', 18);
const LEG_A_OUT = (LEG_A_IN * RATE_NUM) / RATE_DEN; // 120 TOKA
const LEG_B_OUT = (LEG_B_IN * RATE_NUM) / RATE_DEN; // 80 TOKB

// off-chain ref for the test Bag; the on-chain bagId is creator-bound and derived in setup().
const BAG_OFF_CHAIN_REF = pad('0x1234', { size: 32 });
const PLAN_HASH = keccak256(toHex('execution-plan-hash-1'));

function encodeSwap(amountIn: bigint, minAmountOut: bigint, recipient: `0x${string}`) {
  return encodeFunctionData({ abi: SWAP_POOL_ABI, functionName: 'swap', args: [amountIn, minAmountOut, recipient] });
}

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, planSigner, user, attacker, victim] = await viem.getWalletClients();

  const inputToken = await viem.deployContract('MockToken', ['Input', 'IN', 18]);
  const tokenA = await viem.deployContract('MockToken', ['Target A', 'TOKA', 18]);
  const tokenB = await viem.deployContract('MockToken', ['Target B', 'TOKB', 18]);

  // Real BagFactory + a real registered Bag — the router's trusted registry
  // (item 6: reuse, never duplicate, Bag/BagFactory concepts).
  // User-signed factory: the Bag's creator is whoever calls createBag() (here: `user`).
  const factory = await viem.deployContract('BagFactory', [owner.account.address, owner.account.address, 0n, 0n]);
  const factoryAsUser = await viem.getContractAt('BagFactory', factory.address, { client: { wallet: user } });
  await factoryAsUser.write.createBag([BAG_OFF_CHAIN_REF, keccak256(toHex('composition')), 'ipfs://x', true]);
  const BAG_ID = (await factory.read.deriveBagId([user.account.address, BAG_OFF_CHAIN_REF])) as `0x${string}`;

  const router = await viem.deployContract('BagExecutionRouter', [
    factory.address,
    owner.account.address,
    planSigner.account.address,
  ]);

  const poolA = await viem.deployContract('TestSwapPool', [inputToken.address, tokenA.address, RATE_NUM, RATE_DEN]);
  const poolB = await viem.deployContract('TestSwapPool', [inputToken.address, tokenB.address, RATE_NUM, RATE_DEN]);

  // Seed pools with their output tokens.
  const seedAmount = parseUnits('1000000', 18);
  for (const [tok, pool] of [
    [tokenA, poolA],
    [tokenB, poolB],
  ] as const) {
    await tok.write.mint([owner.account.address, seedAmount]);
    const tokAsOwner = await viem.getContractAt('MockToken', tok.address, { client: { wallet: owner } });
    await tokAsOwner.write.approve([pool.address, seedAmount]);
    const poolAsOwner = await viem.getContractAt('TestSwapPool', pool.address, { client: { wallet: owner } });
    await poolAsOwner.write.seed([seedAmount]);
  }

  await inputToken.write.mint([user.account.address, INPUT_AMOUNT * 10n]);
  const inputAsUser = await viem.getContractAt('MockToken', inputToken.address, { client: { wallet: user } });
  await inputAsUser.write.approve([router.address, INPUT_AMOUNT * 10n]);

  const routerAsOwner = await viem.getContractAt('BagExecutionRouter', router.address, { client: { wallet: owner } });
  await routerAsOwner.write.setAllowedTarget([poolA.address, true]);
  await routerAsOwner.write.setAllowedTarget([poolB.address, true]);
  await routerAsOwner.write.setAllowedToken([inputToken.address, true]);
  await routerAsOwner.write.setAllowedToken([tokenA.address, true]);
  await routerAsOwner.write.setAllowedToken([tokenB.address, true]);

  const routerAsUser = await viem.getContractAt('BagExecutionRouter', router.address, { client: { wallet: user } });
  const routerAsAttacker = await viem.getContractAt('BagExecutionRouter', router.address, {
    client: { wallet: attacker },
  });

  const chainId = await publicClient.getChainId();
  const domain = {
    name: 'BagExecutionRouter',
    version: '1',
    chainId,
    verifyingContract: router.address,
  } as const;

  interface PlanInput {
    bagId?: `0x${string}`;
    executionPlanHash?: `0x${string}`;
    wallet?: `0x${string}`;
    inputToken?: `0x${string}`;
    inputAmount?: bigint;
    deadline?: bigint;
    legs?: { target: `0x${string}`; callData: `0x${string}`; value: bigint; approveToken: `0x${string}`; approveAmount: bigint }[];
    minOutputs?: { token: `0x${string}`; minAmountOut: bigint }[];
  }

  function defaultLegs() {
    return [
      {
        target: poolA.address,
        callData: encodeSwap(LEG_A_IN, 0n, router.address),
        value: 0n,
        approveToken: inputToken.address,
        approveAmount: LEG_A_IN,
      },
      {
        target: poolB.address,
        callData: encodeSwap(LEG_B_IN, 0n, router.address),
        value: 0n,
        approveToken: inputToken.address,
        approveAmount: LEG_B_IN,
      },
    ];
  }

  function buildPlan(overrides: PlanInput = {}) {
    return {
      bagId: overrides.bagId ?? BAG_ID,
      executionPlanHash: overrides.executionPlanHash ?? PLAN_HASH,
      wallet: overrides.wallet ?? user.account.address,
      inputToken: overrides.inputToken ?? inputToken.address,
      inputAmount: overrides.inputAmount ?? INPUT_AMOUNT,
      deadline: overrides.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
      legs: overrides.legs ?? defaultLegs(),
      minOutputs:
        overrides.minOutputs ?? [
          { token: tokenA.address, minAmountOut: LEG_A_OUT },
          { token: tokenB.address, minAmountOut: LEG_B_OUT },
        ],
    };
  }

  async function signPlan(plan: ReturnType<typeof buildPlan>, signer = planSigner) {
    return signer.signTypedData({ domain, types: PLAN_TYPES, primaryType: 'ExecutionPlan', message: plan });
  }

  async function signedPlan(overrides: PlanInput = {}, signer = planSigner) {
    const plan = buildPlan(overrides);
    const signature = await signPlan(plan, signer);
    return { plan, signature };
  }

  return {
    viem,
    publicClient,
    owner,
    planSigner,
    user,
    attacker,
    victim,
    inputToken,
    tokenA,
    tokenB,
    factory,
    router,
    routerAsOwner,
    routerAsUser,
    routerAsAttacker,
    poolA,
    poolB,
    domain,
    buildPlan,
    signPlan,
    signedPlan,
    defaultLegs,
  };
}

describe('BagExecutionRouter — happy path', () => {
  it('executes a multi-leg plan in one transaction and returns every output to the caller', async () => {
    const { routerAsUser, signedPlan, tokenA, tokenB, user } = await setup();
    const { plan, signature } = await signedPlan();

    await routerAsUser.write.execute([plan, signature]);

    assert.equal((await tokenA.read.balanceOf([user.account.address])) as bigint, LEG_A_OUT);
    assert.equal((await tokenB.read.balanceOf([user.account.address])) as bigint, LEG_B_OUT);
  });

  it('leaves no token balance and no leftover allowance on the router after a successful execution', async () => {
    const { routerAsUser, signedPlan, router, inputToken, tokenA, tokenB, poolA, poolB } = await setup();
    const { plan, signature } = await signedPlan();

    await routerAsUser.write.execute([plan, signature]);

    assert.equal((await inputToken.read.balanceOf([router.address])) as bigint, 0n);
    assert.equal((await tokenA.read.balanceOf([router.address])) as bigint, 0n);
    assert.equal((await tokenB.read.balanceOf([router.address])) as bigint, 0n);
    // Approval leakage: a surviving allowance is a standing right to pull
    // this router's funds later.
    assert.equal((await inputToken.read.allowance([router.address, poolA.address])) as bigint, 0n);
    assert.equal((await inputToken.read.allowance([router.address, poolB.address])) as bigint, 0n);
  });

  it('returns unconsumed input to the caller rather than retaining it', async () => {
    const { routerAsUser, signedPlan, inputToken, user, router, poolA, poolB, tokenA, tokenB } = await setup();
    const balanceBefore = (await inputToken.read.balanceOf([user.account.address])) as bigint;

    // Legs consume only 60 + 30 of the 100 pulled — 10 must come back.
    const partialB = parseUnits('30', 18);
    const { plan, signature } = await signedPlan({
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN,
        },
        {
          target: poolB.address,
          callData: encodeSwap(partialB, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: partialB,
        },
      ],
      minOutputs: [
        { token: tokenA.address, minAmountOut: LEG_A_OUT },
        { token: tokenB.address, minAmountOut: (partialB * RATE_NUM) / RATE_DEN },
      ],
    });

    await routerAsUser.write.execute([plan, signature]);

    const spent = LEG_A_IN + partialB;
    assert.equal((await inputToken.read.balanceOf([user.account.address])) as bigint, balanceBefore - spent);
    assert.equal((await inputToken.read.balanceOf([router.address])) as bigint, 0n);
  });
});

describe('BagExecutionRouter — leftover refunds', () => {
  it('refunds only THIS execution\'s unspent input — pre-existing input-token dust stays in the router', async () => {
    const { routerAsUser, signedPlan, inputToken, user, router, attacker, viem } = await setup();
    const dust = parseUnits('5', 18);
    await inputToken.write.mint([attacker.account.address, dust]);
    const inputAsAttacker = await viem.getContractAt('MockToken', inputToken.address, { client: { wallet: attacker } });
    await inputAsAttacker.write.transfer([router.address, dust]);
    const balanceBefore = (await inputToken.read.balanceOf([user.account.address])) as bigint;

    const { plan, signature } = await signedPlan();
    await routerAsUser.write.execute([plan, signature]);

    assert.equal((await inputToken.read.balanceOf([user.account.address])) as bigint, balanceBefore - LEG_A_IN - LEG_B_IN);
    assert.equal((await inputToken.read.balanceOf([router.address])) as bigint, dust);
  });

  it('returns native value a leg refunded to the caller instead of keeping it in the router', async () => {
    const { viem, publicClient, routerAsOwner, routerAsUser, signedPlan, router, inputToken, poolA, tokenA } = await setup();
    const refunder = await viem.deployContract('NativeRefundTarget', []);
    await routerAsOwner.write.setAllowedTarget([refunder.address, true]);
    const value = parseUnits('1', 18);

    const { plan, signature } = await signedPlan({
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN,
        },
        {
          target: refunder.address,
          callData: encodeFunctionData({
            abi: [{ type: 'function', name: 'spendHalf', stateMutability: 'payable', inputs: [], outputs: [] }] as const,
            functionName: 'spendHalf',
            args: [],
          }),
          value,
          approveToken: zeroAddress,
          approveAmount: 0n,
        },
      ],
      minOutputs: [{ token: tokenA.address, minAmountOut: LEG_A_OUT }],
    });

    await routerAsUser.write.execute([plan, signature], { value });

    assert.equal(await publicClient.getBalance({ address: router.address }), 0n);
    assert.equal(await publicClient.getBalance({ address: refunder.address }), value / 2n);
  });
});

describe('BagExecutionRouter — plan authenticity and staleness', () => {
  it('rejects a plan signed by anyone other than the configured planSigner', async () => {
    const { routerAsUser, signedPlan, attacker } = await setup();
    const { plan, signature } = await signedPlan({}, attacker);

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /InvalidPlanSignature/);
  });

  it('rejects a plan whose economically meaningful fields were altered after signing', async () => {
    const { routerAsUser, signedPlan, tokenA, tokenB } = await setup();
    const { plan, signature } = await signedPlan();

    // Lower the required output — the classic "make my bad execution pass"
    // tamper. The signature no longer matches the struct.
    const tampered = {
      ...plan,
      minOutputs: [
        { token: tokenA.address, minAmountOut: 1n },
        { token: tokenB.address, minAmountOut: 1n },
      ],
    };
    await assert.rejects(routerAsUser.write.execute([tampered, signature]), /InvalidPlanSignature/);
  });

  it('rejects tampered leg calldata even when the target is still allowlisted', async () => {
    const { routerAsUser, signedPlan, router, inputToken, poolA } = await setup();
    const { plan, signature } = await signedPlan();

    const tampered = {
      ...plan,
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN * 2n, // inflated approval
        },
        plan.legs[1],
      ],
    };
    await assert.rejects(routerAsUser.write.execute([tampered, signature]), /InvalidPlanSignature/);
  });

  it('rejects an expired plan (stale execution)', async () => {
    const { routerAsUser, signedPlan } = await setup();
    const { plan, signature } = await signedPlan({ deadline: 1n });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /PlanExpired/);
  });

  it('rejects a replayed plan — a signed plan is strictly single-use', async () => {
    const { routerAsUser, signedPlan } = await setup();
    const { plan, signature } = await signedPlan();

    await routerAsUser.write.execute([plan, signature]);
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /PlanAlreadyExecuted/);
  });

  it("rejects execution of another user's plan (wallet binding)", async () => {
    const { routerAsAttacker, signedPlan, user } = await setup();
    const { plan, signature } = await signedPlan({ wallet: user.account.address });

    await assert.rejects(routerAsAttacker.write.execute([plan, signature]), /WalletMismatch/);
  });

  it('rejects a plan for a bagId the trusted BagFactory does not recognise', async () => {
    const { routerAsUser, signedPlan } = await setup();
    const { plan, signature } = await signedPlan({ bagId: pad('0xdead', { size: 32 }) });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /UnknownBag/);
  });
});

describe('BagExecutionRouter — arbitrary execution prevention', () => {
  it('rejects a leg whose target is not allowlisted', async () => {
    const { routerAsUser, signedPlan, inputToken, attacker, router } = await setup();
    const { plan, signature } = await signedPlan({
      legs: [
        {
          target: attacker.account.address,
          callData: '0x',
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: 1n,
        },
      ],
    });
    void router;

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TargetNotAllowed/);
  });

  it('CRITICAL: refuses to call a token contract as a leg target, even if an operator allowlisted it — this is the exact hole that would let leg calldata be transferFrom(victim, attacker, ...)', async () => {
    const { routerAsOwner, routerAsUser, signedPlan, inputToken, attacker, victim } = await setup();

    // Simulate operator error / a compromised allowlist entry: the input
    // token is added as a call TARGET as well as a token.
    await routerAsOwner.write.setAllowedTarget([inputToken.address, true]);

    const drainCallData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transferFrom',
      args: [victim.account.address, attacker.account.address, parseUnits('1', 18)],
    });

    const { plan, signature } = await signedPlan({
      legs: [
        { target: inputToken.address, callData: drainCallData, value: 0n, approveToken: zeroAddress, approveAmount: 0n },
      ],
    });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TargetIsToken/);
  });

  it('refuses a leg targeting the router itself', async () => {
    const { routerAsOwner, routerAsUser, signedPlan, router } = await setup();
    await routerAsOwner.write.setAllowedTarget([router.address, true]);

    const { plan, signature } = await signedPlan({
      legs: [{ target: router.address, callData: '0x', value: 0n, approveToken: zeroAddress, approveAmount: 0n }],
    });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TargetNotAllowed/);
  });

  it('refuses a leg targeting the trusted BagFactory', async () => {
    const { routerAsOwner, routerAsUser, signedPlan, factory } = await setup();
    await routerAsOwner.write.setAllowedTarget([factory.address, true]);

    const { plan, signature } = await signedPlan({
      legs: [{ target: factory.address, callData: '0x', value: 0n, approveToken: zeroAddress, approveAmount: 0n }],
    });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TargetNotAllowed/);
  });

  it('rejects a non-allowlisted input token', async () => {
    const { viem, routerAsUser, signedPlan } = await setup();
    const rogue = await viem.deployContract('MockToken', ['Rogue', 'RGE', 18]);

    const { plan, signature } = await signedPlan({ inputToken: rogue.address });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TokenNotAllowed/);
  });

  it('rejects a non-allowlisted output token in minOutputs', async () => {
    const { viem, routerAsUser, signedPlan } = await setup();
    const rogue = await viem.deployContract('MockToken', ['Rogue', 'RGE', 18]);

    const { plan, signature } = await signedPlan({ minOutputs: [{ token: rogue.address, minAmountOut: 1n }] });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TokenNotAllowed/);
  });

  it('rejects an approveToken that is not an allowlisted asset', async () => {
    const { viem, routerAsUser, signedPlan, poolA, router } = await setup();
    const rogue = await viem.deployContract('MockToken', ['Rogue', 'RGE', 18]);

    const { plan, signature } = await signedPlan({
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: rogue.address,
          approveAmount: LEG_A_IN,
        },
      ],
    });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TokenNotAllowed/);
  });
});

describe('BagExecutionRouter — output integrity', () => {
  it('reverts the whole transaction when a leg fails, leaving the caller whole', async () => {
    const { routerAsUser, signedPlan, router, inputToken, user, poolA, poolB, tokenA } = await setup();
    const balanceBefore = (await inputToken.read.balanceOf([user.account.address])) as bigint;

    // Leg B demands an unreachable minimum from the pool itself.
    const { plan, signature } = await signedPlan({
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN,
        },
        {
          target: poolB.address,
          callData: encodeSwap(LEG_B_IN, parseUnits('999999', 18), router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_B_IN,
        },
      ],
    });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /TestSwapPool: slippage/);

    // Full rollback: input untouched, no partial output, nothing stuck.
    assert.equal((await inputToken.read.balanceOf([user.account.address])) as bigint, balanceBefore);
    assert.equal((await tokenA.read.balanceOf([user.account.address])) as bigint, 0n);
    assert.equal((await inputToken.read.balanceOf([router.address])) as bigint, 0n);
  });

  it('reverts when a leg succeeds but produces less than the plan-declared minimum', async () => {
    const { routerAsUser, signedPlan, tokenA, tokenB } = await setup();
    const { plan, signature } = await signedPlan({
      minOutputs: [
        { token: tokenA.address, minAmountOut: LEG_A_OUT * 2n }, // unreachable at this rate
        { token: tokenB.address, minAmountOut: LEG_B_OUT },
      ],
    });

    await assert.rejects(routerAsUser.write.execute([plan, signature]), /InsufficientOutput/);
  });

  it('CRITICAL: a donated/pre-existing router balance cannot satisfy a minimum — output is measured as a delta, not an absolute balance', async () => {
    const { routerAsUser, signedPlan, router, tokenA, tokenB, inputToken, attacker, viem, poolB } = await setup();

    // Someone donates a large TOKA balance to the router before execution.
    // Under BagRouterSpike's absolute `balanceOf` check this alone would
    // satisfy a TOKA minimum the legs never actually produced.
    const donation = parseUnits('1000', 18);
    await tokenA.write.mint([attacker.account.address, donation]);
    const tokenAAsAttacker = await viem.getContractAt('MockToken', tokenA.address, { client: { wallet: attacker } });
    await tokenAAsAttacker.write.transfer([router.address, donation]);
    assert.equal((await tokenA.read.balanceOf([router.address])) as bigint, donation);

    // The plan's only leg swaps into TOKB — it produces ZERO TOKA — yet it
    // declares a TOKA minimum well under the donated balance.
    const { plan, signature } = await signedPlan({
      legs: [
        {
          target: poolB.address,
          callData: encodeSwap(LEG_B_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_B_IN,
        },
      ],
      minOutputs: [{ token: tokenA.address, minAmountOut: parseUnits('500', 18) }],
    });

    // Delta for TOKA is 0, so this must fail despite the 1000 TOKA sitting
    // in the router.
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /InsufficientOutput/);
    void tokenB;
  });

  it('never pays out a donated balance: a successful execution transfers only what its own legs produced', async () => {
    const { routerAsUser, signedPlan, router, tokenA, tokenB, user, attacker, viem } = await setup();

    const donation = parseUnits('1000', 18);
    await tokenA.write.mint([attacker.account.address, donation]);
    const tokenAAsAttacker = await viem.getContractAt('MockToken', tokenA.address, { client: { wallet: attacker } });
    await tokenAAsAttacker.write.transfer([router.address, donation]);

    const { plan, signature } = await signedPlan();
    await routerAsUser.write.execute([plan, signature]);

    // The user receives exactly the legs' output, not output + donation.
    assert.equal((await tokenA.read.balanceOf([user.account.address])) as bigint, LEG_A_OUT);
    assert.equal((await tokenB.read.balanceOf([user.account.address])) as bigint, LEG_B_OUT);
    // The donation stays put rather than being swept to whoever executes next.
    assert.equal((await tokenA.read.balanceOf([router.address])) as bigint, donation);
  });
});

describe('BagExecutionRouter — reentrancy', () => {
  it('CRITICAL: a hostile leg target cannot re-enter execute() mid-execution', async () => {
    const { viem, routerAsOwner, routerAsUser, router, signedPlan, inputToken, poolA, tokenA, user } = await setup();

    // A leg target that calls straight back into the router while the
    // outer execution is still in progress.
    const attacker = await viem.deployContract('ReentrantExecutionTarget', [router.address]);
    await routerAsOwner.write.setAllowedTarget([attacker.address, true]);

    // The plan the attacker tries to run from INSIDE the first one. It is
    // itself a fully valid, correctly-signed plan using THIS router's own
    // allowlisted pool — so if it fails, the only possible reason is the
    // reentrancy guard, not a malformed or unauthorized plan. (Using a
    // different setup's pool here would make the test pass for the wrong
    // reason: TargetNotAllowed rather than the guard.)
    const inner = await signedPlan({
      executionPlanHash: keccak256(toHex('inner-plan')),
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN,
        },
      ],
      minOutputs: [{ token: tokenA.address, minAmountOut: LEG_A_OUT }],
    });
    const innerCallData = encodeFunctionData({
      abi: router.abi,
      functionName: 'execute',
      args: [inner.plan, inner.signature],
    });
    const attackerAsUser = await viem.getContractAt('ReentrantExecutionTarget', attacker.address, {
      client: { wallet: user },
    });
    await attackerAsUser.write.setReentrantCallData([innerCallData]);

    // Outer plan: its single leg calls the hostile target.
    const outer = await signedPlan({
      legs: [
        {
          target: attacker.address,
          callData: encodeFunctionData({
            abi: [{ type: 'function', name: 'attack', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const,
            functionName: 'attack',
            args: [],
          }),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: 0n,
        },
        // A real swap after the hostile leg, so the outer plan still has a
        // non-zero output floor to meet (empty floors are rejected).
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN,
        },
      ],
      minOutputs: [{ token: tokenA.address, minAmountOut: LEG_A_OUT }],
    });

    await routerAsUser.write.execute([outer.plan, outer.signature]);

    // The attack ran, and the re-entrant call was rejected. Both are
    // asserted: the outer execution succeeding on its own would not prove
    // the inner one was blocked.
    assert.equal(await attacker.read.didAttemptReentry(), true);
    assert.equal(await attacker.read.reentryReverted(), true);
  });

  it('the inner plan is only rejected because of re-entry — the exact same plan executes fine on its own', async () => {
    const { routerAsUser, signedPlan, router, inputToken, poolA, tokenA, user } = await setup();

    // Control for the test above: same leg, executed normally.
    const { plan, signature } = await signedPlan({
      executionPlanHash: keccak256(toHex('inner-plan')),
      legs: [
        {
          target: poolA.address,
          callData: encodeSwap(LEG_A_IN, 0n, router.address),
          value: 0n,
          approveToken: inputToken.address,
          approveAmount: LEG_A_IN,
        },
      ],
      minOutputs: [{ token: tokenA.address, minAmountOut: LEG_A_OUT }],
    });

    await routerAsUser.write.execute([plan, signature]);
    assert.equal((await tokenA.read.balanceOf([user.account.address])) as bigint, LEG_A_OUT);
  });

  it('rejects a plan with no output checks — every plan must promise the caller a real minimum back', async () => {
    const { routerAsUser, signedPlan, inputToken, user } = await setup();
    const balanceBefore = (await inputToken.read.balanceOf([user.account.address])) as bigint;

    const { plan, signature } = await signedPlan({ minOutputs: [] });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /NoOutputChecks/);
    assert.equal((await inputToken.read.balanceOf([user.account.address])) as bigint, balanceBefore);
  });

  it('rejects an output check on the input token — the deposit itself must never count as produced output', async () => {
    const { routerAsUser, signedPlan, inputToken } = await setup();
    const { plan, signature } = await signedPlan({
      minOutputs: [{ token: inputToken.address, minAmountOut: 1n }],
    });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /OutputIsInputToken/);
  });

  it('rejects an output check with a zero minimum', async () => {
    const { routerAsUser, signedPlan, tokenA, tokenB } = await setup();
    const { plan, signature } = await signedPlan({
      minOutputs: [
        { token: tokenA.address, minAmountOut: LEG_A_OUT },
        { token: tokenB.address, minAmountOut: 0n },
      ],
    });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /ZeroMinOutput/);
  });
});

describe('BagExecutionRouter — admin boundary', () => {
  it('only the owner can change allowlists or rotate the plan signer', async () => {
    const { routerAsAttacker, poolA, attacker } = await setup();

    await assert.rejects(routerAsAttacker.write.setAllowedTarget([poolA.address, true]), /NotOwner/);
    await assert.rejects(routerAsAttacker.write.setAllowedToken([poolA.address, true]), /NotOwner/);
    await assert.rejects(routerAsAttacker.write.setPlanSigner([attacker.account.address]), /NotOwner/);
    await assert.rejects(routerAsAttacker.write.setOwner([attacker.account.address]), /NotOwner/);
  });

  it('exposes no function that lets the owner move assets out of the router', async () => {
    const { router } = await setup();
    const abi = router.abi as { name?: string; stateMutability?: string }[];
    const stateChanging = abi
      .filter((f) => f.name && f.stateMutability !== 'view' && f.stateMutability !== 'pure')
      .map((f) => f.name);

    for (const forbidden of ['withdraw', 'sweep', 'rescue', 'drain', 'emergencyWithdraw', 'transferToken']) {
      assert.ok(!stateChanging.includes(forbidden), `unexpected fund-moving function: ${forbidden}`);
    }
  });

  it('rotating the plan signer invalidates plans signed by the previous signer', async () => {
    const { routerAsOwner, routerAsUser, signedPlan, attacker } = await setup();
    const { plan, signature } = await signedPlan();

    await routerAsOwner.write.setPlanSigner([attacker.account.address]);
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /InvalidPlanSignature/);
  });

  it('rejects zero addresses at construction', async () => {
    const { viem, factory, owner, planSigner } = await setup();
    await assert.rejects(
      viem.deployContract('BagExecutionRouter', [zeroAddress, owner.account.address, planSigner.account.address]),
      /ZeroAddress/
    );
    await assert.rejects(
      viem.deployContract('BagExecutionRouter', [factory.address, zeroAddress, planSigner.account.address]),
      /ZeroAddress/
    );
    await assert.rejects(
      viem.deployContract('BagExecutionRouter', [factory.address, owner.account.address, zeroAddress]),
      /ZeroAddress/
    );
  });
});

describe('BagExecutionRouter — malformed plans', () => {
  it('rejects a plan with no legs', async () => {
    const { routerAsUser, signedPlan } = await setup();
    const { plan, signature } = await signedPlan({ legs: [], minOutputs: [] });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /NoLegs/);
  });

  it('rejects a zero input amount', async () => {
    const { routerAsUser, signedPlan } = await setup();
    const { plan, signature } = await signedPlan({ inputAmount: 0n });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /ZeroInputAmount/);
  });

  it('rejects duplicate output checks for the same token', async () => {
    const { routerAsUser, signedPlan, tokenA } = await setup();
    const { plan, signature } = await signedPlan({
      minOutputs: [
        { token: tokenA.address, minAmountOut: 1n },
        { token: tokenA.address, minAmountOut: 1n },
      ],
    });
    await assert.rejects(routerAsUser.write.execute([plan, signature]), /DuplicateOutputCheck/);
  });

  it('rejects a native value that does not match the signed leg total', async () => {
    const { routerAsUser, signedPlan } = await setup();
    const { plan, signature } = await signedPlan();
    await assert.rejects(
      routerAsUser.write.execute([plan, signature], { value: parseUnits('1', 18) }),
      /NativeValueMismatch/
    );
  });
});
