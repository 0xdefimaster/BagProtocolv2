import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { computeB0Fee } from '../../lib/domain/basket-protocol/redeem/performance-fee-b0';
import { SETTLEMENT_TYPES, computeSettlementContextHash, settlementDomain, toCompactSignature } from '../../lib/blockchain/redeem-settlement-eip712';
import { SETTLED_EVENT_ABI, settlementResultFromLogs } from '../../lib/blockchain/redeem-settlement-event';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, getAddress, keccak256, parseEventLogs, parseSignature, signatureToCompactSignature, toFunctionSelector, toHex, zeroAddress, type Hex } from 'viem';

// -----------------------------------------------------------------------------
// RedeemSettlement (B: fee on actual proceeds): the settlement primitive behind a Composer
// redemption. The executor mock plays the user's Composer proxy: it pushes
// USDG to the contract and calls settle in one transaction — the shape proven
// live on Robinhood Chain (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §7).
// Every security boundary below must fail closed.
// -----------------------------------------------------------------------------

type Settlement = {
  redemptionId: Hex;
  user: `0x${string}`;
  creator: `0x${string}`;
  executor: `0x${string}`;
  contextHash: Hex;
  consumedBasis: bigint;
  lossCarry: bigint;
  feeRateBps: bigint;
  minUserProceeds: bigint;
  deadline: bigint;
};

const TYPES = {
  Settlement: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'user', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'executor', type: 'address' },
    { name: 'contextHash', type: 'bytes32' },
    { name: 'consumedBasis', type: 'uint256' },
    { name: 'lossCarry', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
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
  FeeRateTooHigh: 'FeeRateTooHigh(uint256)',
  ZeroAddress: 'ZeroAddress()',
};
const err = (...names: string[]) => new RegExp(names.flatMap((n) => [n, toFunctionSelector(ERRORS[n])]).join('|'));

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [ownerW, attestorW, user, otherUser, stranger, creator] = await viem.getWalletClients();
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
    creator: creator.account.address,
    executor: executor.address,
    contextHash: id('bag-v3|basis=100|carry=0'),
    consumedBasis: 0n,
    lossCarry: 0n,
    feeRateBps: 0n,
    minUserProceeds: 1_000_000n,
    deadline: now + 300n,
    ...over,
  });
  const run = async (s: Settlement, sig: Hex, amount: bigint, via = executor) => {
    const hash = await via.write.pushAndSettle([usdg.address, settlement.address, amount, s, sig]);
    return publicClient.waitForTransactionReceipt({ hash });
  };
  return { viem, publicClient, ownerW, attestorW, user, otherUser, stranger, creator, usdg, settlement, executor, otherExecutor, sign, base, run, now };
}

