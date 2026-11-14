# F-01 security patch: release notes and plan

Branch `security/f01-default-binding`, based on `origin/main` `4774ac9` (production code; still the upstream head on
2026-11-14, so no rebase is needed). Independent of the local audit/M2/M3a commits; contains only the F-01 fix, its
tests, the Ethereum pin (second commit, separable) and this note.

## Vulnerability

The default Composer binding (`isWalletRoutedBatch`, `lib/blockchain/composer-status.ts`) accepted a transaction from
the wallet whose calldata starts with `redeemDelegations` and contains the built call's bytes, **whatever contract it
was sent to**. A contract of the wallet owner's choosing could receive that calldata, never run the Composer call,
and transfer output tokens to the wallet: `verifyExecution` booked a purchase at the full deposit although the
deposit never left. Requires the wallet owner; no third-party funds can be taken, but a fabricated cost basis can be
timed against price moves to create booked losses and loss carry that reduce the creator's future performance fees.

## Fix (default behavior, no flag)

1. `redeemDelegations` routes bind only when sent to the chain's pinned MetaMask DelegationManager
   (`0xdb9b1e94b5b69df7e401ddbede43491141047db3` on Robinhood, Base, Arbitrum and Ethereum; none elsewhere). Applied to
   `trackComposerTransaction` and `findComposerTransactionFromWallet`.
2. A Composer purchase paid with an ERC-20 must show its whole swapped deposit leaving the wallet in the same
   transaction (`composerDepositLeftWallet`, `lib/server/purchase-execution.ts`); otherwise nothing is booked.

## Pin evidence

On 2026-11-14 the DelegationManager and the EIP7702StatelessDeleGator (`0x63c0c19a282a1b52b07dd5a65b58948a07dae32b`) were
read on each chain and compared with the Sourcify-verified Base build after masking the two chain-bound immutables
(chain id word, EIP-712 domain hash); the implementation's immutable `delegationManager()` is the pinned address on
every chain. Robinhood, Base and Arbitrum: `scripts/audit/verify-smart-account-pins.mjs` on the audit branch
(`evidence/smart-account/metamask-delegation-pins-2026-11-14.json`). Ethereum mainnet: the same script with an
Ethereum entry, block 26413886, DelegationManager runtime keccak `0x762a7ccac3fba1fce7751870298c097c0d050451d9b4a1f0935e65dc4078d1d3`, delegator runtime keccak
`0x0b77e469f5603ed1e9ff0e7ee56238b61a8cf7cb3185b33e53e2eeaad50109ab`, both identical to Base after masking. Without the
Ethereum entry, a MetaMask EIP-7702 purchase routed through `redeemDelegations` on Ethereum (a Composer-eligible BAG
chain) would have been refused; the entry is a separate commit so a reviewer can drop it.

## Compatibility

- MetaMask EIP-7702 accounts (EIP7702StatelessDeleGator v1.3.0) can only execute through this DelegationManager:
  its `executeFromExecutor` rejects any other caller. Self-call batches (`wallet_sendCalls`) and direct calls from EOAs
  are unchanged.
- The deposit check compares gross outflow, so refunds back to the wallet never cause a refusal; native-ETH deposits
  and KEEP legs are not checked; verification never relaxes, only fails.
- Booked intents are not re-verified. Re-verification of pending intents and the abandoned-sale search use the new
  rule.
- Historical transactions: nothing is rewritten. Already booked intents stay booked. A pending intent re-verified
  after deploy uses the new rules; a legitimate one passes (same DelegationManager, deposit left the wallet).
- Not verified against historical BAG transactions (database replay not authorized yet): see the replay procedure in
  the audit branch runbook before or right after deploying.
- Not verified live: no BAG user's MetaMask EIP-7702 `redeemDelegations` purchase has been observed on chain (only
  relayer DelegationManager transactions and wallet self-call batches were); the self-authorized encoding is
  test-covered from the verified source.
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
3. Merge; Netlify deploys production. For 48 hours watch `VERIFICATION_FAILED` step failures whose message is
   "…the built call did not run as built." (deposit check) or "Reported transaction is not the Composer transaction
   built for this intent…" (binding), per chain. Expected: zero for legitimate purchases. Any occurrence: inspect the
   transaction (target, deposit Transfer logs); a legitimate one triggers step 4.
4. Rollback: revert the merge commit and redeploy (no data or configuration change involved).
5. Close the superseded `fix/f01-forged-batch` branch after merge.

## PR description (draft, not posted)

**Security: refuse forged redeemDelegations routes and purchases whose deposit never left (F-01)**

- The default Composer binding accepted `redeemDelegations` calldata sent to any contract. It now requires the
  chain's pinned MetaMask DelegationManager (Robinhood, Base, Arbitrum, Ethereum; code verified against the
  Sourcify build).
- A Composer purchase paid in an ERC-20 is booked only if its whole swapped deposit left the wallet in that
  transaction (gross outflow; refunds are fine; native ETH unchanged).
- No flag, no migration, no configuration. Rollback: revert.
- Tests: forged envelope refused on every path (track, search, purchase flow); MetaMask EIP-7702, wallet self-call
  batch, direct EOA call, refund and native-ETH purchases still complete.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
