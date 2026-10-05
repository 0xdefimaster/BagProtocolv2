import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeFunctionData, getAddress, keccak256, parseEventLogs, toFunctionSelector, toHex, zeroAddress, type Hex } from 'viem';

// -----------------------------------------------------------------------------
// RedeemSettlement v1 (no fee): the settlement primitive behind a Composer
// redemption. The executor mock plays the user's Composer proxy: it pushes
// USDG to the contract and calls settle in one transaction — the shape proven
// live on Robinhood Chain (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §7).
// Every security boundary below must fail closed.
// -----------------------------------------------------------------------------

type Settlement = {
  redemptionId: Hex;
  user: `0x${string}`;
  executor: `0x${string}`;
  contextHash: Hex;
  minUserProceeds: bigint;
  deadline: bigint;
};

const TYPES = {
  Settlement: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'user', type: 'address' },
    { name: 'executor', type: 'address' },
    { name: 'contextHash', type: 'bytes32' },
    { name: 'minUserProceeds', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const id = (s: string) => keccak256(toHex(s));

// A revert bubbling up through the executor mock is reported by its 4-byte selector, not its name: match either.
const ERRORS: Record<string, string> = {
  InvalidSignature: 'InvalidSignature(address)',
  WrongExecutor: 'WrongExecutor(address,address)',
  AlreadySettled: 'AlreadySettled(bytes32)',
  BelowMinimum: 'BelowMinimum(uint256,uint256)',
  NothingReceived: 'NothingReceived()',
  BalanceLeft: 'BalanceLeft(uint256)',
  Expired: 'Expired(uint256,uint256)',
  ReentrancyGuardReentrantCall: 'ReentrancyGuardReentrantCall()',
  NotOwner: 'NotOwner()',
  ZeroAddress: 'ZeroAddress()',
};
const err = (...names: string[]) => new RegExp(names.flatMap((n) => [n, toFunctionSelector(ERRORS[n])]).join('|'));

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [ownerW, attestorW, user, otherUser, stranger] = await viem.getWalletClients();
  const usdg = await viem.deployContract('HookERC20', []);
  const settlement = await viem.deployContract('RedeemSettlement', [usdg.address, attestorW.account.address, ownerW.account.address]);
  const executor = await viem.deployContract('SettlementExecutorMock', []);
  const otherExecutor = await viem.deployContract('SettlementExecutorMock', []);
  await usdg.write.mint([executor.address, 1_000_000_000_000n]);
  await usdg.write.mint([otherExecutor.address, 1_000_000_000_000n]);
  const chainId = await publicClient.getChainId();
  const now = (await publicClient.getBlock()).timestamp;

  const sign = (s: Settlement, signer = attestorW, verifyingContract = settlement.address) =>
    signer.signTypedData({ domain: { name: 'BagRedeemSettlement', version: '1', chainId, verifyingContract }, types: TYPES, primaryType: 'Settlement', message: s });
  const base = (over: Partial<Settlement> = {}): Settlement => ({
    redemptionId: id('redemption-1'),
    user: user.account.address,
    executor: executor.address,
    contextHash: id('bag-v3|basis=100|carry=0'),
    minUserProceeds: 1_000_000n,
    deadline: now + 300n,
    ...over,
  });
  const run = async (s: Settlement, sig: Hex, amount: bigint, via = executor) => {
    const hash = await via.write.pushAndSettle([usdg.address, settlement.address, amount, s, sig]);
    return publicClient.waitForTransactionReceipt({ hash });
  };
  return { viem, publicClient, ownerW, attestorW, user, otherUser, stranger, usdg, settlement, executor, otherExecutor, sign, base, run, now };
}

