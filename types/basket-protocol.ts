// -----------------------------------------------------------------------------
// BAG Protocol — basket/index protocol layer types.
//
// These sit UNDERNEATH the existing product types (`types/index.ts`'s Bag,
// BagPosition, CreatorProfile) rather than replacing them. `Bag` stays the
// UI-facing shape every existing component already renders; `BasketRecipe`
// is the on-chain-executable shape the protocol layer works with. Adapters
// in `lib/domain/basket-protocol/recipe.ts` convert between the two, so
// nothing in `components/bags`, `components/create`, or the mock data has
// to change to keep working.
// -----------------------------------------------------------------------------

// ----------------------------- Chains ----------------------------------------

// Mirrors the spirit of `Bag.chains: string[]` (types/index.ts) but as a
// closed union so recipe/registry code gets exhaustiveness checks. UI code
// can keep passing free-form strings through `Bag.chains`; only the
// protocol layer needs this narrower type.
// 'robinhood' = Robinhood Chain (EVM, chain id 4663 mainnet / 46630 testnet;
// Arbitrum Orbit L2, settles to Ethereum) — added to support importing
// Robinhood's tokenized Stock Tokens as canonical assets. See
// scripts/import-robinhood-assets.ts and
// docs.robinhood.com/chain/contracts for the registry this maps to.
export const SUPPORTED_CHAINS = ['ethereum', 'base', 'arbitrum', 'solana', 'robinhood'] as const;
export type ChainId = (typeof SUPPORTED_CHAINS)[number];

// ----------------------------- Asset metadata ---------------------------------

// Superset of `lib/create-assets-data.ts`'s `Asset`. Every field that exists
// there keeps the same name so `assetToAssetMetadata()` is a pure widen, not
// a remap. Fields needed for real on-chain execution (chain, address,
// decimals) and richer market data are added, all optional except the ones
// the protocol layer can't function without.
export interface AssetMetadata {
  id: string;
  symbol: string;
  name: string;
  type: 'crypto' | 'stock';

  // On-chain identity. Undefined until an asset has been mapped to a real
  // deployment on a given chain — see `isOnChainReady()`.
  chain?: ChainId;
  address?: string;
  decimals?: number;

  price?: number;
  priceChange24h?: number;

  marketCap?: number;
  volume24h?: number;
  liquidity?: number;

  logoURI?: string;
  /** Legacy emoji/glyph icon from the existing Asset model — kept for UI compatibility. */
  icon?: string;
}

/** True once an asset has enough on-chain identity to be used in a real BasketRecipe (not just a demo/paper one). */
export function isOnChainReady(asset: AssetMetadata): boolean {
  return Boolean(asset.chain && asset.address && typeof asset.decimals === 'number');
}

// ----------------------------- Asset identity (Phase 5) -------------------------

// Canonical identity for an asset. `symbol` is deliberately NOT part of
// this shape — many unrelated tokens share a symbol like "USDC" across
// chains (or across two different deployments on the same chain); only
// `chain + address` uniquely identifies an asset. See
// `lib/domain/basket-protocol/asset-identity.ts` for normalization/equality
// helpers built on this shape, and `NATIVE_ASSET_ADDRESS` there for how
// native assets (ETH, SOL, ...) fit into the same `(chain, address)` pair
// instead of needing a separate `isNative` flag wherever identity is
// checked.
export interface AssetIdentity {
  chain: ChainId;
  address: string;
}

export type AssetVerificationStatus = 'UNKNOWN' | 'VERIFIED' | 'DEPRECATED';

/**
 * Asset class — 'stock' for Robinhood Stock Tokens (robinhood-import.ts),
 * 'crypto' for native/ERC-20 cryptocurrencies (coingecko-import.ts). Purely
 * a UI/filtering distinction (see components/create/AssetSelector.tsx's
 * All/Crypto/Stocks tabs) — never used for identity (that's still
 * `chain + address`, per asset-identity.ts) or for any validation/pricing
 * decision.
 */
export type AssetType = 'crypto' | 'stock';

