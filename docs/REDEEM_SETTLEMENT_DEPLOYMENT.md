# RedeemSettlement — deployment runbook

Status: **DEPLOYED on Robinhood Chain (2026-10-06), NOT SWITCHED ON** — see §0. This page describes how `contracts/RedeemSettlement.sol` is deployed and switched on, and
what has to be true before and after. Script: `scripts/deploy-redeem-settlement.ts`. Checks:
`lib/blockchain/redeem-settlement-deploy.ts`, tested against a real deployment in
`contracts/test/RedeemSettlementDeploy.test.ts`.

## 0. Deployments (Robinhood Chain, 4663)

| Address | Status | Owner | Attestor | Deploy tx |
|---|---|---|---|---|
| `0x1B365C5325Eb511935F60B7aeA184a3fABedF6f6` | `VERIFIED` by the script at the time; not configured anywhere. **Its attestor is a 7702 account**, which the script now refuses: to be replaced by a plain-EOA attestor before the live test (§0 note) | `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` (EOA) | `0xa1BAf6072301DB78e48BBAeB82a85b9753ACBE5F` (EOA with an EIP-7702 delegation — a MetaMask smart account; signs normally) | `0x48628c32932620179cf9fe6f64560612876104c9aa5aced48c9535b7e4635167`, block 81147074 |
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
- chain, `usdg`, `owner`, `attestor` and `MAX_FEE_RATE_BPS`;
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

## 5. The live test that closes fee settlement

One real sale of a fee-paying Bag, then the chain and the database must describe the same economic event:

- **Chain** (`Settled` event + transfers): gross received X, creator fee Y, user proceeds X − Y, settlement balance 0.
- **Database**: legs' gross proceeds X, `FEE_CHARGED` (settledOnchain) Y, net X − Y,
  `realizedPnl = gross − basis`, `netRealizedPnl = realizedPnl − fee`.
- `Settled` event ↔ receipt ↔ ledger match one to one.
