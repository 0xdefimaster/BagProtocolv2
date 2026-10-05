import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { getAddress, parseEventLogs } from 'viem';

// -----------------------------------------------------------------------------
// P1 probe contract (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §6), on
// Hardhat's in-memory EVM. Proves only that the probe reports what it should
// for each delivery model; what Composer itself does on Robinhood Chain is what
// scripts/spike/composer-settlement-probe.ts measures.
// -----------------------------------------------------------------------------

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, user] = await viem.getWalletClients();
  const usdg = await viem.deployContract('MockToken', ['Mock USDG', 'USDG', 6]);
  const probe = await viem.deployContract('ComposerSettlementProbe', [usdg.address]);
  const proxy = await viem.deployContract('ProbeCallerMock', []);
  await usdg.write.mint([proxy.address, 5_000_000n]);
  return { viem, publicClient, deployer, user, usdg, probe, proxy };
}

async function probedEvent(publicClient: Awaited<ReturnType<typeof setup>>['publicClient'], probe: Awaited<ReturnType<typeof setup>>['probe'], hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const logs = parseEventLogs({ abi: probe.abi, logs: receipt.logs, eventName: 'Probed' });
  assert.equal(logs.length, 1);
  return logs[0].args;
}

describe('ComposerSettlementProbe', () => {
  it('pull model: reports caller ≠ origin, the allowance, the measured delta, and forwards everything', async () => {
    const { publicClient, deployer, user, usdg, probe, proxy } = await setup();
    const hash = await proxy.write.approveAndProbe([usdg.address, probe.address, user.account.address, 2_000_000n, 1_000_000n]);
    const e = await probedEvent(publicClient, probe, hash);
    assert.equal(e.msgSender, getAddress(proxy.address));
    assert.equal(e.txOrigin, getAddress(deployer.account.address));
    assert.equal(e.recipient, getAddress(user.account.address));
    assert.deepEqual(
      [e.amountArg, e.pushedBeforeCall, e.allowanceBefore, e.pulled, e.received, e.allowanceAfter],
      [2_000_000n, 0n, 2_000_000n, 2_000_000n, 2_000_000n, 0n]
    );
    assert.equal(await usdg.read.balanceOf([user.account.address]), 2_000_000n);
    assert.equal(await usdg.read.balanceOf([probe.address]), 0n);
  });

  it('push model: tokens already on the probe, no allowance, nothing pulled', async () => {
    const { publicClient, user, usdg, probe, proxy } = await setup();
    const hash = await proxy.write.pushAndProbe([usdg.address, probe.address, user.account.address, 3_000_000n, 0n]);
    const e = await probedEvent(publicClient, probe, hash);
    assert.deepEqual([e.amountArg, e.pushedBeforeCall, e.allowanceBefore, e.pulled, e.received], [0n, 3_000_000n, 0n, 0n, 3_000_000n]);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 3_000_000n);
    assert.equal(await usdg.read.balanceOf([probe.address]), 0n);
  });

  it('a call below minReceived reverts the whole transaction: nothing moves', async () => {
    const { user, usdg, probe, proxy } = await setup();
    await assert.rejects(proxy.write.approveAndProbe([usdg.address, probe.address, user.account.address, 1_000_000n, 1_000_001n]), /BelowMinimum/);
    assert.equal(await usdg.read.balanceOf([proxy.address]), 5_000_000n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 0n);
    assert.equal(await usdg.read.allowance([proxy.address, probe.address]), 0n);
  });

  it('an allowance below the amount is not pulled; with nothing pushed either, it reverts', async () => {
    const { viem, user, usdg, probe } = await setup();
    const usdgAsUser = await viem.getContractAt('MockToken', usdg.address, { client: { wallet: user } });
    const probeAsUser = await viem.getContractAt('ComposerSettlementProbe', probe.address, { client: { wallet: user } });
    await usdg.write.mint([user.account.address, 1_000_000n]);
    await usdgAsUser.write.approve([probe.address, 999_999n]);
    await assert.rejects(probeAsUser.write.probe([user.account.address, 1_000_000n, 0n]), /BelowMinimum/);
  });
});
