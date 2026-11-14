import type { PurchaseReceiptVerification } from './receipt';
import type { WalletExecutionVerification } from './wallet-envelope';

// -----------------------------------------------------------------------------
// One decision vocabulary for every BAG verifier, so that an application and the SDK can be compared on the only
// question that matters for safety: may this transaction be treated as verified?
//
//   ACCEPTED               verified; the caller may rely on it.
//   REJECTED               definitively not the expected execution; never retry into acceptance.
//   INSUFFICIENT_EVIDENCE  not provable with what could be read (not mined, unreadable state, no trace, depth);
//                          never treated as verified, may succeed on a later read.
//
// Anything unknown maps to INSUFFICIENT_EVIDENCE: no status string can become ACCEPTED by accident.
// -----------------------------------------------------------------------------

export type VerificationDecision = 'ACCEPTED' | 'REJECTED' | 'INSUFFICIENT_EVIDENCE';

export function purchaseReceiptDecision(result: Pick<PurchaseReceiptVerification, 'status'>): VerificationDecision {
  if (result.status === 'VERIFIED') return 'ACCEPTED';
  if (result.status === 'FAILED') return 'REJECTED';
  return 'INSUFFICIENT_EVIDENCE';
}

export function walletExecutionDecision(result: Pick<WalletExecutionVerification, 'status'>): VerificationDecision {
  if (result.status === 'BOUND') return 'ACCEPTED';
  if (result.status === 'REFUSED') return 'REJECTED';
  return 'INSUFFICIENT_EVIDENCE';
}
