# Runbook: first positive-fee sale through RedeemSettlement v2

**Who runs it:** the owner, with their own wallets and their own environment. Nothing here is run by an
agent or by CI. No private key, seed phrase or `.env` value belongs in this file, a commit, a PR or a chat.

**What it proves:** a non-creator's profitable sale pays the creator a performance fee in USDG, in the sale
transaction itself, and the chain and BAG's books describe the same economic event. Today this is
**NOT VERIFIED**: the only recorded live RedeemSettlement sale went through v1 (2026-10-06), and its fee was 0
(`docs/REDEEM_SETTLEMENT_DEPLOYMENT.md` §5a). No sale through the configured v2 is recorded, so this run is also the
first recorded v2 settlement.

**What it does not prove:** fork royalty (Test 3 in `docs/LIVE_PROOF_FEES_ROYALTIES.md`), any other chain, or
anything about an audit.

Budget: about 5–10 USDG of the investor's own funds, plus gas. A sale at a loss pays no fee and proves
nothing, so the position must be **in profit after costs** when sold.

---

## 0. Stop conditions (read first)

Stop, and record what you saw, if any of these happens. Do not retry with looser settings.

- Any check in §1 fails.
- The sale screen shows an estimated fee of 0, or a "price unavailable" or "price too low" refusal. Wait or
  pick another moment. Never loosen `FEE_REDEEM_MAX_PRICE_DEVIATION_BPS`, the slippage, or (if
  `fix/settlement-price-confidence` is deployed) the `FEE_SALE_*` settings to make it pass.
- The wallet asks to sign anything other than one Composer transaction (plus token approvals for exactly the
  tokens being sold) to the investor's own Composer proxy.
- The transaction reverts. Note the revert reason (`BelowMinimum`, `Expired`, `WrongExecutor`,
  `InvalidSignature`…) and the hash. The user keeps their holdings on a revert.

## 1. Read-only pre-checks (owner's machine)

All of these read the chain only; none needs a key.

1. The configured contract is v2 and the backend key matches the on-chain attestor. Run this in the environment
   that has the production server variables; only the match is printed, never the key:

   ```bash
   npx tsx scripts/deploy-redeem-settlement.ts --verify 0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3
   ```

   Expect `VERIFIED`, `EIP-712 version 2`, `FORK_ROYALTY_SHARE_BPS 2000`, and the attestor match.
2. Netlify (production) has `REDEEM_SETTLEMENT_ADDRESS` = `NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS` = the v2
   address above. Check that the names are set; do not copy values anywhere.
3. No earlier settlement is left unreconciled. The script reads the chain and the database (no write):

   ```bash
   npx tsx scripts/audit-settlement-events.ts
   ```

   Every row should be `BOOKED`. Fix or understand any `UNBOOKED` row before adding a new one.
4. If PR `fix/settlement-price-confidence` is deployed, every stock token in the test Bag needs an entry in
   `ROBINHOOD_CHAINLINK_FEEDS`, or the fee sale is refused (`docs/release-notes/settlement-price-confidence.md`).

## 2. Wallets

| Role | Requirement |
|---|---|
| **C**, creator | Creates the Bag. Must not be frozen by USDG (a frozen creator reverts the whole sale; the app checks before signing) |
| **I**, investor | A different wallet from C. Holds a little ETH for gas and about 5–10 USDG |

Never use the `0xa1BA…` wallet (`docs/LIVE_PROOF_FEES_ROYALTIES.md`).

## 3. Steps

1. **Create.** With **C**, create Bag **A** with a performance fee above 0 (for example 10%) and one or two
   liquid assets. A volatile asset shortens the wait for a gain. Deploy it. Record the Bag id: **BAG_ID**.
2. **Buy.** With **I**, buy about 5 USDG of **A**. Record the purchase tx hash: **BUY_TX**.
3. **Wait for a gain.** Portfolio must show **I**'s position in **A** with positive unrealized P&L after costs.
   The gain must exceed what the sale's own price impact and slippage (up to about 1%) will take.
4. **Preview.** Open the sale for 100% of the position. The preview must show a positive estimated fee. Record a
   screenshot. The exact fee is fixed on chain from what actually arrives, so it can differ slightly.
5. **Sell.** Confirm. The wallet signs **one** Composer transaction to **I**'s own proxy. Record the hash:
   **SALE_TX**.
6. **Wait** until the app shows the sale as completed (the intent reaches `COMPLETED`).

## 4. Verify (read only)

```bash
npx tsx scripts/verify-money-flows.ts --sale=<SALE_TX> --creator=<C address>
```

Every line must be `PASS`:

| Check | Meaning |
|---|---|
| `TX_SUCCEEDED` | The sale transaction succeeded |
| `ONE_SETTLED_EVENT_FROM_SETTLEMENT` | Exactly one `Settled` event from the v2 address |
| `POSITIVE_FEE` | `fee > 0` on a positive `feeBase` |
| `BUYER_IS_NOT_CREATOR` | The investor I is not the creator C |
| `AMOUNTS_ADD_UP` | `fee + userProceeds == received` |
| `CREATOR_AS_EXPECTED` | The event names C |
| `FEE_PAID_TO_CREATOR_IN_USDG` | USDG transferred to C equals the fee (no royalty, since A is not a fork) |
| `PROCEEDS_PAID_TO_USER_IN_USDG` | USDG transferred to I equals `userProceeds` |
| `AT_MOST_ONE_ROYALTY_EVENT` | 0 here |

Then check the books against the chain (`docs/REDEEM_SETTLEMENT_DEPLOYMENT.md` §5):

```bash
npx tsx scripts/audit-settlement-events.ts
```

The new event must be `BOOKED`. In the app or database for **BAG_ID** / **I**:
- the legs' gross proceeds equal `received`;
- `FEE_CHARGED` (settled on chain) equals `fee`;
- net equals `received − fee`;
- realized P&L is gross minus basis.

Also check that `fee == floor(max(0, received − consumedBasis − lossCarry) × rate / 10000)`, using the
`Settled.feeBase` and the signed basis shown in the intent's settlement plan.

## 5. Record

Add one row to `docs/REDEEM_SETTLEMENT_DEPLOYMENT.md` (a new §5b, in the style of §5a) and update
`docs/STATUS.md`. Record:
- the date, Bag id, fee rate;
- `SALE_TX` and its block;
- received, fee, user proceeds;
- the script output (PASS lines);
- the audit row status.

Only then change the label for "RedeemSettlement fee > 0" from NOT VERIFIED to **LIVE VERIFIED (Robinhood Chain,
v2)**. Fork royalty stays NOT VERIFIED until Test 3 passes.
