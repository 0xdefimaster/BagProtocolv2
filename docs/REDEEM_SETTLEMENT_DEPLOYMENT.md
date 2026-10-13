# RedeemSettlement — deployment runbook

Status: **LIVE on Robinhood Chain (2026-10-06)** — deployed, switched on, first real fee-path sale reconciled (§5a). This page describes how `contracts/RedeemSettlement.sol` is deployed and switched on, and
what has to be true before and after. Script: `scripts/deploy-redeem-settlement.ts`. Checks:
`lib/blockchain/redeem-settlement-deploy.ts`, tested against a real deployment in
`contracts/test/RedeemSettlementDeploy.test.ts`.

## 0. Deployments (Robinhood Chain, 4663)

| Address | Status | Owner | Attestor | Deploy tx |
|---|---|---|---|---|
| `0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3` | **Version 2 (fork royalty), deployed 2026-10-13, not switched on yet.** `VERIFIED` by the owner's run of the deploy script (EIP-712 version 2, `FORK_ROYALTY_SHARE_BPS` 2000, holds nothing; owner `EOA_7702`, attestor plain EOA). Replaces `0x934a…70a0` when §6 step 3 is done | `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` (EOA with an EIP-7702 delegation) | `0xFf60Ab336c3Be45Cfae3B31238dd22DEA176dff2` (plain EOA) | `0x4e6c6aa47279064aa3f535db5c439f51e4cf3b7d319d25fb1d45560c40a3b1bd`, block 87108715 |
| `0x934a3f266e68DfbFF8eD4F02AA393a36048170a0` | **Current (version 1), switched on.** `VERIFIED` (all checks incl. owner and attestor plain EOAs); configured in Netlify | `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` (EOA) | `0xFf60Ab336c3Be45Cfae3B31238dd22DEA176dff2` (plain EOA, holds nothing) | `0xd31a4c1a712adf1e761c407d836f94174371921b3a6043ddd93c5829a543e0eb`, block 81169553 |
| `0x1B365C5325Eb511935F60B7aeA184a3fABedF6f6` | **Superseded — never configured.** Its attestor was a 7702 account holding funds; replaced by a fresh deployment with an empty plain-EOA attestor | `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` (EOA) | `0xa1BAf6072301DB78e48BBAeB82a85b9753ACBE5F` (EOA with an EIP-7702 delegation — a MetaMask smart account; signs normally) | `0x48628c32932620179cf9fe6f64560612876104c9aa5aced48c9535b7e4635167`, block 81147074 |
| `0x0FB961dd2844091361C6bFcCd92D8f0457DC984d` | **Abandoned — never configure.** Its owner is the P1 probe contract (`0x7bEB…5e3C`), which cannot call `setAttestor`/`setOwner`: unmanageable. Holds nothing. | `0x7bEB437538BC71A95dad6624Aa04bF3594525e3C` (contract) | same | `0x6de197c76918bdef94540ba25f47a84dfb57da497f8382383a3e142f7a8ddb8d`, block 81144647 |

**Decision (2026-10-06):** the attestor must be a plain EOA before the live test. Either `setAttestor(plainEOA)` from
the owner, or a fresh deployment with a plain-EOA attestor (no owner transaction needed). The chosen route and the
resulting address are recorded here.

Deployer of both: the P1 disposable wallet `0xb193…56b8` (no power after deployment). The abandoned deployment is
why the script now refuses a contract owner without an explicit confirmation, and a contract attestor always.

The current owner is also BagFactory's owner: one admin key for both contracts. Acceptable for the ~$1 test; move
both to a Safe before real volume.

## 1. What the contract takes and allows

`constructor(address usdg, address attestor, address owner)`, EIP-712 domain `BagRedeemSettlement` / `1`.

