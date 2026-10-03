import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { zeroAddress, encodeFunctionData, parseUnits } from 'viem';

// -----------------------------------------------------------------------------
// PHASE 19.X-A — Robinhood Testnet Atomic Router Spike
//
// Unlike contracts/test/BagFactory.test.ts's original disclaimer, this suite
// WAS actually run in the environment that wrote it: `hardhat.config.ts` was
// pointed at the `solc` npm package's bundled WASM build (see the comment
// there) to work around this sandbox's lack of network access to
// binaries.soliditylang.org, and `npx hardhat test` was executed against
// this exact file. See the Phase 19.X-A report for the real console output.
//
// What this suite does NOT prove: it runs on Hardhat's in-memory EVM, not
// Robinhood Chain Testnet (chain 46630) itself. TestSwapPool/MockToken are
// our own contracts, not a claim about any third-party testnet DEX. Actually
// broadcasting this to chain 46630 is a separate, manual step — see
// scripts/spike/deploy-19x-a.md.
// -----------------------------------------------------------------------------

const TEST_SWAP_POOL_ABI = [
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

function encodeSwapCall(amountIn: bigint, minAmountOut: bigint, recipient: `0x${string}`) {
  return encodeFunctionData({
    abi: TEST_SWAP_POOL_ABI,
    functionName: 'swap',
    args: [amountIn, minAmountOut, recipient],
  });
}

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, user] = await viem.getWalletClients();

  // Three 18-decimal test tokens: IN -(legA)-> MID -(legB)-> OUT.
  const tokenIn = await viem.deployContract('MockToken', ['Spike In', 'SIN', 18]);
  const tokenMid = await viem.deployContract('MockToken', ['Spike Mid', 'SMID', 18]);
  const tokenOut = await viem.deployContract('MockToken', ['Spike Out', 'SOUT', 18]);

  // Leg A: IN -> MID at 1:2. Leg B: MID -> OUT at 1:1.
  const poolA = await viem.deployContract('TestSwapPool', [tokenIn.address, tokenMid.address, 2n, 1n]);
  const poolB = await viem.deployContract('TestSwapPool', [tokenMid.address, tokenOut.address, 1n, 1n]);

  const router = await viem.deployContract('BagRouterSpike', []);

  // Seed pool reserves (the pool's OUTPUT side) generously.
  const seedMid = parseUnits('1000', 18);
  const seedOut = parseUnits('1000', 18);
  await tokenMid.write.mint([deployer.account.address, seedMid]);
  await tokenMid.write.approve([poolA.address, seedMid]);
  await poolA.write.seed([seedMid]);

  await tokenOut.write.mint([deployer.account.address, seedOut]);
  await tokenOut.write.approve([poolB.address, seedOut]);
  await poolB.write.seed([seedOut]);

  // Fund the user with input tokens and have them approve the router.
  const userInput = parseUnits('100', 18);
  await tokenIn.write.mint([user.account.address, userInput]);
  const tokenInAsUser = await viem.getContractAt('MockToken', tokenIn.address, { client: { wallet: user } });
  await tokenInAsUser.write.approve([router.address, userInput]);

  const routerAsUser = await viem.getContractAt('BagRouterSpike', router.address, { client: { wallet: user } });

  return {
    viem,
    publicClient,
    deployer,
    user,
    tokenIn,
    tokenMid,
    tokenOut,
    poolA,
    poolB,
    router,
    routerAsUser,
    userInput,
  };
}

