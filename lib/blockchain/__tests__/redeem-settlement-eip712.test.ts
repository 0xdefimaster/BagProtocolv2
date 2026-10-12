import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { computeSettlementContextHash, computeSettlementRoyalty, packFeeRateAndDeadline, SETTLEMENT_TYPES, type SettlementContext } from '../redeem-settlement-eip712';

const ctx: SettlementContext = {
  chainId: 4663,
  settlement: '0x7beb437538bc71a95dad6624aa04bf3594525e3c',
  bagId: '11111111-2222-3333-4444-555555555555',
  bagContract: '0x00000000000000000000000000000000000000b1',
  strategyVersion: 3,
  compositionHash: 'c0ffee12',
  redeemIntentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  user: '0xb193DE199EeB9bd1143607a11AD00999Ceb956b8',
  creator: '0x00000000000000000000000000000000000000c1',
  rootCreator: null,
  sharesRaw: '5000000000000000000',
  legs: [
    { token: '0xdd356aa38f40a7b7076755ac854b6fbb1f0d305b', amountRaw: '20000000000000000' },
    { token: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', amountRaw: '1700000000000000' },
  ],
  ledgerHeadSeq: '812',
  ledgerEventCount: 7,
  consumedBasisRaw: '2000000',
  lossCarryRaw: '0',
  feeRateBps: 1000,
};

describe('computeSettlementContextHash — one logical state, one hash', () => {
  it('is independent of leg order and address letter case', () => {
    const shuffled: SettlementContext = {
      ...ctx,
      user: ctx.user.toLowerCase(),
      settlement: '0x7BEB437538BC71A95DAD6624AA04BF3594525E3C',
      legs: [
        { token: '0x117CC2133C37B721F49DE2A7A74833232B3B4C0C', amountRaw: '1700000000000000' },
        { token: '0xDD356AA38F40A7B7076755AC854B6FBB1F0D305B', amountRaw: '20000000000000000' },
      ],
    };
    expect(computeSettlementContextHash(shuffled)).toBe(computeSettlementContextHash(ctx));
  });

  it('changes when any state field changes (stale state → a different hash → a different signature)', () => {
    const base = computeSettlementContextHash(ctx);
    const variants: Partial<SettlementContext>[] = [
      { chainId: 1 },
      { settlement: '0x0000000000000000000000000000000000000001' },
      { bagId: '11111111-2222-3333-4444-555555555556' },
      { bagContract: null },
      { strategyVersion: 4 },
      { compositionHash: 'c0ffee13' },
      { redeemIntentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef' },
      { user: '0x00000000000000000000000000000000000000d1' },
      { creator: '0x00000000000000000000000000000000000000c2' },
      { rootCreator: '0x00000000000000000000000000000000000000a1' },
      { sharesRaw: '5000000000000000001' },
      { legs: [ctx.legs[0], { ...ctx.legs[1], amountRaw: '1700000000000001' }] },
      { legs: [ctx.legs[0]] },
      { ledgerHeadSeq: '813' },
      { ledgerEventCount: 8 },
      { consumedBasisRaw: '2000001' },
      { lossCarryRaw: '1' },
      { feeRateBps: 999 },
    ];
    const seen = new Set([base]);
    for (const v of variants) {
      const h = computeSettlementContextHash({ ...ctx, ...v });
      expect(h, JSON.stringify(v)).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  it('refuses ambiguous input instead of hashing it: a token listed twice, a non-integer amount, a negative number', () => {
    expect(() => computeSettlementContextHash({ ...ctx, legs: [ctx.legs[0], { ...ctx.legs[0], token: ctx.legs[0].token.toUpperCase().replace('0X', '0x') }] })).toThrow(/appears twice/);
    expect(() => computeSettlementContextHash({ ...ctx, consumedBasisRaw: '1.5' })).toThrow(/non-negative integer/);
    expect(() => computeSettlementContextHash({ ...ctx, lossCarryRaw: '-1' })).toThrow(/non-negative integer/);
    expect(() => computeSettlementContextHash({ ...ctx, sharesRaw: '1e18' })).toThrow(/non-negative integer/);
  });

  it('the EIP-712 type list matches the contract typehash string', () => {
    const sig = `Settlement(${SETTLEMENT_TYPES.Settlement.map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(sig).toBe(
      'Settlement(bytes32 redemptionId,address user,address creator,address rootCreator,address executor,bytes32 contextHash,uint256 consumedBasis,uint256 lossCarry,uint256 feeRateBps,uint256 minUserProceeds,uint256 deadline)'
    );
    expect(keccak256(toHex(sig))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('fork royalty and settleFlat packing (RedeemSettlement.computeRoyalty, settleFlat)', () => {
  const creator = '0x00000000000000000000000000000000000000c1';
  const root = '0x00000000000000000000000000000000000000A1';

  it('the root creator gets 20% of the fee, rounded down; none when not a fork or when the root is the creator', () => {
    expect(computeSettlementRoyalty(BigInt(115_000), creator, root)).toBe(BigInt(23_000));
    expect(computeSettlementRoyalty(BigInt(9), creator, root)).toBe(BigInt(1));
    expect(computeSettlementRoyalty(BigInt(4), creator, root)).toBe(BigInt(0));
    expect(computeSettlementRoyalty(BigInt(115_000), creator, null)).toBe(BigInt(0));
    expect(computeSettlementRoyalty(BigInt(115_000), creator, `0x${'0'.repeat(40)}`)).toBe(BigInt(0));
    expect(computeSettlementRoyalty(BigInt(115_000), creator, creator.toUpperCase().replace('0X', '0x'))).toBe(BigInt(0));
  });

  it('packs deadline << 16 | feeRateBps and refuses a rate that does not fit 16 bits', () => {
    const packed = packFeeRateAndDeadline(BigInt(1000), BigInt(1_791_221_521));
    expect(packed & BigInt(0xffff)).toBe(BigInt(1000));
    expect(packed >> BigInt(16)).toBe(BigInt(1_791_221_521));
    expect(() => packFeeRateAndDeadline(BigInt(0x10000), BigInt(1))).toThrow(/16 bits/);
    expect(() => packFeeRateAndDeadline(BigInt(-1), BigInt(1))).toThrow(/16 bits/);
  });
});