| | |
|---|---|
| `usdg` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals). **Immutable**: another token is another deployment. |
| `attestor` | The backend signer's address. Every settlement must carry its EIP-712 signature. Signs only; sends no transaction, needs no ETH. |
| `owner` | The only admin. |
| Owner powers | `setAttestor(new)` and `setOwner(new)`. Nothing else: no pause, no withdrawal (the contract holds nothing between transactions), no fee or token change (`MAX_FEE_RATE_BPS = 3000` is a constant), no upgrade. |
| Owner risk | A stolen owner key can `setAttestor(attacker)` and then sign settlements. **The owner key is the most sensitive key**; move it to a Safe/multisig before real volume. |
| `setOwner` | Single-step: a wrong address loses ownership for good. |
| EIP-712 domain | `chainId = block.chainid` (4663) and `verifyingContract = address(this)`. The backend signs with `ROBINHOOD_CHAIN_ID` and `REDEEM_SETTLEMENT_ADDRESS`; if that env value is not the deployed address, every signature fails (`InvalidSignature`), so nothing settles rather than something settling wrongly. |

## 2. Three keys, three trust boundaries

| Role | What it is | ETH | Where the key lives |
|---|---|---|---|
| Deployer | A one-off key that only sends the deploy transaction | a little, for gas | `.env.local` on your machine during the deploy only; delete afterwards |
| Owner | Contract administration (`setAttestor`, `setOwner`) | only when it acts | Your wallet (later a Safe). **Never** in the repo, `.env.local` of the server, or Netlify |
| Attestor | Signs "this settlement is authorized under these conditions" | none | **Only** as the server secret `REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY` (never `NEXT_PUBLIC_`) |

Owner and attestor are passed straight to the constructor, so the deployer has no power once the deploy is mined —
no ownership transfer step.

**Operational guards vs contract invariants.** The script refuses `deployer == owner`, `deployer == attestor` and
`owner == attestor`, an attestor with contract code (it could never sign; the contract does not use ERC-1271), and an
owner with contract code unless `REDEEM_SETTLEMENT_OWNER_IS_CONTRACT=yes` (for a Safe). An EOA with an EIP-7702
delegation (code `0xef0100` + 20 bytes, e.g. a MetaMask smart account) is fine as owner, but refused as attestor
unless `REDEEM_SETTLEMENT_ATTESTOR_ALLOW_7702=yes`: the attestor only signs, so it should be a plain EOA (the
delegation works for ECDSA but is an unneeded moving part). These are BAG's deployment discipline, not rules of the contract: the contract would accept
them. What the contract itself enforces is non-zero addresses and the fixed token/domain.

## 3. Deploy

On your own machine, in `.env.local` (never committed):

```
REDEEM_SETTLEMENT_DEPLOYER_PRIVATE_KEY=0x…        # one-off deploy key
REDEEM_SETTLEMENT_OWNER_ADDRESS=0x…               # address only
REDEEM_SETTLEMENT_ATTESTOR_ADDRESS=0x…            # address only
REDEEM_SETTLEMENT_DEPLOY_CONFIRM=I_UNDERSTAND_THIS_DEPLOYS_TO_ROBINHOOD_CHAIN
```

```
npx hardhat compile
npx tsx scripts/deploy-redeem-settlement.ts
```

Before sending, the script checks:
- the RPC reports chain 4663;
- the three addresses are valid, non-zero and distinct;
- USDG has code and 6 decimals;
- the deployer has ETH.

After mining, it reads the contract back and checks:
- chain, `usdg`, `owner`, `attestor`, `MAX_FEE_RATE_BPS` and `FORK_ROYALTY_SHARE_BPS` (2000; reported missing on a
  version `1` deployment);
- the EIP-712 domain (`eip712Domain()`: name, version, chainId, verifyingContract);
- the contract holds no USDG.

Anything other than `VERIFIED` means: do not configure that address anywhere. The script prints addresses and
transaction hashes only — never a key or the RPC URL — and writes no files.

## 4. Switching it on (only when ready for the live test)

Setting these turns fee-paying sales on in the app (`lib/server/fee-redemption-path.ts`), so do it only when the
~$1 live test is about to run:

| Variable | Where | Secret |
|---|---|---|
| `REDEEM_SETTLEMENT_ADDRESS` | server | no |
| `NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS` | browser (same address) | no |
| `REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY` | server only | **yes** |

