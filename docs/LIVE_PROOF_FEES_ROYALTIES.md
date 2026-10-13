# Live proof: performance fee and fork royalty, paid and withdrawn

Phase 1, item 1 of `docs/PLAN.md`. Goal: show, with Robinhood Chain transactions anyone can check, that
(1) a non-creator's profitable sale pays the creator a performance fee, and (2) a deposit into a fork
credits the root creator a royalty that the creator then withdraws.

The owner performs the transactions with their own wallets. Nothing here needs or uses a private key in
the repository. Verification is read-only: `scripts/verify-money-flows.ts`.

## How the money moves (from the contracts)

- **Performance fee**: in the sale transaction itself. `RedeemSettlement.settleFlat` computes the fee
  on realized gain above the investor's basis (high-water mark, loss carry), transfers it in USDG
  **directly to the creator's wallet**, the rest to the investor, and emits `Settled`. No vault in
  between.
- **Fork royalty, on-chain (RedeemSettlement v2, not deployed yet)**: 20% of a fork's performance fee goes to
  the root creator in the sale transaction (`RoyaltyPaid`). Test 3 below; `docs/FORK_ROYALTY_ONCHAIN.md`.
- **Fork royalty, legacy** (1.5% of a deposit into a fork, no longer accrued by new purchases): after the purchase, the
  `settle-creator-rewards` scheduled job calls `CreatorRewardsVault.settleReward` from the settler
  wallet. The vault **pulls the USDG from the settler wallet** and emits `Credited`. The creator then
  withdraws from the profile page (`withdrawAll`), which emits `Withdrawn`.

## Prerequisites (owner)

- [ ] Two creator-side wallets and one investor wallet you control. Never use the 0xa1BA wallet.
  - **C** = root creator, **F** = forker (any wallet other than C), **I** = investor (not C, not F).
- [ ] Netlify env set: `REDEEM_SETTLEMENT_ADDRESS`, `CREATOR_REWARDS_VAULT_ADDRESS`,
      `CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY`, `CRON_SECRET` (values never in the repository).
- [ ] The settler wallet (the address of `CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY`):
  - is allowed in the vault (`setSettler`, by the vault owner);
  - holds enough USDG for the royalties;
  - **has approved the vault to spend its USDG**, for a bounded amount (not unlimited). No code in this
    repository does this approval; without it `settleReward` reverts and the royalty stays unsettled.
- [ ] A little ETH for gas and some USDG on I.

## Test 1: performance fee

1. With **C**, create and deploy Bag **A** with a performance fee above 0 (Create → fees). Note its id.
2. With **I**, buy a small amount of **A**.
3. Wait until I's position in A is **in profit after costs** (Portfolio shows positive unrealized P&L).
   The fee is charged only on realized gain; a sale at a loss pays no fee and proves nothing here. A
   volatile asset in A shortens the wait.
4. With **I**, sell the position (or part of it). Copy the sale transaction hash: **SALE_TX**.

## Test 2: fork royalty and withdrawal

1. With **F**, fork Bag **A** into Bag **B** and deploy it.
2. With **I**, buy a small amount of **B**. The purchase records a 1.5% royalty for **C**.
3. Wait for the settlement job (runs every 5 minutes). On the vault's Blockscout page (events tab),
   find the `Credited` event for **C**. Copy its transaction hash: **CREDIT_TX**.
   If nothing appears within ~15 minutes, check the settler prerequisites above.
4. With **C**, open Profile → Creator Rewards → Claim. Copy the transaction hash: **WITHDRAW_TX**.

## Test 3: fork royalty at sale (after RedeemSettlement v2 is deployed)

1. With **F**, fork Bag **A** into Bag **B**, set a performance fee above 0 on **B**, and deploy it.
2. With **I**, buy a small amount of **B**, wait until the position is in profit after costs, and sell it.
   Copy the sale transaction hash: **FORK_SALE_TX**.
3. `npx tsx scripts/verify-money-flows.ts --sale=FORK_SALE_TX --creator=F` must show `ROYALTY_IS_THE_FORK_SHARE`
   and `ROYALTY_PAID_TO_ROOT_CREATOR_IN_USDG` as PASS (20% of the fee to **C**, the rest to **F**).

## Verify

On your computer, in the V2 folder, with `.env` holding the RPC and the two contract addresses:

```
npx tsx scripts/verify-money-flows.ts --sale=SALE_TX --credit=CREDIT_TX --withdraw=WITHDRAW_TX --creator=C
```

Every line must read PASS and the last line `VERDICT PASS`. The script checks, from the receipts only:

| Check | Meaning |
|---|---|
| `TX_SUCCEEDED` | The transaction did not revert |
| `ONE_SETTLED_EVENT_FROM_SETTLEMENT` | The sale went through the configured RedeemSettlement |
| `POSITIVE_FEE`, `BUYER_IS_NOT_CREATOR` | A real fee, on someone else's sale |
| `AMOUNTS_ADD_UP` | fee + investor proceeds = what the swap returned |
| `FEE_PAID_TO_CREATOR_IN_USDG` / `PROCEEDS_PAID_TO_USER_IN_USDG` | The USDG actually moved as the event says |
| `CREDITED_EVENT_FROM_VAULT`, `VAULT_FUNDED_IN_USDG` | The royalty was credited and backed by USDG in the same transaction |
| `ONE_WITHDRAWN_EVENT_FROM_VAULT`, `PAID_OUT_IN_USDG` | The creator withdrew and received the USDG |
| `CREATOR_AS_EXPECTED` | Every event names C |

## Record the result

Add the three transaction hashes and the date to the Decisions/Proof section of `docs/PLAN.md` and mark
"positive fee proven live" and "royalty withdrawal proven live" as done. These links are the evidence
for the investor deck and the public proof page.

## Open question to confirm before the deck

The royalty is funded by the settler wallet's USDG (the vault pulls from `msg.sender`). Whether the
investor's purchase pays that 1.5% to the protocol, or the protocol funds it from its own treasury, must
be stated explicitly in the fee documentation.
