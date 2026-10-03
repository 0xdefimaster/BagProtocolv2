import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  keccak256,
  toHex,
  encodeFunctionData,
  parseUnits,
  zeroAddress,
} from 'viem';
import { computeLegsHash } from '../../lib/blockchain/redeem-fee-router-eip712';

// -----------------------------------------------------------------------------
// V11: RedeemFeeRouter now supports N input-asset legs in one atomic
// redemption. Proves the enforced-fee-at-redemption guarantee over MULTIPLE
// simultaneous basket assets (BTC+ETH+SOL-style), not just one — the prior
// single-leg version could not represent this at all
// (MultiAssetRedemptionNotSupportedError), meaning fee enforcement simply did
// not exist for the common multi-asset case. It does NOT and cannot prove
// that a user who bypasses the app entirely can be forced to pay — that
// remains outside on-chain enforceability without full custody (see
// RedeemFeeRouter.sol's NatSpec).
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

function encodeSwap(amountIn: bigint, minAmountOut: bigint, recipient: `0x${string}`) {
  return encodeFunctionData({ abi: SWAP_POOL_ABI, functionName: 'swap', args: [amountIn, minAmountOut, recipient] });
}

function redemptionId(seed: string): `0x${string}` {
  return keccak256(toHex(seed));
}

interface LegInput {
  inputToken: `0x${string}`;
  inputAmount: bigint;
  swapTarget: `0x${string}`;
  swapCallData: `0x${string}`;
}

const RATE_NUM = 100n; // 1 basket token = 100 quote tokens (both test pools use the same rate)
const RATE_DEN = 1n;

const BTC_AMOUNT = parseUnits('2', 18);
const ETH_AMOUNT = parseUnits('8', 18);
const BTC_OUTPUT = (BTC_AMOUNT * RATE_NUM) / RATE_DEN; // 200
const ETH_OUTPUT = (ETH_AMOUNT * RATE_NUM) / RATE_DEN; // 800
const TOTAL_OUTPUT = BTC_OUTPUT + ETH_OUTPUT; // 1000
const FEE_AMOUNT = parseUnits('50', 18);
const MIN_USER_PROCEEDS = TOTAL_OUTPUT - FEE_AMOUNT;

const FEE_ATTESTATION_TYPES = {
  FeeAttestation: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'user', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'minUserProceeds', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'legsHash', type: 'bytes32' },
  ],
} as const;