Then:

```
npx tsx scripts/deploy-redeem-settlement.ts --verify 0x<RedeemSettlement>
```

With `REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY` in the same environment it also checks that the backend's signing key
belongs to the on-chain attestor (only the match is printed). Remove the deployer key afterwards.

## 5a. First live sale through RedeemSettlement (2026-10-06) — reconciled

Bag `spy&amkr` (AMKR + SPY, 8.5% performance fee), bought for 3.00 USDG and sold 100% by a non-creator wallet
(`0x5186…8cd8`). Tx `0x7550ac9d15cbab5947c96f6eca4c10d2d3c15ef1c027f3a8587b499606ad9d3d`, block 81204116, `success`.

| | Chain (`Settled` + transfers) | Database |
|---|---|---|
| Gross received by the settlement | 2.975572 USDG (two legs: 1.483230 + 1.492342, pushed by the user's Composer proxy) | ledger `REDEEM_FILL` proceeds 2.975572 (2 legs) |
| Creator fee | 0 (`feeBase` 0: no gain over the 3.00 basis) | no `FEE_CHARGED`, no `creator_reward_settlements` row |
| User proceeds | 2.975572 USDG to the seller | `settlement_plan.result.userProceeds` 2975572 |
| Settlement balance after | 0 | — |
| Intent | — | `COMPLETED`, accounting applied, result tx hash = the tx above |

Realized P&L = 2.975572 − 3.00 = −0.024428; fee 0; net the same. Chain, `Settled` event and ledger record the same
economic event. A LI.FI route intermediary kept a few USDG units, as seen in P1; outside the settlement and not part
of `received`.

Not yet exercised live: a sale **with a gain**, so `fee > 0` reaching the creator. The path is the same; only the
amount differs (covered by contract and integration tests).

Live issues found on the way, both resolved: migrations 0053/0054 had not been applied to the production database
(`settlement_plan` column missing → generic error; now logged since PR #30), and a basket of illiquid tokens was
refused by Composer's 5% price-impact guard (correct behavior; guard not loosened).

## 5. The live test that closes fee settlement

One real sale of a fee-paying Bag, then the chain and the database must describe the same economic event:

- **Chain** (`Settled` event + transfers): gross received X, creator fee Y, user proceeds X − Y, settlement balance 0.
- **Database**: legs' gross proceeds X, `FEE_CHARGED` (settledOnchain) Y, net X − Y,
  `realizedPnl = gross − basis`, `netRealizedPnl = realizedPnl − fee`.
- `Settled` event ↔ receipt ↔ ledger match one to one.

## 6. Version 2: fork royalty (deployed 2026-10-13 at `0x3eCD…F8A3`, not switched on yet)

The code in this repository now signs for EIP-712 domain version `2` (`Settlement` gained `rootCreator`;
`settleFlat` takes `rootCreator` and a packed `feeRateAndDeadline`). The live version `1` contract cannot
verify those signatures, so **fee-paying sales fail until version 2 is deployed and configured**. Order:

1. Deploy version 2 with §3 (same script, same owner and attestor addresses; a fresh one-off deployer key). The
   attestor key does not change, so `REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY` stays as it is.
2. `npx tsx scripts/deploy-redeem-settlement.ts --verify 0x…` must print `VERIFIED`, including
   `EIP-712 version 2` and `FORK_ROYALTY_SHARE_BPS 2000`.
3. At a quiet moment (no sale in progress — an attested plan names the old contract and would no longer verify),
   set `REDEEM_SETTLEMENT_ADDRESS` and `NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS` to the new address, and deploy
   the app from the branch that carries version 2 at the same time.
4. Record the new address in §0 and mark `0x934a…70a0` superseded.
5. Live test: a gain-bearing sale of a fork with a fee above 0, by an investor who is neither creator, then
   `npx tsx scripts/verify-money-flows.ts --sale=0x…`. Until that passes, the royalty is **not verified live**.

Rule, flows and tests: `docs/FORK_ROYALTY_ONCHAIN.md`.

