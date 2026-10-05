import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { SETTLED_EVENT_ABI, settlementResultFromLogs } from '../redeem-settlement-event';

// The Settled event is the source of truth for a fee-paying redemption: exactly one, from the settlement
// contract, for this redemption id — anything else is "not settled".

const SETTLEMENT = '0x5555555555555555555555555555555555555555';
const OTHER = '0x9999999999999999999999999999999999999999';
const USER = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x6666666666666666666666666666666666666666';
const EXECUTOR = '0x7777777777777777777777777777777777777777';
const ID = `0x${'01'.repeat(32)}` as Hex;
const ID2 = `0x${'02'.repeat(32)}` as Hex;
const TX = `0x${'ab'.repeat(32)}` as Hex;

function settledLog(address: string, redemptionId: Hex, received = BigInt(10_000_000), fee = BigInt(200_000)) {
  const topics = encodeEventTopics({ abi: SETTLED_EVENT_ABI, eventName: 'Settled', args: { redemptionId, user: USER, creator: CREATOR } }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [EXECUTOR, `0x${'cd'.repeat(32)}`, received, BigInt(1_000_000), fee, received - fee]
  );
  return { address, topics, data, blockNumber: BigInt(42), transactionHash: TX, logIndex: 0, transactionIndex: 0, blockHash: TX, removed: false };
}

const transferLog = {
  address: SETTLEMENT,
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`] as Hex[],
  data: `0x${'00'.repeat(32)}` as Hex,
  blockNumber: BigInt(42),
  transactionHash: TX,
};

describe('settlementResultFromLogs', () => {
  it('decodes the one Settled event for this redemption', () => {
    expect(settlementResultFromLogs([transferLog, settledLog(SETTLEMENT, ID)], SETTLEMENT, ID)).toEqual({
      txHash: TX,
      blockNumber: '42',
      logIndex: '0',
      redemptionId: ID,
      user: USER,
      creator: CREATOR,
      executor: EXECUTOR,
      contextHash: `0x${'cd'.repeat(32)}`,
      received: '10000000',
      feeBase: '1000000',
      fee: '200000',
      userProceeds: '9800000',
    });
  });

  it('ignores a Settled-shaped event from any other contract', () => {
    expect(settlementResultFromLogs([settledLog(OTHER, ID)], SETTLEMENT, ID)).toBeNull();
  });

  it('ignores an event for another redemption', () => {
    expect(settlementResultFromLogs([settledLog(SETTLEMENT, ID2)], SETTLEMENT, ID)).toBeNull();
  });

  it('refuses ambiguity: two events for the same redemption is not a settlement', () => {
    expect(settlementResultFromLogs([settledLog(SETTLEMENT, ID), settledLog(SETTLEMENT, ID)], SETTLEMENT, ID)).toBeNull();
  });

  it('no logs: null', () => {
    expect(settlementResultFromLogs([], SETTLEMENT, ID)).toBeNull();
  });
});
