import { getAddress, parseEventLogs, type Hex } from 'viem';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';

// -----------------------------------------------------------------------------
// The on-chain record of a settlement: RedeemSettlement's `Settled` event. It is the source of truth for what a
// fee-paying redemption actually did — what arrived (`received`), the fee the contract computed and paid to the
// creator, what the user got — not the backend's intent status (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §9).
// Must stay in sync with contracts/RedeemSettlement.sol's `event Settled`.
// -----------------------------------------------------------------------------

export const SETTLED_EVENT_ABI = [
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'redemptionId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'executor', type: 'address', indexed: false },
      { name: 'contextHash', type: 'bytes32', indexed: false },
      { name: 'received', type: 'uint256', indexed: false },
      { name: 'feeBase', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'userProceeds', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Raw USDG amounts as decimal strings. */
export interface SettlementResult {
  txHash: string;
  blockNumber: string;
  redemptionId: string;
  user: string;
  creator: string;
  executor: string;
  contextHash: string;
  received: string;
  feeBase: string;
  fee: string;
  userProceeds: string;
}

/** Decodes the one `Settled` event the settlement contract emitted for `redemptionId` in these logs, or null. */
export function settlementResultFromLogs(
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex; blockNumber?: bigint | null; transactionHash?: Hex | null }[],
  settlement: string,
  redemptionId: Hex
): SettlementResult | null {
  const mine = logs.filter((l) => l.address.toLowerCase() === settlement.toLowerCase());
  const events = parseEventLogs({ abi: SETTLED_EVENT_ABI, logs: mine as never, eventName: 'Settled' }).filter(
    (e) => e.args.redemptionId.toLowerCase() === redemptionId.toLowerCase()
  );
  if (events.length !== 1) return null;
  const e = events[0];
  return {
    txHash: String(e.transactionHash ?? ''),
    blockNumber: String(e.blockNumber ?? ''),
    redemptionId: e.args.redemptionId,
    user: getAddress(e.args.user),
    creator: getAddress(e.args.creator),
    executor: getAddress(e.args.executor),
    contextHash: e.args.contextHash,
    received: e.args.received.toString(),
    feeBase: e.args.feeBase.toString(),
    fee: e.args.fee.toString(),
    userProceeds: e.args.userProceeds.toString(),
  };
}

/** Reads a transaction's receipt and returns its settlement result for `redemptionId`, or null when there is none. */
export async function readSettlementResult(txHash: Hex, settlement: string, redemptionId: Hex): Promise<SettlementResult | null> {
  const receipt = await getChainPublicClient('robinhood').getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return null;
  return settlementResultFromLogs(receipt.logs, settlement, redemptionId);
}
