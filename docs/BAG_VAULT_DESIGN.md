# BagVault — in-kind share token (spike)

> **Status: SPIKE.** `contracts/BagVault.sol` + `contracts/BagVaultFactory.sol`
> and their tests exist (`contracts/test/BagVault.test.ts`, Hardhat in-process
> EVM). **Not deployed anywhere, no deploy script, not wired to the app or the
> API, not audited.**
>
> This supersedes the older proposal in `docs/BAGVAULT_DESIGN.md` for this
> spike. That design priced deposits from an off-chain, signer-attested NAV and
> let `BagExecutionRouter` swap the vault's assets. This one has no signer, no
> oracle and no swaps. See §3 for why.

## 1. What it is

`BagVault` gives each Bag a transferable ERC-20 share token, backed by the
basket's components held in the contract.

| Operation | What the caller does |
|---|---|
| `mint(shares, receiver, maxAmountsIn[])` | Deposits every component pro-rata and receives exactly `shares` |
| `redeem(shares, receiver, minAmountsOut[])` | Burns `shares` and receives every component pro-rata |

There are no other user paths. The contract never swaps, never calls anything
but the component tokens, reads no price and trusts no backend key.

`BagVaultFactory.createVault(bag, name, symbol, tokens, unitAmounts, guardian)`:
- creates at most one vault per Bag (`vaultOf[bag]`);
- may be called only by the Bag's own creator;
- works only for a Bag the trusted `BagFactory` deployed (`bag.factory() == bagFactory && bagFactory.bagOf(bag.bagId()) == bag`);
- leaves `BagFactory.sol` untouched.

## 2. Mechanism

**Unit basket.** `unitAmounts[i]` is the amount of component *i* per 1e18 shares.
It prices the first mint only. Shares have 18 decimals.

**First mint** (`totalSupply == 0`):
- `shares` must be at least `MIN_FIRST_MINT` (1e9).
- The caller pays `ceil((shares + DEAD_SHARES) × unit_i / 1e18)` of each component.
- `DEAD_SHARES` (1,000) are minted to `0x…dEaD` and can never be redeemed.

**Later mints:** the caller pays `ceil(shares × holding_i / totalSupply)` of each component.

**Redeem:** the caller receives `floor(shares × holding_i / totalSupply)` of each component.

**Slippage protection:**
- `mint` reverts if any amount exceeds `maxAmountsIn[i]` (`AboveMaxAmountIn`).
- `redeem` reverts if any amount is below `minAmountsOut[i]` (`BelowMinAmountOut`).
- Composition does not move between preview and execution, but `holding/supply` can: donations are excluded, while other users' rounding still changes it.

**Holdings are internal accounting** (`_holdings[i]`), not `balanceOf`. Tokens sent
straight to the vault are never counted.

**Balance-delta transfers.** Every transfer, in and out, is measured on the vault's
own balance. Any difference from the expected amount reverts (`TransferAmountMismatch`).

**Fixed composition:**
- `tokens` and `unitAmounts` are fixed at construction. There is no rebalance and no admin function to change them. This is deliberate for the spike.
- The vault records the Bag's `version` and `compositionHash` at creation (`bagVersion`, `compositionHash`).
- `isCurrentComposition()` says whether the Bag still has that composition. If the Bag records a new version, the vault keeps holding the old one; it never follows on its own.

**Emergency pause:**
- `guardian` can pause and unpause **mint only** (`setMintPaused`). Redeem has no pause check, so holders can always exit.
- The guardian can hand the role on or renounce it (`setGuardian(0)`).
- There is no other privileged role: no owner, no upgrade (no proxy), no fee, no withdraw.

## 3. Why no swap, no oracle, no signer

- **No signer.** BAG Router is kept disabled because its plan signer is a hot key that can author swap calldata routing a user's output elsewhere (`docs/STATUS.md`; `docs/SECURITY_HARDENING_DEPLOY.md` "Privileged keys"). A vault that needed a signed NAV or a signed plan would bring back the same trust boundary. In-kind mint/redeem needs no price, so it needs no signer.
- **No oracle.** The share *is* the basket: one share is always worth `holding_i / supply` of each component, whatever the market says. Oracle risks (staleness, manipulation, Stock Token market hours) stay off-chain, in the purchase path that already handles them (`MARKET_CLOSED_OR_HALTED`, staleness checks).
- **No swap.** Turning USDG into the basket remains the job of the existing, verified execution layer (LI.FI Composer, receipts). A future flow can compose the two in one transaction: swap into components, then `mint`. The vault never holds or calls a DEX, so a DEX bug cannot drain it.

## 4. Threat model

| Threat | Mitigation | Test |
|---|---|---|
| Rounding extraction (repeated tiny mint/redeem) | Mint rounds up, redeem rounds down, per component | "rounding always favours the vault" |
| First-depositor / inflation via donation | Internal holdings ignore donations; `DEAD_SHARES` keep supply > 0; `MIN_FIRST_MINT` | "inflation / donation attack" |
| Supply returning to 0 with leftover holdings (the next "first mint" would claim them) | Dead shares are unredeemable, so supply ≥ 1,000 forever after the first mint | same + invariants test |
| Reentrancy through a token hook (ERC-777-style) | `nonReentrant` on mint and redeem (shared lock); redeem burns and updates holdings before transfers | "reentrancy" (HookERC20 + ReentrantExecutionTarget) |
| Read-only reentrancy (a view read from a token hook mid-call) | mint moves holdings and supply together after every transfer; redeem moves both before any transfer, so views are never half-updated | "read-only reentrancy" (HookERC20 as the last component + VaultViewRecorder) |
| Fee-on-transfer token | Balance-delta check in and out → revert | "fee-on-transfer" (both directions) |
| Admin rug | No withdraw, no owner, no upgrade; guardian can only pause mint | "pause stops mint only" |
| Fake Bag / squatting a Bag's vault | Factory checks `BagFactory.bagOf` and `bag.creator() == msg.sender`; one vault per Bag | factory tests |
| Wrong component list for the Bag | **Not enforced on chain** (see §9) | — |

