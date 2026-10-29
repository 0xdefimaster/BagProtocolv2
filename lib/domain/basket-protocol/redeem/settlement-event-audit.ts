// -----------------------------------------------------------------------------
// Reconciles the settlement contract's `Settled` events with BAG's redeem intents. Pure.
//
// Every on-chain settlement should be a redemption this backend attested and then booked from that same
// transaction (redeem-execution.ts verifyComposerRedeemSteps records `settlementPlan.result`). Anything else needs a
// look: a settlement that ran but was never booked, one paid to another wallet than the intent's, or one whose
// redemption id matches no intent at all.
// -----------------------------------------------------------------------------

export type SettlementAuditStatus =
  /** Booked from this transaction. */
  | 'BOOKED'
  /** Not booked yet, but recent enough that verification may still be running. */
  | 'PENDING'
  /** Ran on chain, older than the grace period, and never booked (or booked from another transaction). */
  | 'UNBOOKED'
  /** Paid to a wallet other than the intent's. */
  | 'USER_MISMATCH'
  /** No intent carries this redemption id. */
  | 'UNKNOWN_REDEMPTION';

export interface SettledEventRecord {
  redemptionId: string;
  txHash: string;
  blockTimestampSec: number;
  user: string;
  received: string;
  fee: string;
}

export interface SettlementIntentRecord {
  /** `computeOnChainBagId(intent.id)`: the id the attestation signed. */
  redemptionId: string;
  intentId: string;
  walletAddress: string;
  /** `settlementPlan.result.txHash`, when booked. */
  bookedTxHash: string | null;
}

export interface SettlementAuditRow extends SettledEventRecord {
  status: SettlementAuditStatus;
  intentId: string | null;
}

/** One row per event. `nowSec` and `graceSec` decide PENDING vs UNBOOKED. */
export function auditSettlementEvents(
  events: readonly SettledEventRecord[],
  intents: readonly SettlementIntentRecord[],
  nowSec: number,
  graceSec = 3600
): SettlementAuditRow[] {
  const byId = new Map(intents.map((i) => [i.redemptionId.toLowerCase(), i]));
  return events.map((e) => {
    const intent = byId.get(e.redemptionId.toLowerCase());
    if (!intent) return { ...e, status: 'UNKNOWN_REDEMPTION', intentId: null };
    if (intent.walletAddress.toLowerCase() !== e.user.toLowerCase()) return { ...e, status: 'USER_MISMATCH', intentId: intent.intentId };
    if (intent.bookedTxHash && intent.bookedTxHash.toLowerCase() === e.txHash.toLowerCase()) return { ...e, status: 'BOOKED', intentId: intent.intentId };
    const recent = !intent.bookedTxHash && nowSec - e.blockTimestampSec < graceSec;
    return { ...e, status: recent ? 'PENDING' : 'UNBOOKED', intentId: intent.intentId };
  });
}

/** True when a row needs a person: anything but BOOKED and PENDING. */
export const needsReview = (row: SettlementAuditRow) => row.status !== 'BOOKED' && row.status !== 'PENDING';
