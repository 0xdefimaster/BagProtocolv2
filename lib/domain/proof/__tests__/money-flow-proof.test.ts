import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from 'viem';
import { SETTLED_EVENT_ABI } from '@/lib/blockchain/redeem-settlement-event';
import { proveCredit, proveSale, proveWithdraw } from '../money-flow-proof';

const SETTLEMENT = '0x' + '5'.repeat(40);
const VAULT = '0x' + '6'.repeat(40);
const USDG = '0x' + '7'.repeat(40);
const USER = ('0x' + '1'.repeat(40)) as Hex;
const CREATOR = ('0x' + 'c'.repeat(40)) as Hex;
const SETTLER = ('0x' + 'e'.repeat(40)) as Hex;
const OTHER = ('0x' + 'd'.repeat(40)) as Hex;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const CREDITED = parseAbiItem('event Credited(address indexed creator, uint256 amount, bytes32 indexed refId, address indexed settler)');
const WITHDRAWN = parseAbiItem('event Withdrawn(address indexed creator, address indexed to, uint256 amount)');

const transfer = (from: Hex, to: Hex, value: bigint, token = USDG) => ({
  address: token,
  topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
const settled = (o: { user?: Hex; creator?: Hex; received?: bigint; fee?: bigint; proceeds?: bigint; emitter?: string } = {}) => ({
  address: o.emitter ?? SETTLEMENT,
  topics: encodeEventTopics({ abi: SETTLED_EVENT_ABI, eventName: 'Settled', args: { redemptionId: ('0x' + 'ab'.repeat(32)) as Hex, user: o.user ?? USER, creator: o.creator ?? CREATOR } }) as Hex[],
  data: encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [SETTLER, ('0x' + 'cd'.repeat(32)) as Hex, o.received ?? BigInt(1000), BigInt(200), o.fee ?? BigInt(30), o.proceeds ?? BigInt(970)]
  ),
});
const failed = (r: ReturnType<typeof proveSale>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('proveSale', () => {
  const good = () => ({ status: 'success' as const, logs: [settled(), transfer(SETTLEMENT as Hex, CREATOR, BigInt(30)), transfer(SETTLEMENT as Hex, USER, BigInt(970))] });
  it('passes a fee-paying sale whose fee and proceeds moved in USDG exactly as the event says', () => {
    const r = proveSale(good(), { settlement: SETTLEMENT, usdg: USDG, expectedCreator: CREATOR });
    expect(r.ok).toBe(true);
    expect(r.facts).toMatchObject({ fee: '30', userProceeds: '970', received: '1000' });
  });
  it('fails a zero fee, a creator selling their own Bag, a missing fee transfer, a reverted tx, or another contract’s event', () => {
    expect(failed(proveSale({ status: 'success', logs: [settled({ fee: BigInt(0), proceeds: BigInt(1000) }), transfer(SETTLEMENT as Hex, USER, BigInt(1000))] }, { settlement: SETTLEMENT, usdg: USDG }))).toEqual(['POSITIVE_FEE']);
    expect(failed(proveSale({ status: 'success', logs: [settled({ user: CREATOR }), transfer(SETTLEMENT as Hex, CREATOR, BigInt(1000))] }, { settlement: SETTLEMENT, usdg: USDG }))).toContain('BUYER_IS_NOT_CREATOR');
    expect(failed(proveSale({ status: 'success', logs: [settled(), transfer(SETTLEMENT as Hex, USER, BigInt(970))] }, { settlement: SETTLEMENT, usdg: USDG }))).toEqual(['FEE_PAID_TO_CREATOR_IN_USDG']);
    expect(failed(proveSale({ ...good(), status: 'reverted' }, { settlement: SETTLEMENT, usdg: USDG }))).toEqual(['TX_SUCCEEDED']);
    expect(failed(proveSale({ status: 'success', logs: [settled({ emitter: OTHER })] }, { settlement: SETTLEMENT, usdg: USDG }))).toEqual(['ONE_SETTLED_EVENT_FROM_SETTLEMENT']);
    expect(failed(proveSale(good(), { settlement: SETTLEMENT, usdg: USDG, expectedCreator: OTHER }))).toEqual(['CREATOR_AS_EXPECTED']);
  });
});

describe('proveCredit / proveWithdraw', () => {
  const credited = (amount: bigint, creator = CREATOR) => ({
    address: VAULT,
    topics: encodeEventTopics({ abi: [CREDITED], eventName: 'Credited', args: { creator, refId: ('0x' + '12'.repeat(32)) as Hex, settler: SETTLER } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  });
  const withdrawn = (amount: bigint, to: Hex = CREATOR) => ({
    address: VAULT,
    topics: encodeEventTopics({ abi: [WITHDRAWN], eventName: 'Withdrawn', args: { creator: CREATOR, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  });

  it('a royalty credit passes only when the vault was funded with the same USDG', () => {
    expect(proveCredit({ status: 'success', logs: [transfer(SETTLER, VAULT as Hex, BigInt(15)), credited(BigInt(15))] }, { vault: VAULT, usdg: USDG, expectedCreator: CREATOR }).ok).toBe(true);
    expect(failed(proveCredit({ status: 'success', logs: [transfer(SETTLER, VAULT as Hex, BigInt(10)), credited(BigInt(15))] }, { vault: VAULT, usdg: USDG }))).toEqual(['VAULT_FUNDED_IN_USDG']);
    expect(failed(proveCredit({ status: 'success', logs: [] }, { vault: VAULT, usdg: USDG }))).toEqual(['CREDITED_EVENT_FROM_VAULT']);
  });

  it('a withdrawal passes only when the vault paid the recipient the same USDG', () => {
    expect(proveWithdraw({ status: 'success', logs: [withdrawn(BigInt(15)), transfer(VAULT as Hex, CREATOR, BigInt(15))] }, { vault: VAULT, usdg: USDG, expectedCreator: CREATOR }).ok).toBe(true);
    expect(failed(proveWithdraw({ status: 'success', logs: [withdrawn(BigInt(15)), transfer(VAULT as Hex, OTHER, BigInt(15))] }, { vault: VAULT, usdg: USDG }))).toEqual(['PAID_OUT_IN_USDG']);
  });
});