**Out of scope / unsupported tokens:**
- **Rebasing tokens.** A negative rebase makes the vault unable to pay the last redeemers; a positive one leaves surplus stuck (holdings are internal). They cannot be detected generally at deposit time. They must not be components; see §9 for the open question on how this is enforced.
- **Freezable / blocklisting tokens (USDG is Paxos-issued and freezable).** If the vault address were frozen, every redeem would revert for that component, and with it the whole redeem. If only the receiver is frozen, the holder can redeem to another address (`receiver`). There is no partial redeem, which is an open question (§9).

## 5. Invariants

Checked after every step of a randomized multi-user run, and at the end:

1. **Accounting.** `holding_i == token_i.balanceOf(vault)` when nobody donated. With donations, `≥`.
2. **Value per share never decreases** through user operations: `holding_i_after × supply_before ≥ holding_i_before × supply_after`.
3. **Conservation.** After everyone redeems, the users' net loss of each component equals exactly what remains in the vault. In aggregate, users never take out more than they put in.
   - An individual user can end slightly ahead: rounding gains accrue to whoever holds shares at the time.
4. **The supply never returns to 0** after the first mint (it ends at `DEAD_SHARES`), and the dead shares' basket stays (`holding_i > 0`).

## 6. Rounding rules

| Path | Rounding | Who it favours |
|---|---|---|
| First mint | `ceil((shares + DEAD_SHARES) × unit / 1e18)` | vault |
| Mint | `ceil(shares × holding / supply)` | vault (holders) |
| Redeem | `floor(shares × holding / supply)` | vault (holders) |

All use OpenZeppelin `Math.mulDiv` (full 512-bit intermediate, no overflow).
The worst-case loss to a minter-then-redeemer is at most 1 unit + 1 unit per
component (ceil then floor). The donation test checks it stays ≤ 2 units.

## 7. Migration options from today's off-chain shares

Today, shares are accounted in Supabase (`bag_share_state`, `lib/server/bag-share-state-repo.ts`) and the assets sit in each user's own wallet. Options only; nothing is written here.

1. **Opt-in wrap.** A holder moves their components into the vault with `mint`. The off-chain position for that Bag is then closed or flagged as wrapped. No forced move; works per user.
2. **New Bags only.** Vault-backed Bags start with a vault from day one; existing Bags stay off-chain-accounted.
3. **Snapshot migration.** Users approve, and a one-off per-user `mint` mints their off-chain share count at the current composition. This needs every user's components in the wallet in exact proportion. Not realistic after drift, so (1) is the more practical path.

Open for all three:
- how the off-chain ledger (cost basis, HWM, creator fee) carries over to a transferable token;
- what a transfer of shares means for the off-chain accounting (see `docs/ACCOUNTING_V2_DESIGN.md`).

## 8. Gas (Hardhat in-process EVM, from the test output)

| Components | createVault | first mint | mint | redeem |
|---|---|---|---|---|
| 2 | 2,756,134 | 254,358 | 137,861 | 106,224 |
| 5 | 2,903,823 | 471,948 | 246,851 | 197,153 |
| 10 | 3,154,132 | 834,607 | 428,510 | 348,710 |

Mint and redeem scale linearly with the component count, about 35k–40k per
component (two balance reads and one transfer each, plus storage). Not measured
on Robinhood Chain; L1 data cost is not included.

## 9. Open questions before an audit

1. **Binding the component list to the Bag.** `compositionHash` is built from a string with symbols and addresses as stored (`lib/domain/basket-protocol/version.ts`) and cannot be recomputed on chain. Options:
   - an off-chain check only (today);
   - a new on-chain composition hash over `abi.encode(tokens, weights)`;
   - committing the bag.json `definitionHash` and checking `unitAmounts` against weights.
2. **What `unitAmounts` mean.** Weights are value-based (bps of NAV), but a unit basket is quantity-based. Who chooses the unit basket? Is it derived from prices at creation, and by whom? Today it is set by the creator.
3. **Token allowlist.** Should the factory accept only verified, non-rebasing components (e.g. the asset registry or an on-chain list)? Who maintains it without becoming an admin?
4. **Guardian.** Who holds it: the creator, a multisig, or nobody? Should renouncing while paused be forbidden (it would pause mint forever)?
5. **Frozen components.** Should redeem allow skipping a frozen component (partial redeem), at the cost of a more complex invariant?
6. **Composition changes.** With a fixed list, a Bag's new version means a new vault and a migration. Is that acceptable, or does the vault need a rebalance path? That would bring back swaps, prices and trust (see `docs/ONCHAIN_DESIGN.md`).
7. **Fees.** No creator fee in the vault. How does `RedeemSettlement` / the off-chain fee model apply to a transferable token? See `docs/ONCHAIN_DESIGN.md` §1.
8. **Stock Tokens.** Mint/redeem in kind needs no market prices, so market hours do not block it. Whether that is desirable, and how splits and dividends of the underlying are reflected, is open (`docs/ONCHAIN_DESIGN.md` §4).
9. **`MIN_FIRST_MINT` and `DEAD_SHARES` values.** These are picked for 18-decimal shares and unit baskets far above 1e-9. They should be re-checked against real unit baskets, including 6-decimal components with small unit amounts.
