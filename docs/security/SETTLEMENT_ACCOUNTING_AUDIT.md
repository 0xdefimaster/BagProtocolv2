# Settlement and accounting audit

Internal review, 2026-11-14. **Not an independent audit**; no contract in this repository has had one.

## 1. What was reviewed, and that it is what runs

- `contracts/RedeemSettlement.sol` (current source), `contracts/test/RedeemSettlement.test.ts` (28 cases incl. a
  property test), `lib/server/redeem-settlement-attestation.ts` and its tests, fee-lock and A4 tests
  (`lib/server/__tests__/`), PR #147's price-confidence change (by diff, not merged).
- **Deployed = reviewed:** the live v2 runtime at `0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3` equals the current
  artifact byte for byte outside its 13 immutable slots (`usdg`, EIP-712 caches) and the CBOR metadata (10194 bytes
  each; 0 differing bytes). v1 `0x934a…` is an older build (8294 differing bytes) and is no longer configured.

## 2. Money path

```text
verified position (ledger) → consumed cost basis + loss carry (rounded up) → attestor signs Settlement
  (redemptionId, user, creator, rootCreator, executor = user's Composer proxy, contextHash, basis, carry,
   rate ≤ 3000, minUserProceeds, deadline)
→ user signs ONE Composer transaction: sell legs → push all USDG to RedeemSettlement → settleFlat(...)
→ contract: received = its USDG balance; fee = floor(max(0, received − basis − carry) × rate / 1e4);
   royalty = fee × 2000 / 1e4 if rootCreator ∉ {0, creator}; creator gets fee − royalty; user gets the rest;
   balance must end at 0; emits Settled (+ RoyaltyPaid)
→ app verifies the Settled event for this redemption id, wallet, creator and context → ledger books gross legs
   and the fee separately
```

## 3. Invariants

| Invariant | Enforced by | Evidence |
|---|---|---|
| Fee ≤ 30% of the gain, never above `received` | `MAX_FEE_RATE_BPS`, `computeFee` | tests "rate above the policy maximum", property test |
| No gain → no fee; a loss pays nothing | `computeFee` | "no gain above basis + carry" |
| Loss carry applied consistently | contract formula = backend `computeB0Fee` | "computeFee matches the backend preview … on random inputs" |
| A redemption settles once | `settled[redemptionId]` | "replay" |
| Every field is authorized | EIP-712 over all fields; `msg.sender == executor` | "every signed field is bound", "wrong executor", "settleFlat … tampering" |
| User floor after fee | `BelowMinimum` | "the user floor is checked after the fee" |
| Failed payout reverts everything | direct `safeTransfer`s in one tx | "frozen creator", "frozen root creator" |
| Nothing stays in the contract | `BalanceLeft` | "nothing may stay behind" |
| Reentrancy blocked | `nonReentrant` | "reentrancy" |
| Events match transfers | emitted from the same values | Settled/RoyaltyPaid assertions in tests |
| Basis not consumed twice; no purchase/sale race | fee-redemption lock both ways; TOCTOU re-check of phase-1 state | `fee-redemption-lock.test.ts`, `redeem-settlement-attestation.test.ts` ("TOCTOU…", "a purchase that starts between the phases") |
| Dust/donations | counted into the next settlement's `received`, to that user (documented trade-off) | "a stray balance (donation) goes to the next settlement's user" |
| Accounting from verified results | Settled event is the source of truth for fee sales | `redeem-execution.ts` (`settlementPlan.attestedAt` branch) |

## 4. Findings

| ID | Severity | Issue | Evidence | Remaining risk / recommendation |
|---|---|---|---|---|
| S-1 | HIGH (trust boundary) | Creator, root creator, fee rate, basis and carry are **attested**, not read on-chain. A compromised attestor key together with a compromised transaction builder can direct up to 30% of a fee-path sale's proceeds (with basis 0) to any address. Users cannot see this in the wallet prompt | contract §1 NatSpec; `_settle` | Mitigate before scale: KMS-held attestor separate from the server's other keys; monitor `Settled` vs ledger (`scripts/audit-settlement-events.ts`); in a v3, read the locked fee rate and creator from the Bag's on-chain identity (BagFactory/Bag) instead of signing them; an independent verifier (§5) |
| S-2 | MEDIUM | Single-step `setOwner` on RedeemSettlement (and CreatorRewardsVault source) | source; precedent `0x0FB9…` unmanageable | `../security/MULTISIG_MIGRATION_RUNBOOK.md` §2; two-step ownership in v3 |
| S-3 | MEDIUM | Owner of v2 is the same hot EOA as everything else | authority snapshot | `CREDENTIAL_HARDENING_PLAN.md` |
| S-4 | LOW | Superseded settlements keep live owner/attestor roles; one is unmanageable | snapshot | none required (unconfigured, hold nothing per deployment record); keep listed |
| S-5 | INFO | `received` includes earlier donations | documented, tested | none |
| S-6 | GAP (evidence) | fee > 0 never run live; v2 never used live; fork royalty never run live; price guards not live-verified | `docs/STATUS.md` | `../release/POSITIVE_FEE_LIVE_PROOF_PLAN.md`, `../release/FORK_ROYALTY_PROOF_PLAN.md`, `../release/PRICE_AUTHORITY_QUALIFICATION.md` |

## 5. Independent verification (proposal)

A read-only verifier that, for a redemption id, reconstructs and labels each input:

| Item | Label |
|---|---|
| `Settled` / `RoyaltyPaid` event, transfers, balances | `ONCHAIN_VERIFIED` |
| consumed basis, loss carry | `LEDGER_DERIVED` + `ATTESTED` (the signature proves BAG asserted it, not that it is right) |
| creator / root creator | `ATTESTED`, cross-checked against Bag creator on-chain where available |
| fee rate | `ATTESTED`, cross-checked against the Bag's locked rate in `bag.json` / registry |
| quoted prices | `PROVIDER_REPORTED` |

Never describe the cost basis as trustless: it depends on BAG's ledger and attestor. Starting point:
`scripts/audit-settlement-events.ts` (`--chain-only` already lists events without the database).

## 6. Release gate for fee-path production use

1. PR #147 merged (or explicitly waived by the maintainer with reasons).
2. Owner custody moved (S-2, S-3) or explicitly accepted for the proof amount only.
3. Positive-fee sale and fork-royalty sale verified live per the release plans.
4. Monitoring of `Settled` vs ledger in place.
