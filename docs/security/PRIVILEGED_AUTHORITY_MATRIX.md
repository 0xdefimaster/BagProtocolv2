# Privileged authority matrix

Source: `node scripts/audit/authority-snapshot.mjs` (read-only, public RPCs, no keys), output
`evidence/authority/authority-snapshot-2026-11-14.json`. Blocks: Robinhood 113847725, Base 57172316,
Arbitrum 524040939. Every value below was read on-chain at those blocks unless marked *documented*. Re-run the script
before any ownership or key change; this page is a snapshot, not a live view.

## 1. Contracts and roles

| Chain | Contract | Address | Runtime keccak (bytes) | Roles read on-chain | Privilege scope | Status |
|---|---|---|---|---|---|---|
| 4663 | BagFactory | `0x7Ce5A81Df434755F38Cb5f67Ad49a8bb3c8e6f72` | `0x48e56712…d1541` (11231) | owner `0x49Da…FE46`, pendingOwner 0, treasury `0x5186…78cd8`, creationFee 0.00015 ETH, cap 0.01 ETH | `setCreationFee` (≤ immutable cap), `setTreasury`, two-step `transferOwnership`/`acceptOwnership`. No access to Bags or user funds | LIVE |
| 4663 | StrategyRegistry | `0x907cc27d644C8ea1c24B8320ad09eCF2819209A8` | `0x0f559b7b…ebcfd` (4830) | none | none (no owner, admin, fee or upgrade) | LIVE |
| 4663 | RedeemSettlement v2 | `0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3` | `0x5728550a…f50e2` (10194) | owner `0x49Da…FE46`, attestor `0xFf60…dff2`, usdg `0x5fc5…d168`, royalty 2000 bps, max fee 3000 bps | owner: `setAttestor`, **single-step** `setOwner`. Attestor: signs every settlement field (creator, root creator, basis, carry, rate, floor, executor, deadline) | LIVE, configured |
| 4663 | RedeemSettlement v1 | `0x934a3f266e68DfbFF8eD4F02AA393a36048170a0` | `0x50f58682…c26c5` (9498) | owner `0x49Da…FE46`, attestor `0xFf60…dff2` | same as v2 (no royalty) | SUPERSEDED, still callable |
| 4663 | RedeemSettlement (7702 attestor) | `0x1B365C5325Eb511935F60B7aeA184a3fABedF6f6` | `0xf71cc8d9…46002` (9498) | owner `0x49Da…FE46`, attestor `0xa1BA…BE5F` | same as v1 | SUPERSEDED, never configured |
| 4663 | RedeemSettlement (probe owner) | `0x0FB961dd2844091361C6bFcCd92D8f0457DC984d` | `0x98dc1cf5…bc959` (9498) | owner `0x7bEB…5e3C` (a contract), attestor `0xa1BA…BE5F` | **unmanageable**: its owner cannot call `setOwner`/`setAttestor` | ABANDONED |
| 4663 | LI.FI Composer factory (external) | `0xACEB3Bb6C75488b5b806B9de4dCF78814465BdaE` | `0xb3a1317e…7cac5` = pin | — | external; VM 1.2 not audited by BAG | PINNED |
| 8453 | BagFactory | `0x9F66fA3F7a70281eB4F598EfE763B3f83379df4a` | `0xab9c9cdb…612e5` = journal | owner `0x49Da…FE46`, pendingOwner 0, treasury `0x5186…78cd8`, same fees | as Robinhood | DEPLOYED 2026-11-08 |
| 8453 | StrategyRegistry | `0xcAD829DCC30fa88B3d57CC0a6Fa32Bd56c9a5920` | `0x40aa4d92…92c9b` = recorded | none | none | DEPLOYED |
| 8453 | StrategyCompositions | `0x7D4A75a7F196eA90Cf96021ADAC83a0DE93A4Fc8` | `0x5ce5308f…2160d` = journal | registry `0xcAD8…5920` | none (immutable registry binding) | DEPLOYED 2026-11-08 |
| 8453 | LI.FI Composer factory | `0xACEB…BdaE` | = pin | — | external | PINNED |
| 42161 | StrategyRegistry / BagFactory / StrategyCompositions (predicted) | `0xcAD8…5920` / `0x663A…322F` / `0x8B03…98AE` | no code | — | — | NOT DEPLOYED; deployer nonce 0, so the predictions still hold |

Not deployed anywhere according to the repository (no address recorded; absence on-chain cannot be proven without
one): `CreatorRewardsVault`, `RedeemFeeRouter`, `BagExecutionRouter`, Robinhood `StrategyCompositions`.

Cross-chain bytecode check (byte comparison, 2026-11-14): Robinhood and Base `StrategyRegistry` differ only inside
the trailing CBOR metadata; the two `BagFactory` runtimes differ in their own metadata and in 32 bytes at offset
11135, the metadata hash of the embedded `Bag` creation code. Executable code is identical on both chains.

## 2. Role holders

| Address | Kind (on-chain) | Holds | Key location |
|---|---|---|---|
| `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46` | EOA with **EIP-7702 delegation** to `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` on Robinhood (nonce 181) and Base (nonce 10); plain EOA on Arbitrum (nonce 0) | owner of both BagFactories and all four RedeemSettlements; Base Composer proxy owner; `COMPOSER_TEST_SIGNER`; deployer of the Base contracts | **plaintext `DEPLOYER_PRIVATE_KEY` in two ignored files** on the Desktop checkout (address derived locally) |
| `0x5186f0cCAB569dE1655922213074D97914378cd8` | plain EOA (nonce 18 Robinhood, 0 Base) | treasury of both BagFactories (creation fees) | not in the repository's env files; unknown |
| `0xFf60Ab336c3Be45Cfae3B31238dd22DEA176dff2` | plain EOA (nonce 2) | attestor of RedeemSettlement v1 and v2 | not in local env (placeholder); presumably hosting env — **UNVERIFIED** |
| `0xa1BAf6072301DB78e48BBAeB82a85b9753ACBE5F` | plain EOA today (nonce 13) | attestor of the two superseded/abandoned settlements | unknown |
| `0x7bEB437538BC71A95dad6624Aa04bF3594525e3C` | contract | owner of the abandoned settlement | — |

## 3. What each authority can and cannot do

| If this is compromised | Can | Cannot |
|---|---|---|
| `0x49Da…FE46` (owner/deployer) | redirect future creation fees (`setTreasury`), raise the creation fee up to 0.01 ETH, take factory ownership; replace the settlement attestor (breaks every fee-path sale until restored, or enables S-1 of `SETTLEMENT_ACCOUNTING_AUDIT.md` together with a compromised transaction builder); take settlement ownership in one step; spend whatever the account itself holds; consume the Arbitrum nonce-0 prediction | move funds out of users' wallets, Bags or the registry; change a recorded strategy; change the immutable creation-fee cap |
| Attestor `0xFf60…` | sign any settlement, including a 30% rate and any `creator`; it only executes inside a user's own sale transaction whose program BAG's backend built | settle outside a sale the user signs; exceed 30% of the amount above the signed basis; settle a redemption id twice |
| Treasury `0x5186…` | receive creation fees | anything else |

## 4. Gaps

1. One hot key holds every owner role on two chains and is also an everyday smart-account wallet (7702 delegation).
2. RedeemSettlement ownership is single-step; the abandoned `0x0FB9…984d` is the precedent for losing control this way.
3. The documented plan "move both to a Safe before real volume" (`docs/REDEEM_SETTLEMENT_DEPLOYMENT.md` §0) is not done.
4. Attestor and treasury key custody cannot be verified from the repository.
