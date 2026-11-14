# F-01 security patch: release notes and plan

Branch `security/f01-default-binding`, based on `origin/main` `4774ac9` (production code). Independent of the 19
local audit/M2 commits; contains only the F-01 fix and its tests.

## Vulnerability

The default Composer binding (`isWalletRoutedBatch`, `lib/blockchain/composer-status.ts`) accepted a transaction from
the wallet whose calldata starts with `redeemDelegations` and contains the built call's bytes, **whatever contract it
was sent to**. A contract of the wallet owner's choosing could receive that calldata, never run the Composer call,
and transfer output tokens to the wallet: `verifyExecution` booked a purchase at the full deposit although the
deposit never left. Requires the wallet owner; no third-party funds can be taken, but a fabricated cost basis can be
timed against price moves to create booked losses and loss carry that reduce the creator's future performance fees.

## Fix (default behavior, no flag)

1. `redeemDelegations` routes bind only when sent to the chain's pinned MetaMask DelegationManager
   (`0xdb9b1e94b5b69df7e401ddbede43491141047db3` on Robinhood, Base and Arbitrum; none elsewhere). Applied to
   `trackComposerTransaction` and `findComposerTransactionFromWallet`.
2. A Composer purchase paid with an ERC-20 must show its whole swapped deposit leaving the wallet in the same
   transaction (`composerDepositLeftWallet`, `lib/server/purchase-execution.ts`); otherwise nothing is booked.

## Compatibility

- MetaMask EIP-7702 accounts (EIP7702StatelessDeleGator v1.3.0) can only execute through this DelegationManager:
  its `executeFromExecutor` rejects any other caller. Self-call batches (`wallet_sendCalls`) and direct calls from EOAs
  are unchanged.
- The deposit check compares gross outflow, so refunds back to the wallet never cause a refusal; native-ETH deposits
  and KEEP legs are not checked; verification never relaxes, only fails.
- Booked intents are not re-verified. Re-verification of pending intents and the abandoned-sale search use the new
  rule.
- Not verified against historical BAG transactions (database replay not authorized yet): see the replay procedure in
  the audit branch runbook before or right after deploying.
- Not in this patch: T-1 sibling calls in a wallet batch (needs the exact binding), native-deposit evidence.

## Tests

`lib/blockchain/__tests__/f01-forged-envelope.test.ts` (new), F-01 cases in `composer-tx-search.test.ts` and
`purchase-execution.test.ts` (attack refused; legitimate, refund and native outcomes still complete). On the unpatched
code five of them fail (the attack is accepted).

## Plan (each step needs the maintainer's approval)

1. Push `security/f01-default-binding`; open a PR to `main` titled "Security: refuse forged redeemDelegations routes
   and purchases whose deposit never left (F-01)"; wait for CI (secrets, lint, typecheck, unit, build, integration).
2. Optional before merge: run the read-only historical replay; any booked intent that the new rule would refuse
   blocks the merge until explained.
3. Merge; Netlify deploys production. Watch purchase and sale verification failures with "did not run as built" or
   "not the Composer transaction" messages for 48 hours.
4. Rollback: revert the merge commit and redeploy (no data or configuration change involved).
5. Close the superseded `fix/f01-forged-batch` branch after merge.