describe('BagRouterSpike — Phase 19.X-A composability spike', () => {
  it('SUCCESS: legA + legB both succeed -> composed swap succeeds atomically, no leftover approvals', async () => {
    const { publicClient, user, tokenIn, tokenMid, tokenOut, poolA, poolB, router, routerAsUser, userInput } =
      await setup();

    const amountIn = parseUnits('10', 18);
    const expectedMid = amountIn * 2n; // rate 2:1
    const expectedOut = expectedMid; // rate 1:1

    const legA = {
      target: poolA.address,
      callData: encodeSwapCall(amountIn, expectedMid, router.address),
      value: 0n,
      approveToken: tokenIn.address,
      approveAmount: amountIn,
    };
    const legB = {
      target: poolB.address,
      callData: encodeSwapCall(expectedMid, expectedOut, router.address),
      value: 0n,
      approveToken: tokenMid.address,
      approveAmount: expectedMid,
    };

    const userOutBefore = await tokenOut.read.balanceOf([user.account.address]);
    assert.equal(userOutBefore, 0n);

    await routerAsUser.write.executeComposed([
      tokenIn.address,
      amountIn,
      legA,
      legB,
      tokenOut.address,
      expectedOut,
    ]);

    const userOutAfter = (await tokenOut.read.balanceOf([user.account.address])) as bigint;
    assert.equal(userOutAfter, expectedOut, 'user should receive exactly the composed output');

    const userInAfter = (await tokenIn.read.balanceOf([user.account.address])) as bigint;
    assert.equal(userInAfter, userInput - amountIn, 'exact input amount consumed, no more');

    // No stuck funds inside the router itself.
    assert.equal(await tokenIn.read.balanceOf([router.address]), 0n);
    assert.equal(await tokenMid.read.balanceOf([router.address]), 0n);
    assert.equal(await tokenOut.read.balanceOf([router.address]), 0n);

    // No leftover allowance granted to either pool.
    assert.equal(await tokenIn.read.allowance([router.address, poolA.address]), 0n);
    assert.equal(await tokenMid.read.allowance([router.address, poolB.address]), 0n);
  });

  it('FAILURE (B reverts after A succeeds): entire transaction reverts, no partial state, no stuck funds', async () => {
    const { publicClient, user, tokenIn, tokenMid, tokenOut, poolA, poolB, router, routerAsUser, userInput } =
      await setup();

    const amountIn = parseUnits('10', 18);
    const expectedMid = amountIn * 2n;
    const impossibleMinOut = expectedMid * 100n; // legB slippage check will fail

    const legA = {
      target: poolA.address,
      callData: encodeSwapCall(amountIn, expectedMid, router.address),
      value: 0n,
      approveToken: tokenIn.address,
      approveAmount: amountIn,
    };
    const legB = {
      target: poolB.address,
      callData: encodeSwapCall(expectedMid, impossibleMinOut, router.address),
      value: 0n,
      approveToken: tokenMid.address,
      approveAmount: expectedMid,
    };

    await assert.rejects(
      routerAsUser.write.executeComposed([tokenIn.address, amountIn, legA, legB, tokenOut.address, 0n]),
      /TestSwapPool: slippage|BagRouterSpike: legB reverted/,
    );

    // Nothing moved: user's full input balance is untouched, pools untouched,
    // router holds nothing. This is what "entire transaction reverts" means
    // in practice — proven by balance equality, not just "the call threw".
    assert.equal(await tokenIn.read.balanceOf([user.account.address]), userInput);
    assert.equal(await tokenMid.read.balanceOf([user.account.address]), 0n);
    assert.equal(await tokenOut.read.balanceOf([user.account.address]), 0n);
    assert.equal(await tokenIn.read.balanceOf([router.address]), 0n);
    assert.equal(await tokenMid.read.balanceOf([router.address]), 0n);
    assert.equal(await tokenOut.read.balanceOf([router.address]), 0n);
    assert.equal(await tokenIn.read.allowance([router.address, poolA.address]), 0n);
  });

  it('FAILURE (A reverts, B never reached): entire transaction reverts, no partial state', async () => {
    const { user, tokenIn, tokenMid, tokenOut, poolA, poolB, router, routerAsUser, userInput } = await setup();

    const amountIn = parseUnits('10', 18);
    const impossibleMinOut = amountIn * 1000n; // legA slippage check will fail
    const wouldBeMid = amountIn * 2n;

    const legA = {
      target: poolA.address,
      callData: encodeSwapCall(amountIn, impossibleMinOut, router.address),
      value: 0n,
      approveToken: tokenIn.address,
      approveAmount: amountIn,
    };
    // legB is well-formed and WOULD succeed on its own — proving it's legA's
    // failure alone that rolls back the whole composed call, not some
    // incidental legB misconfiguration.
    const legB = {
      target: poolB.address,
      callData: encodeSwapCall(wouldBeMid, wouldBeMid, router.address),
      value: 0n,
      approveToken: tokenMid.address,
      approveAmount: wouldBeMid,
    };

    await assert.rejects(
      routerAsUser.write.executeComposed([tokenIn.address, amountIn, legA, legB, tokenOut.address, 0n]),
      /TestSwapPool: slippage|BagRouterSpike: legA reverted/,
    );

    assert.equal(await tokenIn.read.balanceOf([user.account.address]), userInput);
    assert.equal(await tokenMid.read.balanceOf([poolA.address]), parseUnits('1000', 18), 'poolA reserves untouched');
    assert.equal(await tokenOut.read.balanceOf([poolB.address]), parseUnits('1000', 18), 'poolB reserves untouched');
  });

  it('rejects a zero-address leg target rather than silently no-op-ing', async () => {
    const { user, tokenIn, tokenOut, poolB, router, routerAsUser } = await setup();
    const amountIn = parseUnits('10', 18);

    const legA = {
      target: zeroAddress,
      callData: '0x' as `0x${string}`,
      value: 0n,
      approveToken: tokenIn.address,
      approveAmount: amountIn,
    };
    const legB = {
      target: poolB.address,
      callData: '0x' as `0x${string}`,
      value: 0n,
      approveToken: zeroAddress,
      approveAmount: 0n,
    };

    await assert.rejects(
      routerAsUser.write.executeComposed([tokenIn.address, amountIn, legA, legB, tokenOut.address, 0n]),
      /BagRouterSpike: legA target/,
    );
  });
});