// The authoritative registry entry for an asset — what
// `lib/server/asset-repo.ts` persists (`assets` table in
// supabase/schema.sql, `unique(chain, address)`). A `RecipeAsset` (below)
// is what a creator's draft CLAIMS an asset is; a `CanonicalAsset` is what
// the protocol has independently confirmed it to be. Only a `VERIFIED`
// canonical asset should back a published/deployed recipe — see
// `validateRecipeAssetsAgainstRegistry()` in
// `lib/domain/basket-protocol/validation/registry-validation.ts`.
export interface CanonicalAsset {
  id: string;
  chain: ChainId;
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  status: AssetVerificationStatus;
  assetType: AssetType;
  /**
   * Corporate-action multiplier, decimal string, as of last import/update —
   * currently only meaningful for `chain: 'robinhood'` (Robinhood Stock
   * Tokens; see docs.robinhood.com/chain/building-with-stock-tokens and
   * ERC-8056's `uiMultiplier()`). `undefined` for assets that don't carry
   * one. Stored as-received (a decimal STRING, same "never a JS number for
   * money" convention as `AssetPrice.price` below) — this field is
   * display/reconciliation metadata only; it does not feed NAV math here
   * (Phase 15 stores it, a future phase decides how NAV consumes it).
   */
  currentMultiplier?: string;
  /** https URL of the token's logo, as the importer's source published it (0037_asset_logo_url.sql). */
  logoUrl?: string;
  /** Background liquidity check (0043_asset_route_status.sql): 'ROUTABLE' | 'NO_ROUTE'; undefined until first checked. Display only. */
  routeStatus?: 'ROUTABLE' | 'NO_ROUTE';
  routeCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------- Pricing (Phase 5) ---------------------------------

/**
 * A single price observation for an asset. `price` is a decimal STRING,
 * never a JS `number` — see
 * `lib/domain/basket-protocol/pricing/price-precision.ts` for why, and for
 * the helpers that turn this into either a scaled-bigint "protocol price"
 * (for Phase 6 NAV math) or a rounded "display price" (for UI). Those two
 * derived forms must never be the same code path — see that file's module
 * doc for the "Display price ≠ Protocol price" distinction (spec section 7).
 */
export interface AssetPrice {
  asset: AssetIdentity;
  price: string;
  quoteCurrency: string;
  timestamp: string;
  source: string;
  /** Optional 0–1 confidence score — not populated by `MockPriceProvider`; reserved for real providers (e.g. Chainlink deviation, Pyth confidence interval) added in a later phase. */
  confidence?: number;
}

// ----------------------------- NAV (Phase 6) --------------------------------

// An actual, currently-held quantity of an asset — NOT a `RecipeAsset`'s
// target weight. A recipe's `weightBps` says what a Bag SHOULD hold (target
// allocation, used for creation/rebalance); a holding says what it
// ACTUALLY holds right now. NAV is computed from holdings, never from
// weights — see `lib/domain/basket-protocol/nav/nav.ts`'s module doc for
// why conflating the two would produce a fabricated NAV.
//
// `quantityRaw` is the asset's raw on-chain base-unit quantity (e.g. wei
// for an 18-decimal token) as a decimal-integer string — the same
// "on-chain units, not human units" convention `RecipeAsset`/`CanonicalAsset`
// already use for `decimals`. `1.25 ETH` is `quantityRaw: "1250000000000000000"`,
// `decimals: 18` — never the human `"1.25"` written directly into this field.
export interface AssetHolding {
  asset: AssetIdentity;
  quantityRaw: string;
  decimals: number;
}

// One asset's contribution to a `NavResult` — the holding, the price used,
// and the resulting value, kept together so a NAV figure is always
// traceable back to exactly what was held and at what price it was priced.
export interface NavComponent {
  asset: AssetIdentity;
  quantityRaw: string;
  decimals: number;
  price: AssetPrice;
  /** This component's value in `NavResult.quoteCurrency`, as an exact decimal string — see nav.ts for how this avoids floats. */
  value: string;
}

export interface NavResult {
  /** ISO timestamp — matches `AssetPrice.timestamp`/`BagVersion.createdAt`'s convention elsewhere in this codebase, not a raw epoch number. */
  asOf: string;
  quoteCurrency: string;
  components: NavComponent[];
  grossNav: string;
  /** Equal to `grossNav` in Phase 6 — no fee logic yet (spec section 13). A separate field already exists so a later fee-deduction phase can populate it without changing this shape. */
  netNav: string;
}

// ----------------------------- Bag holdings (Phase 7) --------------------------

// A Bag's ACTUAL underlying holding of one asset, persisted (`bag_holdings`
// table, supabase/schema.sql) and tied to a specific Bag. Deliberately a
// separate type from `AssetHolding` (above), not a duplicate of it:
// `AssetHolding` is the NAV Engine's pure calculation primitive (no
// `bagId`, no persistence timestamp — just enough to price and sum);
// `BagHolding` is what `lib/server/bag-holdings-repo.ts` actually stores
// and reads. `lib/domain/basket-protocol/bag-holdings.ts`'s
// `bagHoldingToAssetHolding()` is the one, pure conversion between the two
// — nowhere else should need to reshape one into the other by hand.
//
// Also NOT the same domain as `types/domain.ts`'s paper-trading
// `Position`/`Portfolio` — those represent a USER's simulated personal
// holdings; `BagHolding` represents what a BAG ITSELF (the basket
// instance) holds. Separate tables, separate concepts, untouched by this.
export interface BagHolding {
  bagId: string;
  asset: AssetIdentity;
  quantityRaw: string;
  decimals: number;
  updatedAt: string;
}

// One line of a BasketRecipe. Deliberately does NOT reuse `BagPosition`
// (`{ symbol, weight }`) — that type is fine for UI display but has no way
// to express "which contract, on which chain, at what decimals", which is
// required for real execution.
export interface RecipeAsset {
  chain: ChainId;
  address: string;
  symbol: string;
  decimals: number;
  /** Target weight in basis points (10000 = 100%) — integers avoid float drift across many assets. */
  weightBps: number;
}

// ----------------------------- Rebalance rule -----------------------------------

export type RebalanceFrequency = 'MANUAL' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'THRESHOLD_ONLY';

export interface RebalanceRule {
  frequency: RebalanceFrequency;
  /** Drift (in bps of target weight) an asset must exceed before a rebalance is triggered. See section 15. */
  driftThresholdBps: number;
  /** Max acceptable slippage per rebalance trade, in bps. */
  maxSlippageBps: number;
}

export const DEFAULT_REBALANCE_RULE: RebalanceRule = {
  frequency: 'THRESHOLD_ONLY',
  driftThresholdBps: 500, // 5%
  maxSlippageBps: 100, // 1%
};

// ----------------------------- Basket recipe -----------------------------------

export type BagMutability = 'IMMUTABLE' | 'MUTABLE';

// ----------------------------- Strategy type (Phase 11) -------------------------
//
// What KIND of strategy a recipe represents. Product-metadata only — this
// says nothing about NAV/shares/rebalance mechanics, which are identical
// today regardless of strategy type. `STATIC_BASKET` (fixed target weights,
// rebalanced back to those weights) is the only strategy this product
// supports right now.
//
// Deliberately NOT a plain `string`: a closed union is what lets
// `isStrategyType()` / the validator reject anything else today, while
// still being the one place a future strategy type gets added — extend
// `STRATEGY_TYPES` below and every switch/validator that narrows on it
// will surface as a type error until handled. Do not add DYNAMIC_BASKET,
// INDEX, AI_STRATEGY, etc. until a later phase actually implements them.
export const STRATEGY_TYPES = ['STATIC_BASKET'] as const;
export type StrategyType = (typeof STRATEGY_TYPES)[number];

export function isStrategyType(value: unknown): value is StrategyType {
  return typeof value === 'string' && (STRATEGY_TYPES as readonly string[]).includes(value);
}

export const DEFAULT_STRATEGY_TYPE: StrategyType = 'STATIC_BASKET';

// ----------------------------- Performance fee (Phase 22) -----------------
//
// The design questions Phase 11's note above left open are now answered,
// specific to this protocol's NO-POOLED-CUSTODY architecture
// (lib/blockchain/lifi-purchase-quote.ts — every swap settles straight to
// the depositor's own wallet, so there is no vault a fee could be skimmed
// from at settlement time):
//   - High Water Mark      — NOT a separate tracked value. Instead,
//     `bag_investor_positions.cost_basis_quote` is reduced PROPORTIONALLY
//     to shares burned on every redemption (supabase/migrations/
//     0012_add_redeem_execution.sql's apply_redeem_execution()). Profit is
//     computed per-redemption as (that redemption's value minus the cost
//     basis it consumed), so a loss is never taxed and a gain already
//     realized (and fee'd) can never be taxed again when the remaining
//     position merely recovers — the classic HWM failure mode a per-lot,
//     proportional-cost-basis model sidesteps without needing its own
//     column.
//   - Performance Baseline — this depositor's OWN cost basis, never a
//     benchmark and never another depositor's basis.
//   - Fee Crystallization  — at redemption, never continuously. An
//     unrealized (paper) gain is never fee'd; only value the depositor
//     actually redeemed is.
//   - Fee Recipient        — THIS bag's own creator (`bags.creator_id`),
//     not the protocol and not a fork's root creator (see
//     `FORK_ROYALTY_BPS`, lib/config/rewards.ts, for the separate,
//     deposit-time reward a fork's ROOT creator earns instead).
//   - Fee Asset            — quote-currency value, credited to the
//     creator's `portfolios.cash_balance` (the same paper-portfolio ledger
//     `commit_investment_transaction()` already settles trades into) —
//     NOT an on-chain transfer. With no pooled custody, a same-transaction
//     on-chain fee-split would require adding a whole new signed swap leg
//     to every redemption — real, but substantially more engineering than
//     this phase's scope. Recorded as a real, auditable ledger credit
//     (an `activities` row + a real balance update) now; paying it out
//     on-chain is a deliberate follow-up, not pretended to already work.
//   - Fee Accounting       — computed entirely from THIS depositor's own
//     `bag_investor_positions` row at redemption time; never touches
//     `bag_share_state`/NAV-per-share, so no other depositor's holdings or
//     redemption value are ever affected by one depositor's fee.

/** Cap enforced by validateEconomics() (validation/validators.ts) — no recipe may charge more than 30%. */
export const MAX_PERFORMANCE_FEE_BPS = 3000;

// ----------------------------- Unroutable-asset policy --------------------------
//
// What a purchase does when some of a Bag's assets have no swap route right
// now (no liquidity — e.g. a Stock Token no market maker is quoting):
//
//   BLOCK      — the purchase is refused until every asset is routable.
//   HOLD_INPUT — the unroutable assets' share is kept in the payment token
//                (USDG) as part of the position; shares are minted for the
//                full deposit, since the kept stablecoin counts in NAV.
//   REFUND     — the unroutable assets' share is never spent: the buyer pays
//                only for the routable assets and gets shares for that.
//
// Either partial mode is capped at `MAX_UNROUTABLE_WEIGHT_BPS` of the recipe,
// so a Bag can't silently turn into mostly-cash or mostly-refund.
export const UNROUTABLE_POLICIES = ['BLOCK', 'HOLD_INPUT', 'REFUND'] as const;
export type UnroutablePolicy = (typeof UNROUTABLE_POLICIES)[number];
export const DEFAULT_UNROUTABLE_POLICY: UnroutablePolicy = 'BLOCK';
export const MAX_UNROUTABLE_WEIGHT_BPS = 3000;

export interface BasketRecipe {
  id: string;
  /** The Bag this recipe belongs to — foreign key back into the existing `Bag.id`. */
  bagId: string;
  name: string;
  symbol: string;
  description: string;
  chain: ChainId;
  /** What kind of strategy this is. Only `STATIC_BASKET` exists today — see `STRATEGY_TYPES`. */
  strategyType: StrategyType;
  assets: RecipeAsset[];
  rebalanceRule: RebalanceRule;
  minInvestment: number;
  maxAssets: number;
  minWeightBps: number;
  maxWeightBps: number;
  mutability: BagMutability;
  /** Basis points of REALIZED profit (this depositor's own redemption gain — see doc block above) paid to this bag's creator. 0 if unset — a recipe with no fee is valid, not an error. Capped at `MAX_PERFORMANCE_FEE_BPS`. */
  performanceFeeBps?: number;
  /** What a purchase does when some assets have no swap route — chosen by the creator. Unset means `DEFAULT_UNROUTABLE_POLICY`. See `UNROUTABLE_POLICIES`. */
  unroutablePolicy?: UnroutablePolicy;
  version: number;
  createdAt: string;
}

// ----------------------------- Drift & rebalance plan (Phase 8) -----------------

// One asset's target vs. actual weight, in the SAME bps unit `RecipeAsset.
// weightBps`/`RebalanceRule.driftThresholdBps` already use. `targetWeightBps`
// comes from `BasketRecipe.assets[].weightBps` — NEVER from holdings — and
// `currentWeightBps` comes from `NavResult` — NEVER from the recipe. This
// mirrors the `RecipeAsset` vs `BagHolding` separation above: a recipe
// weight and a holding weight are different numbers that happen to share a
// unit, not the same number under two names. An asset the recipe doesn't
// mention but the Bag currently holds ("unexpected holding" — see
// `calculateRebalancePlan()` in `lib/domain/basket-protocol/rebalance/
// rebalance.ts`) still gets an `Allocation`, with `targetWeightBps: 0`.
export interface Allocation {
  asset: AssetIdentity;
  /** Best available label — the recipe's declared symbol for a known asset, or the raw address for an unexpected holding the recipe never claimed (see asset-identity.ts: identity is chain+address, never symbol). */
  symbol: string;
  targetWeightBps: number;
  currentWeightBps: number;
  /** `currentWeightBps - targetWeightBps`. Positive = overweight (a SELL candidate); negative = underweight (a BUY candidate). */
  driftBps: number;
}

export type OrderSide = 'BUY' | 'SELL';

// One proposed (never executed — spec section 13) trade to move an asset
// from its current value toward its target value. `value` is always an
// unsigned magnitude; direction is `side`, not the sign of `value`.
export interface RebalanceOrder {
  asset: AssetIdentity;
  symbol: string;
  side: OrderSide;
  /** Unsigned trade size in `RebalancePlan`'s quote currency, as an exact decimal string at NAV precision (see `nav.ts`'s `formatNavValue`). */
  value: string;
  /**
   * Raw base-unit quantity to trade, at `decimals` precision — `null` when
   * no price is available to convert `value` into a quantity. This pure
   * planner never calls a `PriceProvider` itself (NAV already carries the
   * prices it needs — spec section 11); the one case with no price on hand
   * is a target asset that has never been held, so it has no
   * `NavComponent` and therefore no price to divide by.
   */
  quantityRaw: string | null;
  decimals: number;
}

export interface RebalancePlan {
  /** Copied from the `NavResult` this plan was computed against. */
  asOf: string;
  quoteCurrency: string;
  /** The `NavResult.grossNav` this plan was computed against, unchanged — not re-derived. */
  nav: string;
  allocations: Allocation[];
  orders: RebalanceOrder[];
  /** True iff at least one asset's `|driftBps|` exceeds `RebalanceRule.driftThresholdBps` — a single GLOBAL trigger (the rule has one threshold, not one per asset), not an average or a per-asset flag. */
  requiresRebalance: boolean;
}

// ----------------------------- Share accounting (Phase 9) -----------------------

// A Bag's outstanding share count — the ERC-4626-shaped "total supply" this
// protocol will eventually mint/burn against (Phase 10+; NOT this phase —
// see `lib/domain/basket-protocol/shares/shares.ts`'s module doc). Same
// raw-unit convention as `BagHolding.quantityRaw`/`AssetHolding.
// quantityRaw`: `totalSharesRaw` is an exact base-unit integer STRING (e.g.
// "1000000000000000000000" for 1000 shares at `shareDecimals: 18`), never
// a human "1000" written directly into this field, and never a JS
// `number` anywhere on the path that produces or consumes it.
export interface ShareSupply {
  bagId: string;
  totalSharesRaw: string;
  shareDecimals: number;
  updatedAt: string;
}

// NAV-per-share at a point in time — the thin, traceable wrapper this
// phase puts around `calculateNavPerShare()`'s (nav.ts, Phase 6) return
// value, the same way `NavResult` wraps a NAV figure with the `asOf`/
// `quoteCurrency` it was computed under. `value` is that function's exact
// decimal-string result, unmodified — this type adds provenance, not new
// math. Deliberately does NOT exist for a zero-supply Bag: `getSharePrice()`
// throws `ZeroShareSupplyError` there (nav.ts's existing behavior,
// unchanged by this phase) rather than returning a `SharePrice` with a
// fabricated value — see `ShareBootstrapPolicy` below for how a Bag's
// FIRST deposit is priced instead.
export interface SharePrice {
  asOf: string;
  quoteCurrency: string;
  /** Exact decimal string at NAV_VALUE_DECIMALS precision — `calculateNavPerShare()`'s own output format, never re-rounded here. */
  value: string;
}

// Deterministic policy for pricing a Bag's very FIRST deposit, when
// `totalSharesRaw` is still `"0"` and `calculateNavPerShare()` has no
// share supply to divide by (spec section 7/8 — this is NOT a fallback
// baked silently into the math; it is an explicit, named, swappable
// config, e.g. different bags could bootstrap at different prices without
// touching any engine code). `initialSharePrice` follows the same
// plain-decimal-string convention `AssetPrice.price` uses — never scaled,
// never a JS `number`.
export interface ShareBootstrapPolicy {
  /** NAV-per-share to use for a Bag's first deposit, before any shares exist to compute a real one from. E.g. `"1"` = "1 share costs $1". */
  initialSharePrice: string;
}

/** The obvious, boring default: 1 share = 1 unit of quote currency at bootstrap. A Bag can be given a different `ShareBootstrapPolicy` explicitly; this is never hardcoded into the engine itself. */
export const DEFAULT_SHARE_BOOTSTRAP_POLICY: ShareBootstrapPolicy = {
  initialSharePrice: '1',
};

// A pure quote for "if this quote currency amount were deposited right
// now, how many shares would it mint" — MATH ONLY (spec section 12/13):
// computing one of these never mutates `ShareSupply`, `NavResult`, or
// anything else, and no share is actually minted. See `getDepositQuote()`
// (shares.ts) for the bootstrap-vs-normal pricing branch this type is
// agnostic to; `isBootstrap` just tells the caller which one produced it.
export interface DepositQuote {
  asOf: string;
  quoteCurrency: string;
  /** The human decimal-string amount quoted, in `quoteCurrency` — same plain-decimal convention as `AssetPrice.price` (never scaled, never raw units: this phase does no on-chain settlement of the quote currency itself — spec section 12/17). */
  depositAmount: string;
  /** The NAV-per-share this quote was priced at — either `SharePrice.value` or, at zero supply, `ShareBootstrapPolicy.initialSharePrice`. */
  sharePrice: string;
  /** Shares this deposit would mint, as an exact raw-unit integer string at `shareDecimals` precision — truncated, never rounded (spec section 10). */
  sharesRaw: string;
  shareDecimals: number;
  /** True iff this quote was priced via `ShareBootstrapPolicy` because share supply was zero, rather than via `calculateNavPerShare()`. */
  isBootstrap: boolean;
}

// A pure quote for "if this many shares were redeemed right now, what
// quote-currency value would that be" — same MATH-ONLY guarantee as
// `DepositQuote`: no share is burned, no holdings move. `grossValue` is
// named `gross` (not just `value`) so a later fee-deduction phase can add
// a `netValue` alongside it without renaming this field or breaking
// anything already reading it (same forward-compatible naming
// `NavResult.grossNav`/`netNav` already established in Phase 6 — spec
// section 9: no fee logic yet, but the shape should not need to change
// when there is).
export interface RedeemQuote {
  asOf: string;
  quoteCurrency: string;
  sharesRaw: string;
  shareDecimals: number;
  /** The NAV-per-share this quote was priced at. */
  sharePrice: string;
  /** Exact decimal string, `quoteCurrency` units — `sharesRaw` (in human units) × `sharePrice`, before any future fee deduction. */
  grossValue: string;
}

// ----------------------------- Bag versioning -----------------------------------

// Extends the existing `UpdateLog` (`types/index.ts`: `{ date, change, reason }`,
// currently free-text) into something a registry/on-chain history can key
// off of. `UpdateLog` itself is untouched — a `BagVersion` is what gets
// written *alongside* an UpdateLog entry going forward. Pure/in-memory only
// — see `BagVersionRecord` below for the persisted (Supabase) counterpart,
// which stores the full `BasketRecipe` rather than just `composition`.
export interface BagVersion {
  bagId: string;
  version: number;
  parentVersion: number | null;
  composition: RecipeAsset[];
  compositionHash: string;
  reason: string;
  createdAt: string;
}

// ----------------------------- Deposit / Allocation / Execution Plan (Phase 10) --

// One-click multi-asset BAG purchase — the layers a single deposit flows
// through, in order:
//
//   DepositRequest              (what the user typed: one input asset,
//                                one raw amount)
//     ↓ calculateDepositAllocation()  [lib/domain/basket-protocol/deposit/allocation.ts]
//   DepositPlan                 (target VALUE per recipe asset, in the
//                                input asset's own raw units — a pure
//                                split, no swap quantities yet)
//     ↓ buildExecutionPlan()    [lib/domain/basket-protocol/deposit/execution-plan.ts]
//   ExecutionPlan                (one ExecutionRouteRequest per non-zero,
//                                non-KEEP allocation — still no quote, no
//                                swap quantity, no chain call)
//     ↓ ExecutionAdapter.quoteExecutionPlan()  [lib/blockchain/execution-adapter.ts]
//   ExecutionResult              (adapter-produced quote per step — the
//                                first point a route/DEX/aggregator like
//                                LI.FI ever enters the picture, and, in
//                                this phase, still only a MOCK adapter —
//                                see mock-execution-adapter.ts)
//
// Every type below only ever describes a PLAN. Nothing in this section
// represents money that has moved, a transaction that was sent, or a
// wallet that signed anything — see this phase's module docs in
// lib/domain/basket-protocol/deposit/ for the explicit "no real execution
// yet" boundary.

/**
 * What the user actually submitted: one input asset, one raw amount, for
 * one Bag. Deliberately does NOT carry `inputAsset`'s `decimals` — the
 * allocation split below works entirely in the input asset's own raw
 * units (an integer bigint split), so nothing about its decimal precision
 * needs to be known to divide it correctly. Same raw-unit convention as
 * `AssetHolding.quantityRaw`/`BagHolding.quantityRaw`: `amountRaw` is a
 * non-negative base-10 integer string (e.g. `"100000000"` for 100 USDC at
 * 6 decimals) — NEVER the human `"100"` written directly into this field.
 */
export interface DepositRequest {
  bagId: string;
  inputAsset: AssetIdentity;
  amountRaw: string;
}

/**
 * One recipe asset's slice of a deposit. `valueRaw` is a VALUE, expressed
 * in the INPUT asset's raw units — e.g. "the input-asset-equivalent of
 * 40% of this deposit", not a quantity of `targetAsset` (see
 * `lib/domain/basket-protocol/deposit/allocation.ts`'s module doc, "Price
 * vs Route" — spec section 14, the same distinction `RebalanceOrder.value`
 * vs `RebalanceOrder.quantityRaw` already draws in Phase 8. Converting
 * this into an actual `targetAsset` quantity is `ExecutionAdapter`'s job,
 * not this layer's.
 *
 * `action` is `'KEEP'` iff `targetAsset` IS (by `assetIdentitiesEqual()`)
 * the deposit's `inputAsset` — that slice is never swapped (spec section
 * 5).
 */
export interface DepositAllocation {
  targetAsset: AssetIdentity;
  /** Display-only — mirrors `Allocation.symbol`/`RebalanceOrder.symbol`'s convention of carrying a label alongside a symbol-less `AssetIdentity`. */
  targetSymbol: string;
  targetDecimals: number;
  targetWeightBps: number;
  valueRaw: string;
  action: 'KEEP' | 'SWAP';
}

/**
 * Output of `calculateDepositAllocation()` — one `DepositAllocation` per
 * recipe asset (including 0%-weight ones, for transparency — mirrors
 * `RebalancePlan.allocations`'s "every recipe asset gets a line" Phase 8
 * convention), plus the bookkeeping fields that prove nothing was lost.
 *
 * `unallocatedRaw` is the residual left over after distributing
 * `inputAmountRaw` across `allocations` — deterministically attributed
 * back to the input asset (spec section 16), never dropped. Because the
 * distribution algorithm is exact largest-remainder (see
 * `distributeExactByWeight()`), this is mathematically `"0"` whenever
 * `totalAllocatedRaw === inputAmountRaw` — which, for a recipe whose
 * weights sum to exactly 100%, is always. The field still exists (rather
 * than being hardcoded away) because it's the named, documented residual
 * policy spec section 16 asks for, and because it is what a caller should
 * assert against, not assume.
 */
export interface DepositPlan {
  bagId: string;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  allocations: DepositAllocation[];
  totalAllocatedRaw: string;
  unallocatedRaw: string;
}

/**
 * Generic execution-route request — the seam between this protocol's own
 * allocation math and ANY router/aggregator (LI.FI today; "Robinhood
 * Chain"/"ATLAS" mentioned as future options — spec section 7). Nothing
 * that produces or consumes this type knows or cares which router will
 * eventually service it.
 */
export interface ExecutionRouteRequest {
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  outputAsset: AssetIdentity;
  /** Same value as the originating `DepositAllocation.valueRaw` — restated here so a route request is self-contained and doesn't require its caller to also hold the `DepositPlan` it came from. */
  targetValueRaw: string;
  sourceChain: ChainId;
  destinationChain: ChainId;
  /** Reserved for a future phase's real slippage enforcement (spec section 12) — present on the shape now so it doesn't need to be added later, but never enforced by this phase. */
  slippageBps?: number;
}

/** One step of an `ExecutionPlan` — a route request plus the allocation context (`action`, target label) an adapter or UI needs to render/execute it. */
export interface ExecutionStep {
  route: ExecutionRouteRequest;
  action: 'KEEP' | 'SWAP';
  targetSymbol: string;
}

/**
 * Output of `buildExecutionPlan()` — the router-agnostic execution layer
 * spec section 7 asks for, sitting between `DepositPlan` and whatever
 * `ExecutionAdapter` eventually services it (`lib/blockchain/
 * execution-adapter.ts`). `steps` omits every `KEEP`/zero-value allocation
 * that needs no route (spec section 17's "Zero weight" test) — a
 * `DepositAllocation` with `valueRaw: "0"` still appears in
 * `DepositPlan.allocations` for transparency, but never produces a step
 * here, since there is nothing to route.
 *
 * Still no quote, no swap quantity, no chain call — see this file's
 * module doc.
 */
export interface ExecutionPlan {
  bagId: string;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  steps: ExecutionStep[];
  unallocatedRaw: string;
}

// ----------------------------- Bag registry (Phase 3) ---------------------------

export type BagStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

// The canonical, Supabase-backed identity for a Bag (`bags` table in
// supabase/schema.sql, via lib/server/bag-repo.ts). Deliberately a SEPARATE
// type from the existing `Bag` in `types/index.ts` — that type is the
// UI-facing shape every existing component (BagCard, DiversificationScore,
// PerformanceTimeline) already renders from mock data. Nothing requires the
// two to merge; `buildRecipeFromBag()` (Phase 1) is the bridge when needed.
export interface BagRecord {
  id: string;
  slug: string;
  name: string;
  symbol: string;
  description: string;
  creatorId: string;
  chain: ChainId;
  /**
   * Denormalized copy of the current version's `recipe.strategyType`
   * (Phase 11) — lives on `bags` (not just inside the `bag_versions.recipe`
   * JSONB) specifically so Explore/Profile can filter/badge by strategy
   * type without joining out to the current version. Set once at creation;
   * not re-derived per version, since only one strategy type exists today
   * and nothing in this phase changes it after creation.
   */
  strategyType: StrategyType;
  mutability: BagMutability;
  status: BagStatus;
  currentVersion: number;
  currentVersionId: string | null;
  parentBagId: string | null;
  rootBagId: string | null;
  /** Nullable — no chain integration exists yet (lib/blockchain/adapter.ts is still a mock). Populated once a Bag is deployed (Phase 4+). */
  registryId: string | null;
  contractAddress: string | null;
  /**
   * Performance-fee lock (migration 0033). Both `null` until the first EXTERNAL
   * (non-creator) investor holds shares; from then on the fee is immutable at
   * `performanceFeeBpsLocked` — enforced by the database, not just here.
   */
  performanceFeeLockedAt?: string | null;
  performanceFeeBpsLocked?: number | null;
  createdAt: string;
  updatedAt: string;
}

// Persisted counterpart to `BagVersion` — stores the FULL `BasketRecipe`
// (not just `composition`) as canonical JSONB. See `lib/server/bag-repo.ts`
// for why a separate `bag_assets` normalization table was not introduced
// alongside this.
export interface BagVersionRecord {
  id: string;
  bagId: string;
  version: number;
  compositionHash: string;
  recipe: BasketRecipe;
  createdBy: string;
  reason: string;
  createdAt: string;
}

// ----------------------------- Validation result -----------------------------------

// Shared shape for the validation engine (frontend/backend/contract layers
// all report through this — see `lib/domain/basket-protocol/validation`).
export type ValidationSeverity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  /** Dot-path into the recipe this issue is about, e.g. `assets[2].address` or `rebalanceRule.driftThresholdBps`. */
  path?: string;
}

export interface ValidationResult {
  /** True iff there are zero ERROR-severity issues. WARNINGs alone never flip this to false. */
  valid: boolean;
  issues: ValidationIssue[];
}
