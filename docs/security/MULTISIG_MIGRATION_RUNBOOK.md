# Multisig migration runbook

Status: **NOT EXECUTED. Every transaction here is RED: explicit maintainer approval, wallet in the maintainer's
hands, one contract at a time.** Owners and roles are from `PRIVILEGED_AUTHORITY_MATRIX.md`; re-read them first.

## 0. Preconditions (all must hold)

- [ ] `node scripts/audit/authority-snapshot.mjs` run within the hour; owners still `0x49Da…FE46`, pending owners 0.
- [ ] Target Safe deployed on the chain, threshold ≥ 2, owners are hardware wallets, and a **test transaction from the
      Safe** (e.g. a 0-value self-call) has executed on that chain. A Safe that has never executed anything is not
      proven usable.
- [ ] Safe address added to `KNOWN_ACCOUNTS` in the snapshot script; the script classifies it
      `CONTRACT_SAFE_COMPATIBLE` with the expected owners and threshold.
- [ ] The hot key signs only the transfer transactions below, nothing else, from a clean machine.

## 1. BagFactory (Robinhood `0x7Ce5…6f72`, Base `0x9F66…df4a`): two-step, reversible until accepted

| Step | Signer | Call | Verify after |
|---|---|---|---|
| 1 | current owner `0x49Da…` | `transferOwnership(SAFE)` | `pendingOwner() == SAFE`, `owner()` unchanged |
| 2 | SAFE (threshold signatures) | `acceptOwnership()` | `owner() == SAFE`, `pendingOwner() == 0` |
| 3 | — | snapshot script | factory row shows owner = SAFE on both chains |

Rollback before step 2: the current owner calls `transferOwnership` again with the correct address (the pending
owner is replaced). After step 2 the Safe can hand ownership back with the same two steps.
Operational impact: none for users; fee or treasury changes now need Safe signatures.

## 2. RedeemSettlement v2 (Robinhood `0x3eCD…F8A3`): single-step, irreversible on a mistake

`setOwner(newOwner)` takes effect immediately; a wrong or unusable address loses control for good (precedent:
`0x0FB9…984d`, owned by a contract that cannot call `setOwner`). Two options:

**Option A, in place (smaller change):**
1. Complete §1 for at least one chain, proving the Safe can execute on Robinhood.
2. Owner calls `setOwner(SAFE)` with the address pasted from the Safe's own UI/CLI read-back, checked against the
   snapshot output character by character.
3. Immediately: SAFE executes `setAttestor(currentAttestor)` (a no-op value change) to prove it controls the contract.
4. Snapshot: `owner == SAFE`.

**Option B, redeploy (preferred before real fee volume):** deploy a RedeemSettlement v3 whose constructor takes the
Safe as owner and which uses two-step ownership (source change + tests + review first), configure the backend to
it, and leave v2 unconfigured. This also allows S-1 mitigations from `SETTLEMENT_ACCOUNTING_AUDIT.md`. A new
deployment changes the EIP-712 domain and needs the live proof again.

Superseded settlements (v1 `0x934a…`, `0x1B36…`): unconfigured, hold nothing per the deployment record. No action;
listed so a future owner change does not overlook them. The abandoned `0x0FB9…` cannot be changed.

## 3. Attestor custody (no contract change)

The attestor stays a plain EOA (the contract recovers ECDSA signatures; a Safe cannot sign them). Keep it server
side. Rotation: SAFE calls `setAttestor(newEOA)`; deploy the new key to the backend in the same maintenance window;
check `attestor()` and one fee-0 settlement preview.

## 4. Independent confirmation

For every step, two people check, from two RPCs: `owner()`, `pendingOwner()` (factories), `attestor()`, and the
Safe's `getOwners()`/`getThreshold()`. Record block numbers and transaction hashes in
`evidence/authority/` with a new snapshot file; never edit an older snapshot.

## 5. Failure handling

| Failure | Response |
|---|---|
| `acceptOwnership` cannot be executed by the Safe | old owner re-points `transferOwnership` to the old owner or another Safe; investigate the Safe |
| `setOwner` sent to a wrong address | if that address is controlled, it calls `setOwner` back; if not, the contract is lost: stop configuring it, deploy v3 (Option B), move the backend |
| Hot key appears compromised mid-migration | follow `INCIDENT_AND_KEY_ROTATION_RUNBOOK.md` §1 first; speed matters more than order |
