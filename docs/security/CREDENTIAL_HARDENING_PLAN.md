# Credential hardening plan

Status: **PLAN, nothing executed.** Every step that moves a key, an owner or a hosting setting needs the
maintainer's explicit approval. Facts come from `PRIVILEGED_AUTHORITY_MATRIX.md` (on-chain, 2026-11-14) and a local
check that derived only public addresses from the env files.

## 1. Current state (verified)

- `.env.local` and `.env.pre-base-rollout-20261108.local` (both git-ignored) hold the same valid
  `DEPLOYER_PRIVATE_KEY` in plaintext. Its address `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` is:
  owner of BagFactory on Robinhood and Base, owner of RedeemSettlement v1, v2 and one superseded deployment, the
  Base Composer proxy owner, `COMPOSER_TEST_SIGNER`, and an EIP-7702-delegated (MetaMask smart account) wallet with
  181 Robinhood transactions.
- No evidence that the key left the machine. This is a **local exposure risk, not a confirmed compromise**: any
  malware, sync tool, backup or screen share that reads the Desktop folder reads the key.
- This contradicts the repository's own setup guide (`docs/VSCODE_LOCAL_SETUP.md` §4): use a new wallet only for
  deployment, never the main wallet, and keep the key in the terminal session, not in a file.
- The other signer variables in `.env.local` are placeholders. The settlement attestor key is not in the repository
  environment (UNVERIFIED where it lives).
- Safe v1.4.1 and v1.3.0 canonical contracts exist on Robinhood, Base and Arbitrum with identical runtime hashes
  (read 2026-11-14). Safe{Wallet} UI support for chain 4663 is UNVERIFIED; the protocol-kit/CLI works with any RPC.

## 2. Target role separation

| Role | Target holder | Why |
|---|---|---|
| Protocol owner (BagFactory, RedeemSettlement, future vaults/routers) | Safe, 2-of-3, hardware-wallet signers, same Safe address per chain where possible | no single device or person can change fees, treasury or attestor |
| Treasury | Safe (may be the same Safe) or a dedicated hardware wallet | creation fees accumulate here |
| Deployer | fresh hardware-wallet account per rollout; holds no role after deployment | the deployer is never the owner |
| Settlement attestor | dedicated plain EOA, server-side only, in a secrets manager or KMS; never on a laptop | hot by necessity; rotatable by the owner Safe |
| Router plan signer (when the router is ever enabled) | separate KMS/HSM key, never shared with the attestor | different blast radius |
| Personal / test wallet (MetaMask smart account) | the maintainer's own; no protocol role | test purchases must not touch admin power |

Never consolidate these into one signer for convenience. The present state has four of them in one hot key.

## 3. Sequence

1. **Freeze the hot key's use** (no approval needed, local discipline): do not run rollout or deploy scripts with it
   until step 3 is done.
2. **Create the owner Safe** on Base and Robinhood (approval: RED). Record Safe address, owners, threshold, and the
   `getThreshold()`/`getOwners()` read-back via `scripts/audit/authority-snapshot.mjs` (extend `KNOWN_ACCOUNTS`).
3. **Transfer ownership** per `MULTISIG_MIGRATION_RUNBOOK.md`: BagFactory first (two-step, reversible until accepted),
   RedeemSettlement last (single-step, irreversible).
4. **Retire the key's admin role**: after step 3 is verified on-chain, the key controls no protocol role. Move any
   personal funds it holds to a new wallet if the key is to be treated as burned.
5. **Remove plaintext copies**: delete `.env.pre-base-rollout-20261108.local`; drop `DEPLOYER_PRIVATE_KEY` from
   `.env.local`. Do this only after step 3, so the only usable credential for the contracts is not destroyed early.
6. **Deployer workflow**: `scripts/execute-app-rollout.mjs` currently requires `DEPLOYER_PRIVATE_KEY`. Add an
   external-signer path (hardware wallet through a JSON-RPC signer, or Hardhat's encrypted keystore) before the
   Arbitrum rollout. Keep its fail-closed checks and journal unchanged.
7. **Hosting secrets**: confirm that Netlify (or any host) stores the attestor key, Supabase service role,
   `SESSION_SECRET`, `CRON_SECRET` and API keys as secrets scoped to production, with access limited to the
   maintainer; rotate any value that ever appeared in a shared screen, log or chat.

## 4. Trade-off: Arbitrum address predictions

The Arbitrum predictions in `evidence/three-chain-app/unsigned-deployments.json` assume `0x49Da…FE46` deploys at
nonce 0, which gives the registry the same address as on Base (`0xcAD8…5920`). A fresh hardware deployer gives
different addresses. The SDK keys registries per chain (`STRATEGY_REGISTRY_DEPLOYMENTS`), so a different address
is functionally fine; same-address registries are a convenience only. Recommendation: use a fresh deployer and
regenerate the manifest, rather than keep the hot key alive for address symmetry. Any transaction from `0x49Da…`
on Arbitrum before then also invalidates the predictions.

## 5. Backups and revocation

- Hardware-wallet seed backups: two physical copies in separate locations; never photographed or typed into a
  computer.
- Safe signer loss: threshold 2-of-3 tolerates one lost signer; replace it with `swapOwner` from the remaining two.
- Attestor compromise or loss: owner Safe calls `setAttestor(newEOA)`; the backend switches its key; old signatures
  stop working immediately (tested: `contracts/test/RedeemSettlement.test.ts`, "admin: … old attestor stops working").
- Response procedures: `INCIDENT_AND_KEY_ROTATION_RUNBOOK.md`.
