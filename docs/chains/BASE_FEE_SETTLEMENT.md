# Base: creator performance fee, rebalance, Coinbase tokenized stocks

What changed on 2026-11-19, what is live without any action, and what needs a signed deployment first.

## 1. Rebalance on Base (live after deploy of this code)

`lib/server/rebalance-support.ts` lists the chains where a holder can rebalance from their wallet:
Robinhood Chain and Base. The flow is the existing R2/R3 one (one LI.FI Composer transaction, verified from the
receipt, booked with `apply_rebalance_execution`); only the chain and the hub stablecoin change:

| | Robinhood Chain | Base |
|---|---|---|
| Hub (sells land in it, buys paid from it) | USDG | Circle USDC `0x8335…2913` |
| Verification and settle pass | Robinhood RPC | Base RPC (chain taken from the intent's legs and checked against the recorded transaction's chain id) |

No migration, no contract, no new variable. `GET /api/deploy/chains` now also returns `rebalance` and
`performanceFee` lists. Arbitrum follows the same rules (hub USDC); its rollout is `docs/chains/ARBITRUM_ROLLOUT.md`.
Ethereum stays disabled.

## 2. Creator performance fee on Base (needs one deployment)

`RedeemSettlement.sol` takes its stablecoin as a constructor argument, so the same contract is deployed on Base with
USDC. Nothing in the contract changes. The server picks the contract, token, chain id and freeze check per chain
(`lib/config/settlement.ts`):

| | Robinhood Chain | Base |
|---|---|---|
| Contract variable | `REDEEM_SETTLEMENT_ADDRESS` | `REDEEM_SETTLEMENT_ADDRESS_BASE` |
| Settlement token | USDG (`isFrozen` preflight) | USDC (`isBlacklisted` preflight) |
| EIP-712 domain chain id | 4663 | 8453 |
| Attestor key | `REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY` | the same key; the domain binds every signature to its chain |
| RedeemFeeRouter / CreatorRewardsVault | legacy path | never used |

Until `REDEEM_SETTLEMENT_ADDRESS_BASE` is set, nothing changes for users: Create keeps the fee at 0% on Base, the
validator refuses a fee there, and a fee-paying Base sale cannot exist.

### Deploy (owner, signs one transaction)

```
npx hardhat compile
# .env.local on your own machine: REDEEM_SETTLEMENT_DEPLOYER_PRIVATE_KEY (one-off, a little ETH on Base),
# REDEEM_SETTLEMENT_OWNER_ADDRESS, REDEEM_SETTLEMENT_ATTESTOR_ADDRESS (the address of the existing attestor key),
# REDEEM_SETTLEMENT_DEPLOY_CONFIRM=I_UNDERSTAND_THIS_DEPLOYS_TO_BASE, BASE_RPC_URL (or ALCHEMY_API_KEY)
npx tsx scripts/deploy-redeem-settlement.ts --chain=base
npx tsx scripts/deploy-redeem-settlement.ts --chain=base --verify 0x…   # with the attestor key in env: checks it matches
```

Then set `REDEEM_SETTLEMENT_ADDRESS_BASE` in Netlify and redeploy. Remove the deployer key.

### Test before announcing (small amounts, two wallets)

1. Wallet A creates a Base Bag with a 10% fee (Create now allows it).
2. Wallet B buys, waits for a small gain or not, and sells 50%: the wallet signs one transaction; the `Settled`
   event on Basescan shows `fee` and `userProceeds`; the creator receives USDC in the same transaction.
3. Wallet A sells its own Bag: rate 0, no fee.
4. Rollback: unset `REDEEM_SETTLEMENT_ADDRESS_BASE` (existing fee Bags on Base then cannot be sold with a fee: do not
   unset it once holders exist without a plan for them).

## 3. Coinbase tokenized stocks (B20) on Base

- `lib/config/coinbase-stocks.ts` pins NVDAc, AAPLc, GOOGLc, METAc by address (shared by the registry import and the UI).
- Purchase, sale and rebalance previews show `TokenizedStockNotice`: outside US market hours (Mon–Fri 09:30–16:00
  New York, holidays not modelled) a warning that spreads widen; always a line that Coinbase can pause these tokens.
- A transaction whose simulation fails and that moves one of these tokens adds a plain hint about issuer pauses to
  the error (`coinbaseStockFailureHint`). It is a hint, not a diagnosis: the revert reason is still shown.
- Not done: reading Coinbase's `paused_features` before a sale. The API returns feature numbers whose meaning is not
  documented publicly; guessing would block or allow the wrong thing.
