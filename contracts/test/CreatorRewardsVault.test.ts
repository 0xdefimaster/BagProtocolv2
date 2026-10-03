import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { keccak256, toHex, zeroAddress, parseUnits } from 'viem';

function ref(seed: string): `0x${string}` {
  return keccak256(toHex(seed));
}

const AMOUNT = parseUnits('100', 18);

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, settler, creatorA, creatorB, other] = await viem.getWalletClients();

  // Reward token stand-in for USDG (18 decimals here for round test numbers;
  // production must read the REAL USDG decimals on-chain — see
  // lib/config/robinhood-chain.ts — rather than assume 18).
  const token = await viem.deployContract('MockToken', ['Mock USDG', 'mUSDG', 18]);

  const vault = await viem.deployContract('CreatorRewardsVault', [
    token.address,
    owner.account.address,
    settler.account.address,
  ]);

  const vaultAsSettler = await viem.getContractAt('CreatorRewardsVault', vault.address, {
    client: { wallet: settler },
  });
  const vaultAsOwner = await viem.getContractAt('CreatorRewardsVault', vault.address, {
    client: { wallet: owner },
  });
  const vaultAsCreatorA = await viem.getContractAt('CreatorRewardsVault', vault.address, {
    client: { wallet: creatorA },
  });
  const vaultAsCreatorB = await viem.getContractAt('CreatorRewardsVault', vault.address, {
    client: { wallet: creatorB },
  });
  const vaultAsOther = await viem.getContractAt('CreatorRewardsVault', vault.address, {
    client: { wallet: other },
  });

  const tokenAsSettler = await viem.getContractAt('MockToken', token.address, { client: { wallet: settler } });

  // Mints the settler tokens AND pre-approves the vault, mirroring how the
  // real settlement worker / RedeemFeeRouter must be funded+approved
  // before calling settleReward (see contract NatSpec).
  async function fundSettler(amount: bigint) {
    await token.write.mint([settler.account.address, amount]);
    await tokenAsSettler.write.approve([vault.address, amount]);
  }

  return {
    viem,
    publicClient,
    token,
    vault,
    vaultAsSettler,
    vaultAsOwner,
    vaultAsCreatorA,
    vaultAsCreatorB,
    vaultAsOther,
    fundSettler,
    owner,
    settler,
    creatorA,
    creatorB,
    other,
  };
}