describe('RedeemSettlement — settlement primitive with the creator fee on actual proceeds (B)', () => {
  it('no fee: pays the whole measured amount to the user, emits it, keeps nothing', async () => {
    const { usdg, settlement, executor, user, creator, sign, base, run } = await setup();
    const s = base();
    const receipt = await run(s, await sign(s), 1_234_567n);
    const [e] = parseEventLogs({ abi: settlement.abi, logs: receipt.logs, eventName: 'Settled' });
    assert.deepEqual(
      [e.args.redemptionId, e.args.user, e.args.creator, e.args.executor, e.args.contextHash, e.args.received, e.args.fee, e.args.userProceeds],
      [s.redemptionId, getAddress(user.account.address), getAddress(creator.account.address), getAddress(executor.address), s.contextHash, 1_234_567n, 0n, 1_234_567n]
    );
    assert.equal(await usdg.read.balanceOf([user.account.address]), 1_234_567n);
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 0n);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
    assert.equal(await settlement.read.settled([s.redemptionId]), true);
  });

  it('B fee: computed on what actually arrived — 10% of (received − basis − carry) to the creator, the rest to the user', async () => {
    const { usdg, settlement, user, creator, sign, base, run } = await setup();
    // basis 1.0, carry 0.1, rate 10%: received 2.15 → gain above carry 1.05 → fee 0.105
    const s = base({ consumedBasis: 1_000_000n, lossCarry: 100_000n, feeRateBps: 1000n, minUserProceeds: 2_000_000n });
    const receipt = await run(s, await sign(s), 2_150_000n);
    const [e] = parseEventLogs({ abi: settlement.abi, logs: receipt.logs, eventName: 'Settled' });
    assert.deepEqual([e.args.received, e.args.feeBase, e.args.fee, e.args.userProceeds], [2_150_000n, 1_050_000n, 105_000n, 2_045_000n]);
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 105_000n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 2_045_000n);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
  });

  it('B fee: the same signature charges more when more arrives — the fee follows the actual amount, not the quote', async () => {
    const { usdg, creator, sign, base, run } = await setup();
    const signed = { consumedBasis: 1_000_000n, lossCarry: 0n, feeRateBps: 2000n, minUserProceeds: 0n };
    const a = base({ ...signed, redemptionId: id('a') });
    const b = base({ ...signed, redemptionId: id('b') });
    await run(a, await sign(a), 1_500_000n); // gain 0.5 → fee 0.1
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 100_000n);
    await run(b, await sign(b), 1_499_751n); // the route kept 249 units: gain 0.499751 → fee 0.0999502 → floor 99_950
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 199_950n);
  });

  it('B fee: no gain above basis + carry → no fee; a loss pays no fee', async () => {
    const { usdg, user, creator, sign, base, run } = await setup();
    const atBasis = base({ redemptionId: id('at'), consumedBasis: 1_000_000n, lossCarry: 200_000n, feeRateBps: 3000n, minUserProceeds: 0n });
    await run(atBasis, await sign(atBasis), 1_200_000n);
    const loss = base({ redemptionId: id('loss'), consumedBasis: 1_000_000n, lossCarry: 0n, feeRateBps: 3000n, minUserProceeds: 0n });
    await run(loss, await sign(loss), 800_000n);
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 0n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 2_000_000n);
  });

  it('B fee: the user floor is checked after the fee', async () => {
    const { usdg, user, creator, sign, base, run } = await setup();
    // basis 0, rate 10%: received R → user gets 0.9 R; floor 1.8 needs R ≥ 2.0
    const s = base({ feeRateBps: 1000n, minUserProceeds: 1_800_000n });
    await assert.rejects(run(s, await sign(s), 1_999_998n), err('BelowMinimum'));
    await run(s, await sign(s), 2_000_000n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 1_800_000n);
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 200_000n);
  });

  it('B fee: a rate above the policy maximum (30%) is refused even if signed; a rate with no creator is refused; rate 0 with no creator settles to the user', async () => {
    const { usdg, user, sign, base, run } = await setup();
    const tooHigh = base({ feeRateBps: 3001n, minUserProceeds: 0n });
    await assert.rejects(run(tooHigh, await sign(tooHigh), 2_000_000n), err('FeeRateTooHigh'));
    const noCreator = base({ creator: zeroAddress, feeRateBps: 1n });
    await assert.rejects(run(noCreator, await sign(noCreator), 2_000_000n), err('ZeroAddress'));
    const ok = base({ creator: zeroAddress, feeRateBps: 0n });
    await run(ok, await sign(ok), 2_000_000n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 2_000_000n);
  });

  it('computeFee matches the backend preview (computeB0Fee with gross = the measured amount) on random inputs', async () => {
    const { settlement } = await setup();
    let seed = 0xfee5;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return BigInt(seed % (max + 1));
    };
    for (let i = 0; i < 60; i++) {
      const received = rand(9_000_000_000);
      const basis = rand(9_000_000_000);
      const carry = i % 4 === 0 ? rand(500_000_000) : 0n;
      const rate = Number(rand(3000));
      const [feeBase, fee] = (await settlement.read.computeFee([received, basis, carry, BigInt(rate)])) as [bigint, bigint];
      const preview = computeB0Fee({ grossMinimumProceedsRaw: received, consumedBasisRaw: basis, lossCarryRaw: carry, rateBps: rate, creatorIsRedeemer: false });
      assert.equal(fee, preview.feeRaw, `case ${i}`);
      if (rate > 0) assert.equal(feeBase, preview.feeBaseRaw, `case ${i}`);
    }
  });

  it('a frozen creator (USDG can freeze addresses) reverts the whole settlement: nothing moves, the redemption stays open', async () => {
    const { usdg, settlement, executor, user, creator, sign, base, run } = await setup();
    await usdg.write.setFrozen([creator.account.address, true]);
    const executorBefore = await usdg.read.balanceOf([executor.address]);
    const s = base({ feeRateBps: 1000n, minUserProceeds: 0n });
    await assert.rejects(run(s, await sign(s), 2_100_000n), /frozen/);
    assert.equal(await usdg.read.balanceOf([executor.address]), executorBefore);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 0n);
    assert.equal(await settlement.read.settled([s.redemptionId]), false);
  });

  it('settleFlat (the Composer form): same result as settle; executor is msg.sender; tampering or another caller recovers a wrong signer', async () => {
    const { usdg, settlement, executor, otherExecutor, user, creator, sign, base, publicClient } = await setup();
    const flat = (s: Settlement, sig: Hex) => {
      const { r, yParityAndS } = signatureToCompactSignature(parseSignature(sig));
      return encodeFunctionData({
        abi: settlement.abi,
        functionName: 'settleFlat',
        args: [s.redemptionId, s.user, s.creator, s.contextHash, s.consumedBasis, s.lossCarry, s.feeRateBps, s.minUserProceeds, s.deadline, r, yParityAndS],
      });
    };
    const s = base({ consumedBasis: 1_000_000n, lossCarry: 100_000n, feeRateBps: 1000n, minUserProceeds: 2_000_000n });
    const sig = await sign(s);
    // Another caller: the attested executor is `executor`, so msg.sender = otherExecutor recovers someone else.
    await assert.rejects(otherExecutor.write.pushAndSettleFlat([usdg.address, settlement.address, 2_150_000n, flat(s, sig)]), err('InvalidSignature'));
    // A flat field changed after signing.
    await assert.rejects(executor.write.pushAndSettleFlat([usdg.address, settlement.address, 2_150_000n, flat({ ...s, lossCarry: 0n }, sig)]), err('InvalidSignature'));
    const hash = await executor.write.pushAndSettleFlat([usdg.address, settlement.address, 2_150_000n, flat(s, sig)]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [e] = parseEventLogs({ abi: settlement.abi, logs: receipt.logs, eventName: 'Settled' });
    assert.deepEqual([e.args.executor, e.args.received, e.args.fee, e.args.userProceeds], [getAddress(executor.address), 2_150_000n, 105_000n, 2_045_000n]);
    assert.equal(await usdg.read.balanceOf([creator.account.address]), 105_000n);
    assert.equal(await usdg.read.balanceOf([user.account.address]), 2_045_000n);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
    // The backend's event decoder (the source of truth for verification and the receipt) reads this real receipt,
    // and its ABI is the contract's own event.
    const onChainEvent = settlement.abi.find((x: { type: string; name?: string }) => x.type === 'event' && x.name === 'Settled') as { inputs: { internalType?: string }[] };
    assert.deepEqual({ anonymous: false, ...SETTLED_EVENT_ABI[0] }, { ...onChainEvent, inputs: onChainEvent.inputs.map(({ internalType: _t, ...i }) => i) });
    const decoded = settlementResultFromLogs(receipt.logs, settlement.address, s.redemptionId);
    assert.deepEqual(
      decoded && [decoded.user, decoded.creator, decoded.executor, decoded.received, decoded.fee, decoded.userProceeds, decoded.txHash],
      [getAddress(user.account.address), getAddress(creator.account.address), getAddress(executor.address), '2150000', '105000', '2045000', hash]
    );
    // The same redemption cannot be settled again through the struct entry either.
    await assert.rejects(executor.write.pushAndSettle([usdg.address, settlement.address, 1n, s, sig]), err('AlreadySettled'));
  });

  it('backend library ↔ contract: the typehash matches, and a struct signed by the backend\'s own code (attestor key, canonical context, compact signature) settles through settleFlat', async () => {
    const { viem, usdg, ownerW, executor, user, creator, publicClient } = await setup();
    // The backend signs with a raw key, as lib/server/redeem-settlement-attestation.ts does. Throwaway test key.
    const backendKey = `0x${'33'.repeat(32)}` as const;
    const backend = privateKeyToAccount(backendKey);
    const settlement = await viem.deployContract('RedeemSettlement', [usdg.address, backend.address, ownerW.account.address]);
    const typeString = `Settlement(${SETTLEMENT_TYPES.Settlement.map((f) => `${f.type} ${f.name}`).join(',')})`;
    assert.equal(await settlement.read.SETTLEMENT_TYPEHASH(), keccak256(toHex(typeString)));

    const chainId = await publicClient.getChainId();
    const contextHash = computeSettlementContextHash({
      chainId,
      settlement: settlement.address,
      bagId: '11111111-2222-3333-4444-555555555555',
      bagContract: null,
      strategyVersion: 3,
      compositionHash: 'c0ffee12',
      redeemIntentId: '6f1c2b3a-0000-4000-8000-000000000001',
      user: user.account.address,
      creator: creator.account.address,
      sharesRaw: '100',
      legs: [{ token: '0xdd356aa38f40a7b7076755ac854b6fbb1f0d305b', amountRaw: '20000000000000000' }],
      ledgerHeadSeq: '812',
      ledgerEventCount: 2,
      consumedBasisRaw: '1000000',
      lossCarryRaw: '0',
      feeRateBps: 1000,
    });
    const now = (await publicClient.getBlock()).timestamp;
    const message = {
      redemptionId: id('backend-signed'),
      user: user.account.address,
      creator: creator.account.address,
      executor: executor.address,
      contextHash,
      consumedBasis: 1_000_000n,
      lossCarry: 0n,
      feeRateBps: 1000n,
      minUserProceeds: 1_000_000n,
      deadline: now + 300n,
    };
    const signature = await backend.signTypedData({ domain: settlementDomain(chainId, settlement.address), types: SETTLEMENT_TYPES, primaryType: 'Settlement', message });
    const { r, vs } = toCompactSignature(signature);
    const call = encodeFunctionData({
      abi: settlement.abi,
      functionName: 'settleFlat',
      args: [message.redemptionId, message.user, message.creator, message.contextHash, message.consumedBasis, message.lossCarry, message.feeRateBps, message.minUserProceeds, message.deadline, r, vs],
    });
    const hash = await executor.write.pushAndSettleFlat([usdg.address, settlement.address, 1_500_000n, call]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [e] = parseEventLogs({ abi: settlement.abi, logs: receipt.logs, eventName: 'Settled' });
    assert.deepEqual([e.args.contextHash, e.args.received, e.args.fee, e.args.userProceeds], [contextHash, 1_500_000n, 50_000n, 1_450_000n]);
    assert.equal(await usdg.read.balanceOf([settlement.address]), 0n);
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
      { creator: otherUser.account.address }, // fee redirected to another address
      { consumedBasis: 1n }, // basis changed
      { lossCarry: 1n }, // loss carry changed
      { feeRateBps: 1n }, // fee rate changed
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

  it('property: for random amounts, bases, carries, rates, floors and stray balances, it settles iff received > 0 and received − fee ≥ floor, with fee = floor(max(0, received − basis − carry) × rate); the creator gets exactly the fee, the user exactly the rest; the contract ends at 0', async () => {
    const { usdg, settlement, user, creator, sign, base, run } = await setup();
    let seed = 0x5eed1234;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return BigInt(seed % (max + 1));
    };
    for (let i = 0; i < 40; i++) {
      const amount = i % 7 === 0 ? 0n : rand(5_000_000_000);
      const stray = i % 5 === 0 ? rand(1_000) : 0n;
      const floor = rand(Number(amount + stray + 1_000n));
      const rate = i % 3 === 0 ? 0n : rand(3000);
      const basis = rand(Number(amount + 1_000n));
      const carry = i % 4 === 0 ? rand(100_000) : 0n;
      if (stray > 0n) await usdg.write.mint([settlement.address, stray]);
      const s = base({ redemptionId: id(`prop-${i}`), minUserProceeds: floor, consumedBasis: basis, lossCarry: carry, feeRateBps: rate });
      const userBefore = (await usdg.read.balanceOf([user.account.address])) as bigint;
      const creatorBefore = (await usdg.read.balanceOf([creator.account.address])) as bigint;
      const received = amount + stray;
      const gain = received > basis + carry ? received - basis - carry : 0n;
      const fee = (gain * rate) / 10000n;
      const shouldSettle = received > 0n && received - fee >= floor;
      if (shouldSettle) {
        await run(s, await sign(s), amount);
        assert.equal((await usdg.read.balanceOf([user.account.address])) as bigint, userBefore + received - fee, `case ${i}`);
        assert.equal((await usdg.read.balanceOf([creator.account.address])) as bigint, creatorBefore + fee, `case ${i}`);
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