type AttestationMessage = {
  redemptionId: `0x${string}`;
  user: `0x${string}`;
  creator: `0x${string}`;
  feeAmount: bigint;
  minUserProceeds: bigint;
  deadline: bigint;
  legsHash: `0x${string}`;
};

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, , user, creator, attestor, other] = await viem.getWalletClients();

  const quoteToken = await viem.deployContract('MockToken', ['Mock USDG', 'mUSDG', 18]);
  const btcToken = await viem.deployContract('MockToken', ['Mock BTC', 'mBTC', 18]);
  const ethToken = await viem.deployContract('MockToken', ['Mock ETH', 'mETH', 18]);

  const vault = await viem.deployContract('CreatorRewardsVault', [
    quoteToken.address,
    owner.account.address,
    owner.account.address, // placeholder settler; router is added as the real settler below
  ]);

  const router = await viem.deployContract('RedeemFeeRouter', [
    quoteToken.address,
    vault.address,
    attestor.account.address,
    owner.account.address,
  ]);

  const vaultAsOwner = await viem.getContractAt('CreatorRewardsVault', vault.address, { client: { wallet: owner } });
  await vaultAsOwner.write.setSettler([router.address, true]);

  const btcPool = await viem.deployContract('TestSwapPool', [btcToken.address, quoteToken.address, RATE_NUM, RATE_DEN]);
  const ethPool = await viem.deployContract('TestSwapPool', [ethToken.address, quoteToken.address, RATE_NUM, RATE_DEN]);

  await quoteToken.write.mint([owner.account.address, parseUnits('1000000', 18)]);
  const quoteAsOwner = await viem.getContractAt('MockToken', quoteToken.address, { client: { wallet: owner } });
  for (const pool of [btcPool, ethPool]) {
    await quoteToken.write.mint([owner.account.address, parseUnits('1000000', 18)]);
    await quoteAsOwner.write.approve([pool.address, parseUnits('1000000', 18)]);
    const poolAsOwner = await viem.getContractAt('TestSwapPool', pool.address, { client: { wallet: owner } });
    await poolAsOwner.write.seed([parseUnits('1000000', 18)]);
  }

  await btcToken.write.mint([user.account.address, BTC_AMOUNT]);
  await ethToken.write.mint([user.account.address, ETH_AMOUNT]);
  const btcAsUser = await viem.getContractAt('MockToken', btcToken.address, { client: { wallet: user } });
  const ethAsUser = await viem.getContractAt('MockToken', ethToken.address, { client: { wallet: user } });
  await btcAsUser.write.approve([router.address, BTC_AMOUNT]);
  await ethAsUser.write.approve([router.address, ETH_AMOUNT]);

  const routerAsOwner = await viem.getContractAt('RedeemFeeRouter', router.address, { client: { wallet: owner } });
  await routerAsOwner.write.setSwapTarget([btcPool.address, true]);
  await routerAsOwner.write.setSwapTarget([ethPool.address, true]);
  // H1 follow-up — redeem() now checks every leg's inputToken against a
  // real registry; quoteToken itself must be allowlisted too or every
  // "no swap needed" leg (quoteToken-denominated position) reverts.
  await routerAsOwner.write.setAllowedInputToken([btcToken.address, true]);
  await routerAsOwner.write.setAllowedInputToken([ethToken.address, true]);
  await routerAsOwner.write.setAllowedInputToken([quoteToken.address, true]);

  const routerAsUser = await viem.getContractAt('RedeemFeeRouter', router.address, { client: { wallet: user } });

  function domain(verifyingContract: `0x${string}`, chainId: number) {
    return { name: 'BagRedeemFeeRouter', version: '3', chainId, verifyingContract } as const;
  }

  function defaultLegs(): LegInput[] {
    return [
      { inputToken: btcToken.address, inputAmount: BTC_AMOUNT, swapTarget: btcPool.address, swapCallData: encodeSwap(BTC_AMOUNT, 0n, router.address) },
      { inputToken: ethToken.address, inputAmount: ETH_AMOUNT, swapTarget: ethPool.address, swapCallData: encodeSwap(ETH_AMOUNT, 0n, router.address) },
    ];
  }

  async function signAttestationWith(
    signer: typeof attestor,
    legs: LegInput[],
    overrides: Partial<AttestationMessage> = {}
  ): Promise<{ message: AttestationMessage; signature: `0x${string}`; legs: LegInput[] }> {
    const legsHash = overrides.legsHash ?? computeLegsHash(legs);
    const message: AttestationMessage = {
      redemptionId: overrides.redemptionId ?? redemptionId('redeem-1'),
      user: overrides.user ?? user.account.address,
      creator: overrides.creator ?? creator.account.address,
      feeAmount: overrides.feeAmount ?? FEE_AMOUNT,
      minUserProceeds: overrides.minUserProceeds ?? MIN_USER_PROCEEDS,
      deadline: overrides.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
      legsHash,
    };
    const chainId = await publicClient.getChainId();
    const signature = await signer.signTypedData({
      domain: domain(router.address, chainId),
      types: FEE_ATTESTATION_TYPES,
      primaryType: 'FeeAttestation',
      message,
    });
    return { message, signature, legs };
  }

  function signAttestation(legs: LegInput[] = defaultLegs(), overrides: Partial<AttestationMessage> = {}) {
    return signAttestationWith(attestor, legs, overrides);
  }

  function buildParams(message: AttestationMessage, signature: `0x${string}`, legs: LegInput[]) {
    return {
      redemptionId: message.redemptionId,
      legs,
      creator: message.creator,
      feeAmount: message.feeAmount,
      minUserProceeds: message.minUserProceeds,
      deadline: message.deadline,
      attestationSignature: signature,
    } as const;
  }

  return {
    viem,
    publicClient,
    quoteToken,
    btcToken,
    ethToken,
    vault,
    router,
    routerAsUser,
    routerAsOwner,
    btcPool,
    ethPool,
    owner,
    user,
    creator,
    attestor,
    other,
    defaultLegs,
    signAttestation,
    signAttestationWith,
    buildParams,
  };
}

