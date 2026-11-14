# ADR SDK-1: one public SDK, BAG App as its first consumer

Status: **PROPOSED** (2026-11-14). Also serves as `SDK_FIRST_ADR`. Requires the maintainer's acceptance.

## Context

- `@bagprotocol/sdk` already holds the strategy core, partition planning, Composer compilation, delivery proofs and
  receipt verification; 0.3.0 is on npm, 0.4.0 is a candidate (`publicationApproved: false`).
- The app already uses the SDK's hashing, registry verification and partition code, but keeps its own Composer
  compile and receipt verifier. Tests prove the compile produces the same program and transaction, and the
  verifier the same verdict on direct calls (`sdk-app-purchase-verification-parity.test.ts`).
- The verifiers differ on smart-account batches (D-1), and both credit sibling calls in a batch (T-1).
- The app's purchase transaction is live on Robinhood; changing what users sign needs a live re-verification.

## Decision

1. Keep **one** public package, `@bagprotocol/sdk`, with its existing subpath adapters. Do not split it into more
   packages; nothing in the audit justifies a new package boundary.
2. The app consumes the SDK for every public operation, migrating one operation at a time behind equivalence tests:
   verification binding first (M2), compile with delivery proof second (M3), purchase planning (M4), validation (M5).
3. Accounting, attestation, rewards, reconciliation and the price authority stay server-side. The SDK keeps
   returning `accounting: 'NOT_BAG_ACCOUNTED'`.
4. The SDK keeps its no-signing contract. A wallet-execution helper, if ever wanted, would be a separately
   versioned adapter with its own review.
5. Verification semantics move only toward the stricter of the two implementations.

## Consequences

- Third-party developers get the same preparation and verification code the app runs.
- The app gains delivery-proof evidence for batched wallets after M3, which also closes T-1 for purchases.
- Each migration step that changes a signed transaction (M3) needs a live, user-signed verification on Robinhood and
  Base before it becomes the default.
- The duplicated code is removed only after the app path has run live on the SDK implementation.

## Rejected alternatives

- **Rewrite the app on top of the SDK in one change:** mixes a structural refactor with transaction-semantics
  changes; no rollback point.
- **Export the app's containment check from the SDK:** would make the weaker check public.
- **Hosted API as the only integration path:** contradicts the no-custody, verify-it-yourself goal; can be added
  later as an optional service.
