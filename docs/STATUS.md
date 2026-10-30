# Status — what is current, what is live, what each document is

One place that says which parts of this repository describe the system as it
is today. Last updated 2026-10-20. When a document and this page disagree,
this page and the code win.

Labels:

- **CURRENT** — describes the code on `main` as it is.
- **LEGACY** — describes a path that still exists in the code but is not the
  default or the recommended one.
- **NOT IMPLEMENTED** — a design or decision; no code (or no production code).
- **SPIKE** — a time-boxed feasibility experiment; its code is not the product path.
- **HISTORICAL** — a point-in-time report; accurate when written, superseded since.

## 0. Latest live checks (Robinhood Chain, 2026-10-17)

Run with a real wallet, a MetaMask account upgraded to a smart account (EIP-7702). Such an account sends even a single
transaction through MetaMask's DelegationManager (`redeemDelegations`), so `tx.to` is not the target contract; the
verifiers bind to the target's own events and the wallet as sender instead.

| Item | Status |
|---|---|
| Composer SDK against the live Composer API | **Current package: 0.11.3**; the 2026-10-17 live probe used the earlier 0.6 package and is historical evidence only (`scripts/probe-swap-buy.ts`) |
| `BagFactory` v2 (creation fee, `FACTORY_ADDRESS_ROBINHOOD`) | **Live**: user-signed `createBag` confirmed from a smart account. A creation that succeeded but was never confirmed is found on-chain and confirmed by "Try again" (no second signature or fee) |
| Purchase: ETH → three stocks in one Composer transaction, smart account | **Live**: verified and booked |
| `StrategyRegistry` (`STRATEGY_REGISTRY_ADDRESS_ROBINHOOD`) | **Live**: a v1 registration sent from a smart account verified and recorded |
| Bag sale in one Composer transaction, smart account | Wallet asked for one confirmation; booking **not yet observed live** |
| Per-asset sale whose SUBMITTED reports were lost | Recovered from the chain when the sale is closed (PR #94); **not verified live** |
| Fee-paying sale (`RedeemSettlement`, fee > 0) | **Not run live** |
| `core.partition` for exact leg weights | **Available in Composer 0.11.3** and used by the SDK and current purchase compiler; no longer waiting on 0.7 (#88) |

## 1. Live on Robinhood Chain (V2 test site, 2026-10-05)

Observed on bagprotocolv2.netlify.app with a real wallet. Separate Supabase
project and Netlify site from the V1 demo.

| Item | Status |
|---|---|
| Supabase project, `supabase/schema.sql` applied, RLS on every table | **Live** |
| `BagFactory` on Robinhood Chain; user-signed `createBag` + receipt verification | **Live** — a Bag deployed (on-chain version 1) |
| Asset registry (4 crypto + 194 Robinhood Stock Tokens) | **Live** (imported) |
| RPC, LI.FI quotes | **Live** |
| Purchase: one LI.FI Composer transaction, outputs read from the tx receipt, version binding | **Live** — $5 into 4 stocks |
| Redeem by fraction (A4): one LI.FI Composer transaction | **Live** — 50% sale into USDG |
| Execution path used | **Legacy purchase path** (`BAG_EXECUTION_COMPILER_ENABLED` not set: the purchase receipt carries no execution-plan hash). The provider compiler is CURRENT code but not enabled live. |
| `BagExecutionRouter` (BAG Router) | **Not deployed.** See §3 before enabling. |
| `RedeemFeeRouter` / fee-taking redemptions | Not exercised live (the live Bag has no fee). |
| `RedeemSettlement` (fee settlement, §10 of the Composer settlement doc) | **Live**: version 2 `0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3` (configured; replaced version 1 `0x934a3f266e68DfbFF8eD4F02AA393a36048170a0`). First real sale (AMKR + SPY → USDG, tx `0x7550ac9d…9d3d`) settled through version 1 and reconciled chain ↔ `Settled` ↔ ledger (`docs/REDEEM_SETTLEMENT_DEPLOYMENT.md` §5a). Fee was 0 (no gain); a fee > 0 sale not yet run live. |
| `StrategyRegistry` | Deployed since; see §0. (On 2026-10-05: registration and third-party verification proven only on a local EVM.) |
| Price authority (Robinhood `/rhj/prices` × multiplier, Chainlink cross-check, LI.FI crypto prices) | Prices were served live (Bag TVL shown); the authority's guard checks have **not** been verified against live data (`docs/ROBINHOOD_PRICE_AUTHORITY.md`). |

## 1a. Open questions from the 2026-10-05 project report — resolved or not

| Question | State | Evidence |
|---|---|---|
| Does a real sale work on V2? | **Resolved** | 50% Composer redeem completed live (§1) |
| Which execution path did the live purchase use? | **Resolved**: legacy path | No execution-plan hash on its receipt; compiler flag not set |
| Redeem receipt showed "Unknown provider" / "Not recorded" | **Resolved, verified live** (PR #12): LI.FI Composer, "Received 2.45405 USDG · read from the tx receipt" | `execution-receipts.test.ts` models the live redeem |
| Passport showed the deployed composition as "not recorded on-chain" | **Resolved, verified live** (PR #12), no migration: on-chain version 1 shows its composition hash | `bag-deployment-local-evm.integration.test.ts`: deploy tx → BagCreated → Bag address → `compositionHash()` → Passport → bag.json; ambiguous history → null |
| `StrategyRegistry` deployed and verified by a third party on Robinhood Chain | **Open** | Local EVM only |
| Registry panel with a real wallet extension | **Open** | — |
| Realized P&L after a partial sale, checked live | **Open** | — |
| Price authority guard checks against live data | **Open** | `docs/ROBINHOOD_PRICE_AUTHORITY.md` |
| Permit2 / embedded-wallet batching on Robinhood Chain | **Open** | — |
| Redemption fee on actual proceeds | **Design approved** (F1–F7); **B0 merged** (PR #14); live validation pending; B (contract) not started until B0 has run live | §4 |
| Can fee-paying sales execute on Robinhood Chain? (the fee path swaps on Uniswap v3 directly, not LI.FI) | **No for the live Bag; unsafe as built.** Run 1: 582/582 `RPC_ERROR` from invalid address checksums (fixed). Run 2 (2026-10-05): QuoterV2/SwapRouter02 → factory verified on-chain; 212/582 executable, 214 no liquidity, 156 rate-limited RPC errors (to re-run). The live Bag (AMKR/HII/INDA/SOXX) cannot sell through the fee path: AMKR has no Uniswap v3 liquidity at any size. **Safety finding:** many "executable" tokens quote only on a near-empty 1% pool (e.g. AAOI: $25 → $0.18); the attestation takes the first tier that quotes and sets the minimum at 99% of that pool's own quote, so such a sale would execute and lose ~99%. **Fixed in code** (PR #16): every tier is quoted, the best is taken and refused if more than 5% below BAG's verified price (`redeem-quote-quality.ts`, shared with the checker). Re-run of the checker with this rule pending | §4 |

## 2. Tests (on `main`)

Unit (vitest) · integration (real PostgreSQL, and Hardhat's in-process EVM for
contract-backed flows) · contracts (Hardhat). All pass in CI. Integration tests
prove behavior against a local chain, never against Robinhood Chain.

## 3. Decisions in force

- **Non-custodial ("A model").** Assets stay in the user's wallet; BAG never
  signs a user transaction, a deployment or a registry entry.
- **BAG Router stays disabled** (no `BAG_EXECUTION_ROUTER_ADDRESS`, no
  `BAG_ROUTER_PLAN_SIGNER_KEY`) until its plan-signer trust model is resolved.
  Its `planSigner` is a backend key that chooses each leg's calldata *and*
  the minimum outputs: a stolen signer could get a user to submit a plan that
  sends output elsewhere (`contracts/BagExecutionRouter.sol` NatSpec). LI.FI
  Composer is the execution path meanwhile.
- **No upgradeable or proxy registry.** `StrategyRegistry` has no owner, admin,
  fee or upgrade.
- **No alternative registration path** for forks made before migration 0052;
  their parent version is never inferred.
- **No unlimited approvals** until the spender is proven on-chain to be the
  user's own, immutable proxy.

## 4. Known open items

| Item | Where |
|---|---|
| Redemption fee: B0 charges on the guaranteed minimum (never above the fee on the actual result); live validation pending; on-chain computation from actual output is the separate contract PR (B) | `docs/FEE_ECONOMICS_DESIGN.md` |
| Fee-paying sales through LI.FI Composer into a settlement contract | **P1 passed on Robinhood Chain (2026-10-05).** Real transactions: AMKR → LI.FI swap → USDG → BAG probe contract, by push (SP) and by pull (S), and a two-leg sale (AMKR + SPY → merge → push, SP2), each measured in the same tx; reconciliation of every transfer shows nothing left on the proxy; `msg.sender` = the user's Composer proxy. Settlement primitive `RedeemSettlement` with the creator fee computed in the contract from the actual USDG received (B; paid straight to the signed creator, no vault) written and tested locally, not deployed. Two-phase backend attestation (quote/plan → re-check/sign/final compile) written and tested locally (§9). Frontend wired to it; verification trusts only the contract's `Settled` event, and accounting (0054) books no second database fee, ledgering the on-chain fee instead (§10). Deployment, a live `settleFlat` compile and a real ~$1 fee redemption next. Router not deployed | `docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md` §7 |
| B0 live validation is blocked on: (1) Uniswap v3 executability of the Bag's tokens (run the checker), (2) `RedeemFeeRouter` + `CreatorRewardsVault` deployed and configured for V2, (3) a non-creator wallet selling a fee-paying Bag | `scripts/check-fee-router-liquidity.ts` |
| Multi-signature sales on wallets without EIP-5792 (Rabby): one approval per token + the sale | proposal: opt-in persistent approval to the user's own Composer proxy |
| A redemption does not store the fraction sold (receipts show what was sold per asset instead) | `supabase/migrations/0051_fraction_redeem.sql` |

## 5. Documents

| Document | Label | Note |
|---|---|---|
| `README.md` | CURRENT | Entry point |
| `docs/archive/DEMO_READINESS.md` | HISTORICAL | Evidence levels as of 2026-10-05; §0 and §1 of this page are current |
| `docs/STATUS.md` | CURRENT | This page |
| `docs/ACCOUNTING_V2_DESIGN.md` | CURRENT | A1–A4 implemented (0048–0051) |
| `docs/BAG_JSON_V1_DESIGN.md` | CURRENT | bag.json v1, `definitionHash` |
| `packages/bag-sdk/README.md` | CURRENT | Standalone `@bagprotocol/sdk`: **0.3.0 published on npm 2026-10-30** (`latest`, integrity identical to the checked candidate), approved after all release gates closed (live signed purchase VERIFIED on Robinhood Chain; `docs/SDK_RELEASE_PREPARATION.md`); 0.2.1 was the previous npm release. Chain support table in the package README. Includes bag.json v1 parse/validate/normalize/hash, registry verification, and unsigned purchase compilation via a LI.FI Composer adapter. No live LI.FI run from CI |
| `docs/STRATEGY_API_SEMANTICS.md` | CURRENT | Strategy API, passport, execution receipts |
| `docs/STRATEGY_REGISTRY_DESIGN.md` | CURRENT | Contract + verifier + registration flow; not deployed |
| `docs/MCP.md` | CURRENT | Read-only MCP server |
| `docs/USER_SIGNED_DEPLOYMENT.md` | CURRENT | The only production deployment path |
| `docs/PRICE_AND_DATA_LAYER.md` | CURRENT | Chains, RPC, assets, prices |
| `docs/ROBINHOOD_PRICE_AUTHORITY.md` | CURRENT | Live verification still open |
| `docs/PROTOCOL_ECONOMICS.md` | CURRENT | Invariants; see its A4 notes |
| `docs/FEE_ECONOMICS_DESIGN.md` | CURRENT | Performance fee design, F1–F7 locked; B0 merged |
| `docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md` | STUDY | Can fee-paying sales run through Composer into a BAG settlement contract? POSSIBLE-BUT-UNVERIFIED; next step is an isolated PoC |
| `docs/EXECUTION_CANDIDATE_DESIGN.md` | CURRENT | Candidate ranking (compiler path) |
| `lib/execution/README.md` | CURRENT | Provider compiler; disabled live (§1, §3) |
| `docs/CREATOR_REWARDS_SETTLEMENT.md` | CURRENT | Rewards ledger → `CreatorRewardsVault` |
| `docs/SECURITY_HARDENING_DEPLOY.md` | CURRENT | Operator steps for the hardening changes |
| `docs/VSCODE_LOCAL_SETUP.md` | CURRENT | Local setup (Turkish) |
| `docs/archive/INVENTORY_*.md`, `docs/archive/CHANGES_SUMMARY.md`, `docs/archive/COWBOY_COLLECTION.md` | HISTORICAL | Inventory / Forge cosmetics, removed from the app |
| `docs/BAGVAULT_DESIGN.md` | NOT IMPLEMENTED | Design only; no `BagVault.sol` |
| `docs/BAG_SETTLER_DESIGN.md` | NOT IMPLEMENTED | Earlier proposal; its leg model is superseded by `BAG_SETTLEMENT_ARCHITECTURE.md` |
| `docs/BAG_SETTLEMENT_ARCHITECTURE.md` | NOT IMPLEMENTED | Intent / plan / router / adapter design; no contract |
| `docs/ADAPTER_INTERFACE.md` | NOT IMPLEMENTED | Adapter contract and invariants; no contract |
| `docs/STRATEGY_COMPOSITIONS_DESIGN.md` | CURRENT | Contract + registration step merged (#74); not deployed, migration 0060 not run |
| `docs/DECISIONS_PRODUCTION_BACKLOG.md` | NOT IMPLEMENTED | Decided, not built (ADR-1..3) |
| `docs/MIGRATION_AND_ROLLOUT.md` | NOT IMPLEMENTED | Rollout gates and evidence labels for the settlement layer |
| `docs/archive/SPIKE-NOTE-lifi-quote.md` | SPIKE | LI.FI feasibility on Robinhood Chain |
| `docs/archive/durum-raporu-v2.md` | HISTORICAL | Project report of 2026-10-05 (Turkish) |
| `docs/archive/PHASE_14_REPORT.md`, `docs/archive/PHASE_19X_REPORT.md` | HISTORICAL | Phase reports (19.X was a spike) |
| `docs/archive/V10_HARDENING_REPORT.md`, `docs/archive/V11_HARDENING_REPORT.md` | HISTORICAL | Hardening sprint reports |
| `docs/archive/FINAL_PRODUCTION_AUDIT.md` | HISTORICAL | Partly superseded by V11 (noted inside) |
| `durum-raporu-v2.md` | HISTORICAL | Creator rewards / redemption status (Turkish) |