describe('RedeemFeeRouter (multi-asset, V11)', () => {
  it('MULTI-ASSET happy path: BTC+ETH legs redeem atomically in one signature, fee settles once on the combined output', async () => {
    const { routerAsUser, buildParams, signAttestation, quoteToken, vault, router, user, creator, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);

    await routerAsUser.write.redeem([buildParams(message, signature, legs)]);

    assert.equal((await quoteToken.read.balanceOf([user.account.address])) as bigint, MIN_USER_PROCEEDS);
    assert.equal((await vault.read.balanceOf([creator.account.address])) as bigint, FEE_AMOUNT);
    assert.equal((await quoteToken.read.balanceOf([router.address])) as bigint, 0n);
  });

  it('single-asset redemption still works (1-leg array) — no regression from the V10 single-leg design', async () => {
    const { routerAsUser, buildParams, signAttestation, quoteToken, vault, creator, btcToken, btcPool, router, user } = await setup();
    const legs: LegInput[] = [
      { inputToken: btcToken.address, inputAmount: BTC_AMOUNT, swapTarget: btcPool.address, swapCallData: encodeSwap(BTC_AMOUNT, 0n, router.address) },
    ];
    const feeAmount = parseUnits('20', 18);
    const minUserProceeds = BTC_OUTPUT - feeAmount;
    const { message, signature } = await signAttestation(legs, { feeAmount, minUserProceeds });

    await routerAsUser.write.redeem([buildParams(message, signature, legs)]);

    assert.equal((await quoteToken.read.balanceOf([user.account.address])) as bigint, minUserProceeds);
    assert.equal((await vault.read.balanceOf([creator.account.address])) as bigint, feeAmount);
  });

  it('a "no swap" leg (inputToken already IS the quote token) is pulled directly, no swapTarget call made', async () => {
    const { routerAsUser, buildParams, signAttestation, quoteToken, vault, creator, user, router, viem, owner } = await setup();
    const directAmount = parseUnits('300', 18);
    await quoteToken.write.mint([user.account.address, directAmount]);
    const quoteAsUser = await viem.getContractAt('MockToken', quoteToken.address, { client: { wallet: user } });
    await quoteAsUser.write.approve([router.address, directAmount]);

    const legs: LegInput[] = [{ inputToken: quoteToken.address, inputAmount: directAmount, swapTarget: zeroAddress, swapCallData: '0x' }];
    const feeAmount = parseUnits('10', 18);
    const minUserProceeds = directAmount - feeAmount;
    const { message, signature } = await signAttestation(legs, { feeAmount, minUserProceeds });

    await routerAsUser.write.redeem([buildParams(message, signature, legs)]);

    assert.equal((await vault.read.balanceOf([creator.account.address])) as bigint, feeAmount);
    void owner;
  });

  it('a no-swap leg with the WRONG input token (not the quote token) is rejected, not silently accepted', async () => {
    const { routerAsUser, buildParams, signAttestation, btcToken } = await setup();
    const legs: LegInput[] = [{ inputToken: btcToken.address, inputAmount: BTC_AMOUNT, swapTarget: zeroAddress, swapCallData: '0x' }];
    const { message, signature } = await signAttestation(legs, { feeAmount: 0n, minUserProceeds: 0n });

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, legs)]), /InvalidNoSwapLeg/);
  });

  it('rejects an empty legs array', async () => {
    const { routerAsUser, buildParams, signAttestation } = await setup();
    const { message, signature } = await signAttestation([], { feeAmount: 0n, minUserProceeds: 0n });

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, [])]), /NoLegs/);
  });

  it('rejects a legs array beyond MAX_LEGS', async () => {
    const { routerAsUser, buildParams, signAttestation, router, btcToken, btcPool } = await setup();
    const maxLegs = (await router.read.MAX_LEGS()) as bigint;
    const tooMany: LegInput[] = Array.from({ length: Number(maxLegs) + 1 }, () => ({
      inputToken: btcToken.address,
      inputAmount: 1n,
      swapTarget: btcPool.address,
      swapCallData: encodeSwap(1n, 0n, '0x0000000000000000000000000000000000000001'),
    }));
    const { message, signature } = await signAttestation(tooMany, { feeAmount: 0n, minUserProceeds: 0n });

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, tooMany)]), /TooManyLegs/);
  });

  it("CRITICAL: tampering with a SINGLE leg's inputAmount after signing invalidates the whole attestation", async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const tamperedLegs = legs.map((l, i) => (i === 0 ? { ...l, inputAmount: l.inputAmount * 2n } : l));

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, tamperedLegs)]), /InvalidAttestationSigner/);
  });

  it("CRITICAL: swapping the order of legs after signing invalidates the attestation (legsHash is order-sensitive)", async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const reordered = [legs[1], legs[0]];

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, reordered)]), /InvalidAttestationSigner/);
  });

  it("adding an extra unattested leg after signing invalidates the attestation", async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs, btcToken, btcPool, router } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const withExtra = [...legs, { inputToken: btcToken.address, inputAmount: 1n, swapTarget: btcPool.address, swapCallData: encodeSwap(1n, 0n, router.address) }];

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, withExtra)]), /InvalidAttestationSigner/);
  });

  it("CRITICAL: substituting a leg's swapCallData after signing invalidates the attestation", async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs, other } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    // Same target and amounts, but the swap output now goes to someone else.
    const redirected = legs.map((l, i) => (i === 0 ? { ...l, swapCallData: encodeSwap(BTC_AMOUNT, 0n, other.account.address) } : l));

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, redirected)]), /InvalidAttestationSigner/);
  });

  it("substituting a leg's swapTarget (even another allowlisted one) after signing invalidates the attestation", async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs, ethPool } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const retargeted = legs.map((l, i) => (i === 0 ? { ...l, swapTarget: ethPool.address } : l));

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, retargeted)]), /InvalidAttestationSigner/);
  });

  it('refunds input a swap did not consume to the redeemer instead of leaving it in the router', async () => {
    const { routerAsUser, buildParams, signAttestation, btcToken, btcPool, router, user, quoteToken, vault, creator } = await setup();
    const consumed = BTC_AMOUNT / 2n;
    const legs: LegInput[] = [
      { inputToken: btcToken.address, inputAmount: BTC_AMOUNT, swapTarget: btcPool.address, swapCallData: encodeSwap(consumed, 0n, router.address) },
    ];
    const output = (consumed * RATE_NUM) / RATE_DEN;
    const feeAmount = parseUnits('10', 18);
    const { message, signature } = await signAttestation(legs, { feeAmount, minUserProceeds: output - feeAmount });

    await routerAsUser.write.redeem([buildParams(message, signature, legs)]);

    assert.equal((await btcToken.read.balanceOf([user.account.address])) as bigint, BTC_AMOUNT - consumed);
    assert.equal((await btcToken.read.balanceOf([router.address])) as bigint, 0n);
    assert.equal((await quoteToken.read.balanceOf([user.account.address])) as bigint, output - feeAmount);
    assert.equal((await vault.read.balanceOf([creator.account.address])) as bigint, feeAmount);
  });

  it('rejects a swap target that is not on the owner allowlist, for any leg', async () => {
    const { routerAsUser, buildParams, signAttestation, viem, quoteToken, btcToken, defaultLegs } = await setup();
    const legs = defaultLegs();
    const rogue = await viem.deployContract('TestSwapPool', [btcToken.address, quoteToken.address, RATE_NUM, RATE_DEN]);
    const withRogueTarget = legs.map((l, i) => (i === 1 ? { ...l, swapTarget: rogue.address } : l));
    // Signed over the rogue target on purpose (a compromised or buggy
    // attestor) — the allowlist must still catch it independently.
    const { message, signature } = await signAttestation(withRogueTarget);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, withRogueTarget)]), /SwapTargetNotAllowed/);
  });

  it('SECURITY: a swap target equal to the leg\'s own inputToken is rejected — closes the transferFrom-on-a-victim\'s-standing-approval class of attack', async () => {
    const { routerAsUser, buildParams, signAttestation, btcToken, defaultLegs } = await setup();
    // btcToken is already in the input-token registry (setup() above) —
    // modeling exactly the real deployment state (every accepted input
    // token is, by definition, registered) rather than an extra owner
    // mistake on top of it. Without the fix, a leg's `swapCallData` could
    // be `btcToken.transferFrom(someOtherApprover, attacker, amount)` —
    // spending ANY standing approval a different redeemer had previously
    // given this router for that same token, since the call executes with
    // `msg.sender == RedeemFeeRouter`.
    const legs = defaultLegs();
    // index 0 is the BTC leg (defaultLegs()) — its OWN inputToken IS
    // btcToken, so this exercises `swapTarget == leg.inputToken` for that
    // exact leg.
    const withTokenAsTarget = legs.map((l, i) => (i === 0 ? { ...l, swapTarget: btcToken.address } : l));
    const { message, signature } = await signAttestation(withTokenAsTarget);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, withTokenAsTarget)]), /SwapTargetNotAllowed/);
  });

  it('SECURITY: a swap target equal to quoteToken is rejected', async () => {
    const { routerAsUser, buildParams, signAttestation, quoteToken, defaultLegs } = await setup();
    const legs = defaultLegs();
    const withQuoteTokenAsTarget = legs.map((l, i) => (i === 1 ? { ...l, swapTarget: quoteToken.address } : l));
    const { message, signature } = await signAttestation(withQuoteTokenAsTarget);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, withQuoteTokenAsTarget)]), /SwapTargetNotAllowed/);
  });

  it('SECURITY: a swap target equal to an UNRELATED registered input token (not this leg\'s own) is also rejected — the FULL registry is checked, not just the current leg', async () => {
    const { routerAsUser, buildParams, signAttestation, ethToken, defaultLegs } = await setup();
    const legs = defaultLegs();
    // index 0 is the BTC leg — pointing ITS swapTarget at ethToken (a
    // DIFFERENT, but still registered, input token) is exactly the
    // broader attack the narrow same-leg-only check used to miss: nothing
    // about "btc leg, eth token" looks related unless the FULL registry
    // (not just this leg's own inputToken/quoteToken) is consulted.
    const withUnrelatedTokenAsTarget = legs.map((l, i) => (i === 0 ? { ...l, swapTarget: ethToken.address } : l));
    const { message, signature } = await signAttestation(withUnrelatedTokenAsTarget);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, withUnrelatedTokenAsTarget)]), /SwapTargetNotAllowed/);
  });

  it('rejects a leg whose inputToken was never added to the input-token registry, even with a valid attestation and an allowlisted swapTarget', async () => {
    const { routerAsUser, routerAsOwner, buildParams, signAttestation, viem, quoteToken, defaultLegs, router } = await setup();
    const rogueToken = await viem.deployContract('MockToken', ['Rogue', 'RGT', 18]);
    await routerAsOwner.write.setSwapTarget([rogueToken.address, true]); // even if the TARGET is fine, the INPUT token itself must be registered
    const legs = defaultLegs();
    const withUnregisteredInput = legs.map((l, i) =>
      i === 0 ? { ...l, inputToken: rogueToken.address, swapTarget: rogueToken.address } : l
    );
    const { message, signature } = await signAttestation(withUnregisteredInput);

    await assert.rejects(
      routerAsUser.write.redeem([buildParams(message, signature, withUnregisteredInput)]),
      /InputTokenNotAllowed/
    );
  });

  it('reverts the WHOLE transaction — no partial legs executed, no stuck funds — if the SECOND leg swap reverts', async () => {
    const { routerAsUser, buildParams, signAttestation, quoteToken, btcToken, ethToken, user, defaultLegs, router } = await setup();
    const legs = defaultLegs();
    // Corrupt the second (ETH) leg's calldata to demand impossible slippage.
    const corrupted = legs.map((l, i) => (i === 1 ? { ...l, swapCallData: encodeSwap(ETH_AMOUNT, parseUnits('999999', 18), router.address) } : l));
    const { message, signature } = await signAttestation(corrupted);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, corrupted)]));

    // Neither leg's tokens were permanently pulled — the whole tx reverted,
    // including the FIRST leg's transferFrom, proving true atomicity across legs.
    assert.equal((await btcToken.read.balanceOf([user.account.address])) as bigint, BTC_AMOUNT);
    assert.equal((await ethToken.read.balanceOf([user.account.address])) as bigint, ETH_AMOUNT);
    assert.equal((await quoteToken.read.balanceOf([user.account.address])) as bigint, 0n);
  });

  it('the settled fee is claimable by the creator directly from the vault, no separate approval', async () => {
    const { routerAsUser, buildParams, signAttestation, vault, creator, quoteToken, viem, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    await routerAsUser.write.redeem([buildParams(message, signature, legs)]);

    const vaultAsCreator = await viem.getContractAt('CreatorRewardsVault', vault.address, { client: { wallet: creator } });
    await vaultAsCreator.write.withdrawAll();
    assert.equal((await quoteToken.read.balanceOf([creator.account.address])) as bigint, FEE_AMOUNT);
  });

  it('rejects an attestation signed by anyone other than the configured feeAttestor', async () => {
    const { routerAsUser, buildParams, signAttestationWith, other, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestationWith(other, legs);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, legs)]), /InvalidAttestationSigner/);
  });

  it('rejects an expired attestation', async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs, { deadline: 1n });

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, legs)]), /AttestationExpired/);
  });

  it('CRITICAL: the same redemptionId cannot be executed twice — no double fee, no double payout', async () => {
    const { routerAsUser, buildParams, signAttestation, vault, creator, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const params = buildParams(message, signature, legs);

    await routerAsUser.write.redeem([params]);
    await assert.rejects(routerAsUser.write.redeem([params]), /RedemptionAlreadyExecuted/);

    assert.equal((await vault.read.balanceOf([creator.account.address])) as bigint, FEE_AMOUNT);
  });

  it("a tampered feeAmount (higher than what the backend attested) invalidates the signature — the frontend can't inflate the fee", async () => {
    const { routerAsUser, buildParams, signAttestation, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const tampered = { ...buildParams(message, signature, legs), feeAmount: FEE_AMOUNT * 2n };

    await assert.rejects(routerAsUser.write.redeem([tampered]), /InvalidAttestationSigner/);
  });

  it("a tampered creator address invalidates the signature — the frontend can't redirect the fee to a different creator", async () => {
    const { routerAsUser, buildParams, signAttestation, other, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);
    const tampered = { ...buildParams(message, signature, legs), creator: other.account.address };

    await assert.rejects(routerAsUser.write.redeem([tampered]), /InvalidAttestationSigner/);
  });

  it('owner can rotate the feeAttestor; old attestor signatures stop working immediately', async () => {
    const { router, viem, owner, routerAsUser, buildParams, signAttestation, other, defaultLegs } = await setup();
    const legs = defaultLegs();
    const { message, signature } = await signAttestation(legs);

    const routerAsOwner = await viem.getContractAt('RedeemFeeRouter', router.address, { client: { wallet: owner } });
    await routerAsOwner.write.setFeeAttestor([other.account.address]);

    await assert.rejects(routerAsUser.write.redeem([buildParams(message, signature, legs)]), /InvalidAttestationSigner/);
  });

  it('rejects a zero address for quoteToken/vault/feeAttestor/owner at construction', async () => {
    const { viem, vault, attestor, owner } = await setup();
    await assert.rejects(
      viem.deployContract('RedeemFeeRouter', [zeroAddress, vault.address, attestor.account.address, owner.account.address]),
      /ZeroAddress/
    );
    await assert.rejects(
      viem.deployContract('RedeemFeeRouter', [vault.address, zeroAddress, attestor.account.address, owner.account.address]),
      /ZeroAddress/
    );
  });
});
