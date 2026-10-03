import { SupabaseClient } from '@supabase/supabase-js';
import { ChainId } from '@/types/basket-protocol';

// A transaction hash can back at most ONE purchase or redeem intent. Without
// this, the same on-chain execution could be reported for a second intent
// with an identical plan (the execution plan hash is deterministic from
// bag/amount/legs) and mint shares twice. Enforced in the database
// (`intent_tx_claims`, 0040_security_hardening.sql) so concurrent reports
// can't race past it.
//
// The claim is taken only AFTER a step's transaction has been verified as
// this intent's own (sender, calldata, amounts). Claiming on the
// client's "submitted" report instead would let anyone who sees a victim's
// hash in the mempool report it on their own intent first and lock the
// victim out; with verify-then-claim that report simply fails verification.

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type IntentKind = 'PURCHASE' | 'REDEEM';

/** true = this hash now belongs to (or already belonged to) this intent; false = another intent already claimed it. Throws on a DB error (never silently allows). */
export async function claimIntentTxHash(
  admin: SupabaseClient,
  args: { chain: ChainId; txHash: string; kind: IntentKind; intentId: string }
): Promise<boolean> {
  const { data, error } = await admin.rpc('claim_intent_tx_hash', {
    p_chain: args.chain,
    p_tx_hash: args.txHash.toLowerCase(),
    p_intent_kind: args.kind,
    p_intent_id: args.intentId,
  });
  if (error) throw new Error(`claim_intent_tx_hash failed: ${error.message}`);
  return data === true;
}

/**
 * Claims the tx hash of every step that became COMPLETED in this
 * verification pass (`before` -> `after`, same order). A step whose hash is
 * already owned by another intent is turned back into a failure via
 * `onConflict` and never counts as verified.
 */
export async function claimNewlyVerifiedTxHashes<S extends { status: string; txHash: string | null; sourceChain: ChainId }>(
  admin: SupabaseClient,
  kind: IntentKind,
  intentId: string,
  before: readonly S[],
  after: readonly S[],
  onConflict: (step: S) => S
): Promise<S[]> {
  const result: S[] = [];
  for (let i = 0; i < after.length; i++) {
    const step = after[i];
    const newlyCompleted = step.status === 'COMPLETED' && before[i]?.status !== 'COMPLETED';
    if (newlyCompleted && step.txHash) {
      const claimed = await claimIntentTxHash(admin, { chain: step.sourceChain, txHash: step.txHash, kind, intentId });
      result.push(claimed ? step : onConflict(step));
    } else {
      result.push(step);
    }
  }
  return result;
}
