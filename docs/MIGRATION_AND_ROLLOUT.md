# Settlement migration and rollout

Status: **plan.** Nothing here has been executed. How BAG moves from today's execution paths to the settlement layer
in `docs/BAG_SETTLEMENT_ARCHITECTURE.md`, and which evidence each step needs before the next one starts.

## Evidence labels

Every claim in a status page, PR or report carries one of these labels.

| Label | Means |
|---|---|
| `SOURCE_CONFIRMED` | Read in the source on `main` (or a named commit). Says nothing about what is deployed. |
| `FORK_TESTED` | Ran against a fork of the real chain with real contracts. A local Hardhat EVM with mocks is **not** a fork. |
| `REAL_WALLET_TESTED` | A human signed with a real wallet (MetaMask, Rabby, …) on the real chain. A test key on a signing page is not. |
| `LIVE_BYTECODE_MATCHED` | The live runtime code at the address equals a locally compiled artifact, with immutables masked. A getter-only deployment check does not qualify. |
| `NOT_YET_PROVEN` | None of the above yet. |

## Today

| Path | Executes through | Status |
|---|---|---|
| Purchase (app) | LI.FI Composer | Live on Robinhood Chain |
| Purchase (SDK 0.3.0 candidate) | LI.FI Composer | Unsigned compile live-checked; a signed SDK purchase is still a release gate |
| `BagExecutionRouter` | planSigner-signed plans | Deployed code exists; disabled (`docs/STATUS.md` §3) |
| Fee-paying sale | Current redemption settlement contract | Live; successor planned (below) |
| DCA | Research only (#128–#131) | Not production |

## Phases and gates

Each phase starts only when the previous gate holds.

**G0 — prerequisites.**
- `scripts/verify-settler-prereqs.ts` passes on Robinhood Chain (Permit2, deployer, WETH, USDG, a v3 pool);
  record the output.
- `StrategyCompositions` is deployed, and its registration step works with a real wallet.
- Required: `LIVE_BYTECODE_MATCHED` for StrategyCompositions, `REAL_WALLET_TESTED` for one composition publication.

**G1 — specification frozen.**
- EIP-712 types for `BasketIntent`, `ExecutionPlan` and `SellIntent`, the adapter interface, and the `BasketSettled`
  receipt schema.
- Test vectors (hashes and signatures) shared by Solidity and the SDK.
- Required: `SOURCE_CONFIRMED`, vectors passing in both.
- **Status (2026-10-30): in code, pending review.**
  - Types and hashing: `contracts/settlement/BasketTypes.sol` with `lib/domain/settlement/basket-types.ts`.
  - Interfaces: `IBasketAdapter.sol` and `IBagSettlementRouter.sol` (event and external surface).
  - Vectors: `contracts/test/vectors/basket-settlement-v1.json`, from `scripts/generate-basket-vectors.ts`. They pass
    in Hardhat (`contracts/test/BasketTypes.test.ts`) and in vitest.
  - The SDK package itself gets the TypeScript side when the router ships (G4).

**G2 — contracts.**
- Router plus `UniswapV3ExactInAdapter`:
  - unit tests for every R- and A-invariant;
  - property / fuzz tests on the split and on fee caps;
  - adversarial adapter mocks.
- Fork tests on Robinhood Chain with real USDG and real pools, including refusal when liquidity cannot meet the limits.
- Required: `FORK_TESTED`.

**G3 — independent review.**
- External audit of the router, the v1 adapter and the sale direction together. Findings fixed or documented as
  accepted.
- A public bug bounty scope is defined.

**G4 — testnet.**
- Deploy on Robinhood testnet (46630).
- SDK `settlement` adapter and `verifyBasketReceipt`, pinned to testnet addresses and code hashes.
- App path behind a feature flag.
- Required: `LIVE_BYTECODE_MATCHED` (testnet), `REAL_WALLET_TESTED` with MetaMask and Rabby: one-shot purchase, then
  receipt verified by the SDK.

**G5 — mainnet, guarded.**
- Deploy; record addresses, code hashes and the deploy transactions in `docs/`.
- A per-purchase size limit enforced by the SDK and backend (the router has no admin).
- A small allowlisted cohort first.
- Required: `LIVE_BYTECODE_MATCHED`, `REAL_WALLET_TESTED` purchases verified by `verifyBasketReceipt`.

**G6 — default path.**
- The app buys through the router by default. Composer remains an optional quote source or adapter.
- API `/v1/quote` and `/v1/status` serve SDK output only.

**G7 — sale direction.**
- Fee-paying sales move to the router's sale direction (same audit as G3).
- Basis attestations come from an ERC-1271 / threshold signer.

## Retiring the current redemption settlement contract

Executed only at G7, in this order:

1. **Freeze new attestations for the old contract.**
   - The backend stops issuing settlement attestations. Fee-paying sales pause; fee-free sales continue.
   - Attestations carry a deadline of at most a few minutes, so the old contract has nothing valid left to execute
     shortly afterwards.
2. **Rotate the old contract's attestor** to a fresh address whose key is not held by the server, so nothing can sign
   for it again.
3. **Switch the fee path** (`lib/server/fee-redemption-path.ts`) to the router's sale direction.
4. **Leave the old contract in place, inert.** It holds no balance between transactions. Record the final state.

Step 1 is also the operational stop for the old path at any earlier time, should it be needed. It only pauses
fee-paying sales; it moves no funds.

## Key management

- **Router and adapters:** no admin at all. A change means a new version and a new SDK pin.
- **Any supporting contract with an owner:** `Ownable2Step` (`pendingOwner` + `acceptOwnership`, as `BagFactory`
  already does). The owner is a Safe, not an EOA.
- **Attestation for the sale direction:** an ERC-1271 contract (Safe or m-of-n signer). The server may hold one share
  at most.
- **Old contracts with single-step ownership:** a handover is one careful transaction to a Safe, followed immediately
  by a test call from the Safe.

## Rollback

- **Before G6:** nothing to roll back; Composer stays the default.
- **After G6:** the backend and SDK can return to the Composer path by configuration. The router keeps working for
  anyone who calls it directly. A defect in the router means a new version plus an SDK pin change; outstanding
  intents expire by their deadline, and users can revoke nonces and approvals.

## Not claimed

- No production claim for DCA until a wallet permission class is `REAL_WALLET_TESTED` and its executor is audited
  with the router.
- No claim that any token can always be bought: a purchase without enough liquidity within the payer's limits is
  refused.