describe('RedeemSettlement v1 — no fee', () => {
  it('happy path: pays the measured amount to the user, emits it, keeps nothing', async () => {
    const { usdg, settlement, executor, user, sign, base, run } = await setup();
    const s = base();
    const receipt = await run(s, await sign(s), 1_234_567n);
    const [e] = parseEventLogs({ abi: settlement.abi, logs: receipt.logs, eventName: 'Settled' });
    assert.deepEqual(
      [e.args.redemptionId, e.args.user, e.args.executor, e.args.contextHash, e.args.received, e.args.userProceeds],
      [s.redemptionId, getAddress(user.account.address), getAddress(executor.address), s.contextHash, 1_234_567n, 1_234_567n]
    );
    assert.equal(await usdg.read.balanceOf([user.account.address]), 1_234_567n);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
    assert.equal(await settlement.read.settled([s.redemptionId]), true);
  });

  it('wrong executor: a different caller (even with a valid signature) is refused', async () => {
    const { settlement, otherExecutor, usdg, sign, base, run } = await setup();
    const s = base();
    await assert.rejects(run(s, await sign(s), 2_000_000n, otherExecutor), err('WrongExecutor'));
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
  });

  it('a direct call from an EOA (not the executor) is refused', async () => {
    const { viem, settlement, stranger, sign, base } = await setup();
    const s = base();
    const asStranger = await viem.getContractAt('RedeemSettlement', settlement.address, { client: { wallet: stranger } });
    await assert.rejects(asStranger.write.settle([s, await sign(s)]), err('WrongExecutor'));
  });

  it('every signed field is bound: changing any one after signing invalidates the signature', async () => {
    const { otherUser, sign, base, run, now } = await setup();
    const s = base();
    const sig = await sign(s);
    const tampered: Partial<Settlement>[] = [
      { redemptionId: id('redemption-2') }, // signature reused for another redemption
      { user: otherUser.account.address }, // wrong user
      { contextHash: id('bag-v3|basis=50|carry=0') }, // stale state / different basis
      { minUserProceeds: 1n }, // lowered floor
      { deadline: now + 3600n }, // extended deadline
    ];
    for (const t of tampered) await assert.rejects(run({ ...s, ...t }, sig, 2_000_000n), err('InvalidSignature'), Object.keys(t).join(','));
  });

  it('a signature by anyone but the attestor, or for another deployment, is refused', async () => {
    const { viem, stranger, sign, base, run, usdg, attestorW, ownerW } = await setup();
    const s = base();
    await assert.rejects(run(s, await sign(s, stranger), 2_000_000n), err('InvalidSignature'));
    const twin = await viem.deployContract('RedeemSettlement', [usdg.address, attestorW.account.address, ownerW.account.address]);
    await assert.rejects(run(s, await sign(s, attestorW, twin.address), 2_000_000n), err('InvalidSignature'));
  });

  it('replay: the same redemption settles once; a second attempt reverts and moves nothing', async () => {
    const { usdg, settlement, sign, base, run, executor } = await setup();
    const s = base();
    const sig = await sign(s);
    await run(s, sig, 2_000_000n);
    const executorBefore = await usdg.read.balanceOf([executor.address]);
    await assert.rejects(run(s, sig, 2_000_000n), err('AlreadySettled'));
    assert.equal(await usdg.read.balanceOf([executor.address]), executorBefore);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
  });

  it('expired attestation is refused', async () => {
    const { sign, base, run, now } = await setup();
    const s = base({ deadline: now - 1n });
    await assert.rejects(run(s, await sign(s), 2_000_000n), err('Expired'));
  });

  it('below the signed minimum, or nothing received, reverts the whole transaction', async () => {
    const { usdg, settlement, executor, sign, base, run } = await setup();
    const before = await usdg.read.balanceOf([executor.address]);
    const s = base({ minUserProceeds: 2_000_000n });
    await assert.rejects(run(s, await sign(s), 1_999_999n), err('BelowMinimum'));
    const z = base({ minUserProceeds: 0n });
    await assert.rejects(run(z, await sign(z), 0n), err('NothingReceived'));
    assert.equal(await usdg.read.balanceOf([executor.address]), before);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
  });

  it('wrong output token: pushing another token settles nothing (USDG is fixed at deployment)', async () => {
    const { viem, settlement, executor, usdg, sign, base } = await setup();
    const other = await viem.deployContract('HookERC20', []);
    await other.write.mint([executor.address, 5_000_000n]);
    const s = base({ minUserProceeds: 0n });
    await assert.rejects(executor.write.pushAndSettle([other.address, settlement.address, 5_000_000n, s, await sign(s)]), err('NothingReceived'));
    assert.equal(await settlement.read.usdg(), getAddress(usdg.address));
  });

  it('reentrancy: a token that calls back into settle mid-transfer is blocked', async () => {
    const { usdg, settlement, sign, base, run, user } = await setup();
    const inner = base({ redemptionId: id('inner') });
    const innerCall = encodeFunctionData({ abi: settlement.abi, functionName: 'settle', args: [inner, await sign(inner)] });
    await usdg.write.arm([settlement.address, settlement.address, innerCall, false]);
    const s = base();
    await assert.rejects(run(s, await sign(s), 2_000_000n), err('ReentrancyGuardReentrantCall'));
    assert.equal(await usdg.read.balanceOf([user.account.address]), 0n);
  });

  it('nothing may stay behind: a transfer that leaves a unit on the contract reverts', async () => {
    const { usdg, settlement, sign, base, run } = await setup();
    await usdg.write.arm([settlement.address, zeroAddress, '0x', true]);
    const s = base();
    await assert.rejects(run(s, await sign(s), 2_000_000n), err('BalanceLeft'));
  });

  it('a stray balance (donation) goes to the next settlement\'s user and cannot block it', async () => {
    const { usdg, settlement, user, sign, base, run } = await setup();
    await usdg.write.mint([settlement.address, 1n]);
    const s = base();
    await run(s, await sign(s), 2_000_000n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 2_000_001n);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
  });

  it('admin: only the owner rotates the attestor or owner; zero addresses refused; old attestor stops working', async () => {
    const { viem, settlement, stranger, attestorW, sign, base, run } = await setup();
    const asStranger = await viem.getContractAt('RedeemSettlement', settlement.address, { client: { wallet: stranger } });
    await assert.rejects(asStranger.write.setAttestor([stranger.account.address]), err('NotOwner'));
    await assert.rejects(asStranger.write.setOwner([stranger.account.address]), err('NotOwner'));
    await assert.rejects(settlement.write.setAttestor([zeroAddress]), err('ZeroAddress'));
    await settlement.write.setAttestor([stranger.account.address]);
    const s = base();
    await assert.rejects(run(s, await sign(s, attestorW), 2_000_000n), err('InvalidSignature'));
    await run(s, await sign(s, stranger), 2_000_000n);
  });

  it('constructor refuses zero addresses', async () => {
    const { viem, usdg, attestorW, ownerW } = await setup();
    await assert.rejects(viem.deployContract('RedeemSettlement', [zeroAddress, attestorW.account.address, ownerW.account.address]), err('ZeroAddress'));
    await assert.rejects(viem.deployContract('RedeemSettlement', [usdg.address, zeroAddress, ownerW.account.address]), err('ZeroAddress'));
    await assert.rejects(viem.deployContract('RedeemSettlement', [usdg.address, attestorW.account.address, zeroAddress]), err('ZeroAddress'));
  });

  it('property: for random amounts, floors and stray balances, it settles iff received ≥ floor and received > 0; the user gets exactly what arrived; the contract ends at 0', async () => {
    const { usdg, settlement, user, sign, base, run } = await setup();
    let seed = 0x5eed1234;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return BigInt(seed % (max + 1));
    };
    for (let i = 0; i < 40; i++) {
      const amount = i % 7 === 0 ? 0n : rand(5_000_000_000);
      const stray = i % 5 === 0 ? rand(1_000) : 0n;
      const floor = rand(Number(amount + stray + 1_000n));
      if (stray > 0n) await usdg.write.mint([settlement.address, stray]);
      const s = base({ redemptionId: id(`prop-${i}`), minUserProceeds: floor });
      const userBefore = (await usdg.read.balanceOf([user.account.address])) as bigint;
      const received = amount + stray;
      const shouldSettle = received > 0n && received >= floor;
      if (shouldSettle) {
        await run(s, await sign(s), amount);
        assert.equal((await usdg.read.balanceOf([user.account.address])) as bigint, userBefore + received, `case ${i}`);
      } else {
        await assert.rejects(run(s, await sign(s), amount), err('BelowMinimum', 'NothingReceived'), `case ${i}`);
        assert.equal(await usdg.read.balanceOf([user.account.address]), userBefore, `case ${i}`);
        // A reverted case leaves its stray balance for the next one; clear it so cases stay independent.
        if (stray > 0n) {
          const clear = base({ redemptionId: id(`clear-${i}`), minUserProceeds: 0n });
          await run(clear, await sign(clear), 0n);
        }
      }
      assert.equal(await usdg.read.balanceOf([settlement.address]), 0n, `case ${i}`);
      assert.equal(await settlement.read.settled([s.redemptionId]), shouldSettle, `case ${i}`);
    }
  });
});
