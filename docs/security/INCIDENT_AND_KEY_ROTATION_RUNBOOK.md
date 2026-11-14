# Incident and key rotation runbook

Use when a credential may be exposed. Containment first, then rotation, then evidence. Every on-chain step is a
maintainer action; this document does not authorize anyone to execute it.

## 1. Owner / deployer key (`0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` today)

Impact: treasury redirection, creation-fee increase (≤ 0.01 ETH cap), factory ownership; attestor replacement on
RedeemSettlement (fee-path sales stop working, or are redirected together with a backend compromise); any funds in
the account itself.

1. From a clean device, move the account's own funds to a fresh wallet.
2. If a Safe exists: `transferOwnership(SAFE)` on both BagFactories (Safe accepts), `setOwner(SAFE)` on
   RedeemSettlement v2 (see `MULTISIG_MIGRATION_RUNBOOK.md` §2 for the single-step risk). If no Safe exists yet,
   use a fresh hardware-wallet EOA as the interim owner.
3. Verify with `node scripts/audit/authority-snapshot.mjs`. If the attacker already changed the treasury or
   attestor, restore them as the new owner and record the attacker's transactions.
4. If ownership was already taken: pause fee-path sales in the backend (remove the settlement address from hosting
   config so the app falls back to fee-free behavior or refuses), warn users, redeploy the affected contract.

## 2. Settlement attestor key

Impact: signatures for any settlement field within the contract limits (S-1).

1. Remove the key from the hosting environment; fee-path sales then fail closed (no attestation).
2. Owner calls `setAttestor(newEOA)`; deploy the new key; confirm `attestor()`.
3. Audit `Settled` and `RoyaltyPaid` events since the suspected exposure against the ledger:
   `scripts/audit-settlement-events.ts` (`--chain-only` lists events without the database).

## 3. Server secrets

| Secret | Immediate action | Follow-up |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | rotate in Supabase; update hosting env; redeploy | review database audit logs for writes outside API routes |
| `SESSION_SECRET` | rotate; all sessions are invalidated (users sign in again) | none |
| `CRON_SECRET` | rotate in hosting env and scheduled functions | check cron routes' logs for unexpected callers |
| `ALCHEMY_API_KEY`, `LIFI_API_KEY`, RPC URLs with keys | rotate at the provider | check usage dashboards |

## 4. Evidence and closure

- Record what was exposed, when, how it was detected, every transaction and setting changed, and a fresh authority
  snapshot. Never paste secret values into the record.
- Close only when the snapshot shows the intended holders and the old credential has no remaining role.