describe('CreatorRewardsVault', () => {
  it('deploys with the configured reward token, owner, and initial settler', async () => {
    const { vault, token, owner, settler } = await setup();
    assert.equal(((await vault.read.rewardToken()) as string).toLowerCase(), token.address.toLowerCase());
    assert.equal(((await vault.read.owner()) as string).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal((await vault.read.isSettler([settler.account.address])) as boolean, true);
  });

  it('settleReward atomically pulls tokens AND credits balanceOf in one transaction', async () => {
    const { vaultAsSettler, vault, token, fundSettler, settler, creatorA } = await setup();
    await fundSettler(AMOUNT);

    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-1')]);

    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, AMOUNT);
    assert.equal((await vault.read.totalCredited([creatorA.account.address])) as bigint, AMOUNT);
    assert.equal((await vault.read.totalOutstanding()) as bigint, AMOUNT);
    // The vault actually HOLDS the tokens now — not just an accounting entry.
    assert.equal((await token.read.balanceOf([vault.address])) as bigint, AMOUNT);
    assert.equal((await token.read.balanceOf([settler.account.address])) as bigint, 0n);
  });

  it("settleReward reverts (whole tx, including accounting) if the settler hasn't approved/funded enough — no partial credit", async () => {
    const { vaultAsSettler, vault, creatorA } = await setup();
    // No fundSettler() call — settler has zero balance/allowance.
    await assert.rejects(vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-2')]));

    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, 0n);
    assert.equal((await vault.read.totalOutstanding()) as bigint, 0n);
  });

  it('a non-settler wallet cannot call settleReward', async () => {
    const { vaultAsOther, fundSettler, creatorA } = await setup();
    await fundSettler(AMOUNT);
    await assert.rejects(
      vaultAsOther.write.settleReward([creatorA.account.address, AMOUNT, ref('event-3')]),
      /NotSettler/
    );
  });

  it('owner cannot call settleReward either unless separately added as a settler', async () => {
    const { vaultAsOwner, fundSettler, creatorA } = await setup();
    await fundSettler(AMOUNT);
    await assert.rejects(
      vaultAsOwner.write.settleReward([creatorA.account.address, AMOUNT, ref('event-owner')]),
      /NotSettler/
    );
  });

  it('a creator can withdraw their own settled balance directly, no approval step', async () => {
    const { vaultAsSettler, vaultAsCreatorA, vault, token, fundSettler, creatorA } = await setup();
    await fundSettler(AMOUNT);
    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-4')]);

    const half = AMOUNT / 2n;
    await vaultAsCreatorA.write.withdraw([half]);

    assert.equal((await token.read.balanceOf([creatorA.account.address])) as bigint, half);
    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, AMOUNT - half);
  });

  it('withdrawAll sweeps the full remaining balance and zeroes it', async () => {
    const { vaultAsSettler, vaultAsCreatorA, vault, token, fundSettler, creatorA } = await setup();
    await fundSettler(AMOUNT);
    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-5')]);

    await vaultAsCreatorA.write.withdrawAll();

    assert.equal((await token.read.balanceOf([creatorA.account.address])) as bigint, AMOUNT);
    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, 0n);
  });

  it('a creator cannot withdraw more than their own settled balance', async () => {
    const { vaultAsSettler, vaultAsCreatorA, fundSettler, creatorA } = await setup();
    await fundSettler(AMOUNT);
    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-6')]);
    await assert.rejects(vaultAsCreatorA.write.withdraw([AMOUNT + 1n]), /InsufficientBalance/);
  });

  it("CRITICAL: creator A can never withdraw creator B's balance", async () => {
    const { vaultAsSettler, vaultAsCreatorA, vault, fundSettler, creatorA, creatorB } = await setup();
    await fundSettler(AMOUNT * 2n);
    await vaultAsSettler.write.settleReward([creatorB.account.address, AMOUNT, ref('event-7')]);

    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, 0n);
    await assert.rejects(vaultAsCreatorA.write.withdraw([AMOUNT]), /InsufficientBalance/);
    assert.equal((await vault.read.balanceOf([creatorB.account.address])) as bigint, AMOUNT);
  });

  it('two creators withdrawing independently never affects each others balances', async () => {
    const { vaultAsSettler, vaultAsCreatorA, vaultAsCreatorB, vault, token, fundSettler, creatorA, creatorB } =
      await setup();
    await fundSettler(AMOUNT * 2n);
    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-8a')]);
    await vaultAsSettler.write.settleReward([creatorB.account.address, AMOUNT, ref('event-8b')]);

    await vaultAsCreatorA.write.withdrawAll();
    assert.equal((await token.read.balanceOf([creatorA.account.address])) as bigint, AMOUNT);
    assert.equal((await vault.read.balanceOf([creatorB.account.address])) as bigint, AMOUNT);

    await vaultAsCreatorB.write.withdrawAll();
    assert.equal((await token.read.balanceOf([creatorB.account.address])) as bigint, AMOUNT);
  });

  it('CRITICAL: no settler (batch worker OR router) has any withdrawal path beyond the same public withdraw() every creator uses', async () => {
    const { vaultAsSettler, vault, fundSettler, settler } = await setup();
    await fundSettler(AMOUNT);
    assert.equal((await vault.read.balanceOf([settler.account.address])) as bigint, 0n);
    await assert.rejects(vaultAsSettler.write.withdraw([1n]), /InsufficientBalance/);

    const abi = vault.abi as { name?: string; stateMutability?: string }[];
    const stateChangingFnNames = abi
      .filter((f) => f.name && f.stateMutability !== 'view' && f.stateMutability !== 'pure')
      .map((f) => f.name);
    for (const forbidden of ['settlerWithdraw', 'emergencyWithdraw', 'sweep', 'rescue', 'drain']) {
      assert.ok(!stateChangingFnNames.includes(forbidden), `unexpected privileged function: ${forbidden}`);
    }
  });

  it('owner cannot sweep the reward token itself', async () => {
    const { vaultAsOwner, token, fundSettler, other } = await setup();
    await fundSettler(AMOUNT);
    await assert.rejects(
      vaultAsOwner.write.sweepForeignToken([token.address, other.account.address, AMOUNT]),
      /CannotSweepRewardToken/
    );
  });

  it('owner CAN add a second settler (e.g. RedeemFeeRouter) without removing the first', async () => {
    const { viem, vault, vaultAsOwner, vaultAsSettler, fundSettler, other, creatorA } = await setup();
    await fundSettler(AMOUNT * 2n);

    await vaultAsOwner.write.setSettler([other.account.address, true]);
    assert.equal((await vault.read.isSettler([other.account.address])) as boolean, true);
    // Original settler still works — adding a settler doesn't revoke others.
    assert.equal((await vault.read.isSettler([creatorA.account.address])) as boolean, false); // sanity: unrelated address stays false
    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-still-works')]);
    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, AMOUNT);
  });

  it('owner CAN revoke a settler, who immediately loses settleReward rights', async () => {
    const { vaultAsOwner, vaultAsSettler, vault, fundSettler, settler, creatorA } = await setup();
    await fundSettler(AMOUNT);
    await vaultAsOwner.write.setSettler([settler.account.address, false]);
    assert.equal((await vault.read.isSettler([settler.account.address])) as boolean, false);

    await assert.rejects(
      vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-revoked')]),
      /NotSettler/
    );
  });

  it('emits Credited (with the settler address) and Withdrawn with correct parties/amounts', async () => {
    const { vaultAsSettler, vaultAsCreatorA, vault, publicClient, fundSettler, settler, creatorA } = await setup();
    await fundSettler(AMOUNT);

    const settleTx = await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('event-9')]);
    const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleTx });
    const creditEvents = await publicClient.getContractEvents({
      address: vault.address,
      abi: vault.abi,
      eventName: 'Credited',
      fromBlock: settleReceipt.blockNumber,
      toBlock: settleReceipt.blockNumber,
    });
    assert.equal(creditEvents.length, 1);
    assert.equal((creditEvents[0].args.creator as string).toLowerCase(), creatorA.account.address.toLowerCase());
    assert.equal((creditEvents[0].args.settler as string).toLowerCase(), settler.account.address.toLowerCase());
    assert.equal(creditEvents[0].args.amount, AMOUNT);

    const withdrawTx = await vaultAsCreatorA.write.withdrawAll();
    const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
    const withdrawEvents = await publicClient.getContractEvents({
      address: vault.address,
      abi: vault.abi,
      eventName: 'Withdrawn',
      fromBlock: withdrawReceipt.blockNumber,
      toBlock: withdrawReceipt.blockNumber,
    });
    assert.equal(withdrawEvents.length, 1);
    assert.equal((withdrawEvents[0].args.creator as string).toLowerCase(), creatorA.account.address.toLowerCase());
    assert.equal(withdrawEvents[0].args.amount, AMOUNT);
  });

  it('rejects a zero reward-token/owner/settler address at construction', async () => {
    const { viem, owner, settler, token } = await setup();
    await assert.rejects(
      viem.deployContract('CreatorRewardsVault', [zeroAddress, owner.account.address, settler.account.address]),
      /ZeroAddress/
    );
    await assert.rejects(
      viem.deployContract('CreatorRewardsVault', [token.address, zeroAddress, settler.account.address]),
      /ZeroAddress/
    );
    await assert.rejects(
      viem.deployContract('CreatorRewardsVault', [token.address, owner.account.address, zeroAddress]),
      /ZeroAddress/
    );
  });

  it('the same refId can never be settled twice, even by a retried settlement job', async () => {
    const { vaultAsSettler, vault, fundSettler, creatorA } = await setup();
    await fundSettler(AMOUNT * 2n);
    const dupRef = ref('event-dup');

    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, dupRef]);
    await assert.rejects(
      vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, dupRef]),
      /RefAlreadyUsed/
    );

    assert.equal((await vault.read.balanceOf([creatorA.account.address])) as bigint, AMOUNT);
    // The second (rejected) attempt must not have pulled a second AMOUNT
    // from the settler either — solvency invariant holds.
    assert.equal((await vault.read.totalOutstanding()) as bigint, AMOUNT);
  });

  it('invariant: totalOutstanding equals the sum of all balanceOf, and never exceeds the vault token balance', async () => {
    const { vaultAsSettler, vaultAsCreatorA, vault, token, fundSettler, creatorA, creatorB } = await setup();
    await fundSettler(AMOUNT * 3n);
    await vaultAsSettler.write.settleReward([creatorA.account.address, AMOUNT, ref('inv-1')]);
    await vaultAsSettler.write.settleReward([creatorB.account.address, AMOUNT * 2n, ref('inv-2')]);

    const sumBalances =
      ((await vault.read.balanceOf([creatorA.account.address])) as bigint) +
      ((await vault.read.balanceOf([creatorB.account.address])) as bigint);
    assert.equal((await vault.read.totalOutstanding()) as bigint, sumBalances);
    assert.ok(((await vault.read.totalOutstanding()) as bigint) <= ((await token.read.balanceOf([vault.address])) as bigint));

    await vaultAsCreatorA.write.withdraw([AMOUNT / 2n]);
    const sumAfter =
      ((await vault.read.balanceOf([creatorA.account.address])) as bigint) +
      ((await vault.read.balanceOf([creatorB.account.address])) as bigint);
    assert.equal((await vault.read.totalOutstanding()) as bigint, sumAfter);
  });
});
