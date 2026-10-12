# Fork royalty, paid on-chain at each sale

Status: **built and tested on a local chain; not deployed.** The live RedeemSettlement
(`0x934a…70a0`, EIP-712 version `1`) pays no royalty. The royalty starts when the version `2`
contract is deployed and configured (`docs/REDEEM_SETTLEMENT_DEPLOYMENT.md` §6). Not verified live.

## The rule

When a Bag is a fork, the creator at the root of its lineage gets **20% of the fork's performance
fee**, in the same transaction as the sale. The fork's creator gets the other 80%. The investor
pays nothing extra: the fee is computed exactly as before (on actual proceeds above basis and loss
carry, `docs/FEE_ECONOMICS_DESIGN.md`), and the royalty is a split of it.

- Not a fork, or a fork whose root creator is its own creator: no royalty, the whole fee to the creator.
- A fork with a 0% fee (forks start at 0%), or a sale with no gain: no fee, so no royalty.
- Forks of forks: the royalty goes to the **root** (`bags.root_bag_id`), not the direct parent.
- The share is a contract constant (`RedeemSettlement.FORK_ROYALTY_SHARE_BPS = 2000`). A different
  share is a different deployment, never a signed value. Off-chain mirror:
  `FORK_ROYALTY_SHARE_BPS` / `computeSettlementRoyalty` in `lib/blockchain/redeem-settlement-eip712.ts`,
  and `FORK_ROYALTY_FEE_SHARE_BPS` in `lib/config/rewards.ts` (shown in the Passport and on the landing page).

This replaces the old "1.5% of every deposit into a fork" royalty, which was only recorded in the
database and needed a funded settler wallet. Purchases no longer accrue it
(`apply_purchase_execution` gets `p_fork_royalty_bps = 0`); royalties already recorded keep their rows.

## How it works

1. **Attestation** (`lib/server/redeem-settlement-attestation.ts`). The backend resolves the Bag's
   root (`bag.rootBagId`) and, when the root's creator is someone else, their wallet. That address is
   `rootCreator` in the canonical settlement context (`BAG_SETTLEMENT_CONTEXT_V2`, so it is inside
   `contextHash`) and in the signed EIP-712 `Settlement` struct (domain version `2`). Phase 2
   re-reads it and refuses to sign if it changed; the USDG freeze preflight covers it too.
2. **Composer flow** (`lib/blockchain/lifi-composer-adapter.ts`). `settleFlat` gains `rootCreator`,
   and takes the fee rate and deadline packed in one word (`deadline << 16 | feeRateBps`) to stay
   within the legacy code generator's stack limit. The signed struct keeps them as separate fields.
3. **Contract** (`contracts/RedeemSettlement.sol`). After computing the fee it pays
   `fee − royalty` to `creator` and `royalty` to `rootCreator`, and emits `RoyaltyPaid` next to
   `Settled`. `Settled.fee` stays the whole fee. A frozen root creator reverts the whole sale, like a
   frozen creator: nothing moves and the user keeps their holdings.
4. **Verification** (`lib/server/redeem-execution.ts`, `lib/blockchain/redeem-settlement-event.ts`).
   The decoder reads `RoyaltyPaid` with `Settled`; a sale is verified only if any royalty went to the
   attested root creator. `royalty` and `rootCreator` are stored in `settlement_plan.result`.
5. **Accounting.** Unchanged for the investor: the ledger books the whole fee (`FEE_CHARGED`,
   `settledOnchain`), as it did. The split is payout data, in the settlement result.
6. **Proof** (`/dashboard/proof`, `scripts/verify-money-flows.ts --sale=`). Fork royalties paid are
   shown inside the fees paid and on their own row; the sale proof checks `RoyaltyPaid` and both USDG
   transfers.

## Tests

- `contracts/test/RedeemSettlement.test.ts`: 20% split, no royalty without a fork / with root =
  creator / with no fee or a loss, frozen root creator reverts, `rootCreator` is bound by the
  signature, `computeRoyalty` matches the backend, the backend decoder reads `RoyaltyPaid`.
- `contracts/test/RedeemSettlementDeploy.test.ts`: the deployment check reads `FORK_ROYALTY_SHARE_BPS`
  (an old deployment reports it as missing).
- Unit tests for the EIP-712 library, the Composer flow, the event decoder, verification, the Passport
  and the proof page.
