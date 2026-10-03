// -----------------------------------------------------------------------------
// Robinhood Chain — single, authoritative production chain configuration.
//
// VERIFICATION NOTE (do not remove): every value below was cross-checked
// against Robinhood's own documentation (docs.robinhood.com/chain/contracts,
// docs.robinhood.com/chain/protocol-contracts) at the time this file was
// written, plus independent third-party confirmation for the reward-token
// decimals (Robinhood's own docs page does not print decimals; four
// unrelated third-party integration docs — none of which cite each other —
// independently agree on 6). If Robinhood ever changes any of these
// addresses, this is the ONLY file that needs to change; nothing else in
// the codebase should hardcode a chain id, token address, or RPC URL.
//
// VERIFIED (this session): Uniswap's own official deployments page,
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
// — a first-party Uniswap Labs source, purpose-built for Robinhood Chain,
// explicitly naming chainId 4663, using the same template Uniswap
// publishes for every other chain (Arbitrum, Base, etc.), and internally
// consistent with Robinhood's own Permit2 listing (identical canonical
// address). This resolves the router-address blocker every prior pass
// left open — do not revert to `null` without a real reason.
// -----------------------------------------------------------------------------

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_ID_TESTNET = 46630;

/** The public, documented Robinhood Chain RPC. */
export const ROBINHOOD_PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
/**
 * The RPC every server-side Robinhood read uses (deploy/version verification,
 * TWAP pricing, quoter, router/vault clients): `ROBINHOOD_RPC_URL` (the name
 * .env.example and lib/blockchain/rpc/endpoints.ts use), or the legacy
 * `RPC_URL_ROBINHOOD`, when set; otherwise the public one. Server-only env var —
 * in a client bundle it is undefined, so the browser falls back to the public RPC.
 */
export const ROBINHOOD_RPC_URL =
  process.env.ROBINHOOD_RPC_URL || process.env.RPC_URL_ROBINHOOD || ROBINHOOD_PUBLIC_RPC_URL;
export const ROBINHOOD_EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export const ROBINHOOD_NATIVE_CURRENCY = {
  symbol: 'ETH',
  decimals: 18,
} as const;

/**
 * The single settlement/reward token for the entire protocol. Verified as
 * "Global Dollar" (USDG) on Robinhood Chain's own Token Contracts page —
 * this is what the canonical Arbitrum bridge route delivers when a user
 * bridges USDC in (it arrives as USDG, not USDC — see bridging docs).
 * Decimals: 6 (third-party-confirmed; NOT the 18 decimals other Paxos
 * tokens like USDP/PAXG use — do not assume decimals from the issuer
 * family, always check the specific token).
 */
export const ROBINHOOD_REWARD_TOKEN = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  decimals: 6,
  name: 'Global Dollar',
} as const;

export const ROBINHOOD_WETH_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

/** Canonical Permit2 — same address on every chain that has it deployed, confirmed present on Robinhood Chain by Robinhood's own protocol-contracts page. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * VERIFIED — Uniswap v3 SwapRouter02 on Robinhood Chain, per
 * developers.uniswap.org's Robinhood Chain Deployments page (see file
 * header). This is the swap-execution target `RedeemFeeRouter` legs
 * allowlist and the deterministic swap builder
 * (`lib/blockchain/robinhood-swap-builder.ts`) encode calldata for.
 * SwapRouter02 (not UniversalRouter) was chosen deliberately: it exposes
 * plain, single-purpose functions (`exactInputSingle`) with a normal ABI
 * viem can encode directly, versus UniversalRouter's opaque
 * command-byte-array encoding — simpler to build correct, auditable
 * calldata for, at the cost of not supporting UniversalRouter-only
 * features (fee-on-transfer support, native ETH legs) this protocol
 * doesn't need for a Bag redemption (all Bag holdings are ERC-20s).
 */
export const UNISWAP_ROUTER_ADDRESS: `0x${string}` | null = '0xcAF681a66D020601342297493863E78c959e5cB2';

/** VERIFIED — Uniswap v3 UniversalRouter on Robinhood Chain, same source as above. Not used by `robinhood-swap-builder.ts` today (see UNISWAP_ROUTER_ADDRESS's doc) — kept here, verified, for any future caller that needs it rather than leaving it undocumented. */
export const UNISWAP_UNIVERSAL_ROUTER_ADDRESS: `0x${string}` = '0x8876789976DECbFCBBbE364623c63652DB8c0904';

/** VERIFIED — Uniswap v3 Factory on Robinhood Chain, same source as above. Needed to resolve a pool address (`getPool(tokenA, tokenB, fee)`) before building `exactInputSingle` calldata. */
export const UNISWAP_V3_FACTORY_ADDRESS: `0x${string}` = '0x1F7d7550b1B028F7571E69A784071F0205fD2eFa';

/** VERIFIED — Uniswap v3 QuoterV2 on Robinhood Chain, same source as above. Off-chain (staticcall/simulate) quoting, never itself part of an executed redemption transaction. */
export const UNISWAP_QUOTER_V2_ADDRESS: `0x${string}` = '0x33E885Ed0Ec9Bf04ecfB19341582AadCb4c8a9e7';

/**
 * Deployed protocol contract addresses, read from env at call time (never
 * cached at module-load time — Next.js can load this module before env
 * vars are injected in some deployment setups, and re-reading is free).
 * `null` until `CREATOR_REWARDS_VAULT_ADDRESS`/`REDEEM_FEE_ROUTER_ADDRESS`
 * are set post-deployment (see scripts/deploy-creator-rewards.ts) — every
 * call site that needs one of these MUST handle `null` by failing closed,
 * never by falling back to a guessed/placeholder address.
 */
export const DEPLOYED_CONTRACTS = {
  get creatorRewardsVault(): `0x${string}` | null {
    return (process.env.CREATOR_REWARDS_VAULT_ADDRESS as `0x${string}` | undefined) || null;
  },
  get redeemFeeRouter(): `0x${string}` | null {
    return (process.env.REDEEM_FEE_ROUTER_ADDRESS as `0x${string}` | undefined) || null;
  },
  /**
   * Phase 19.X-1/2 — `contracts/BagExecutionRouter.sol`'s deployed address.
   * `null` (never a guessed/placeholder address) until
   * `BAG_EXECUTION_ROUTER_ADDRESS` is set post-deployment. See
   * `lib/server/purchase-execution.ts`'s "no key, never attempted" rule:
   * `null` here means `BagRouterProvider` is simply never registered, the
   * same as an unset `LIFI_API_KEY` means Composer is never registered.
   */
  get bagExecutionRouter(): `0x${string}` | null {
    return (process.env.BAG_EXECUTION_ROUTER_ADDRESS as `0x${string}` | undefined) || null;
  },
} as const;

/**
 * The `BagExecutionRouter.planSigner` private key. Read at call time only
 * (same convention as every other env getter in this file) and NEVER
 * cached/exported as a top-level constant, so it never ends up captured in
 * a client bundle by accident. `null` (never a fallback/dev key) when
 * unset — see `lib/blockchain/bag-execution-router-signer.ts`'s
 * `MissingPlanSignerKeyError`.
 */
export function getBagRouterPlanSignerKey(): `0x${string}` | null {
  return (process.env.BAG_ROUTER_PLAN_SIGNER_KEY as `0x${string}` | undefined) || null;
}

/**
 * Converts a decimal quote-currency string (e.g. what
 * lib/server/creator-rewards-repo.ts already parses out of `activities.action`,
 * or what apply_redeem_execution()/apply_purchase_execution() compute as
 * v_fee_amount / v_royalty_amount) into raw USDG base units, as a bigint.
 *
 * Never do this with `Number(...)` — see the module doc in
 * lib/domain/basket-protocol/pricing/price-precision.ts for why float
 * arithmetic is banned for money in this codebase; this is the same rule
 * applied at the reward-settlement boundary.
 */
export function quoteDecimalToRewardTokenRaw(quoteAmount: string): bigint {
  const trimmed = quoteAmount.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split('.');
  if (parts.length > 2) {
    throw new Error(`quoteDecimalToRewardTokenRaw: not a valid decimal amount: ${JSON.stringify(quoteAmount)}`);
  }
  const [wholePart, fracPartRaw = ''] = parts;
  if (!/^\d+$/.test(wholePart) || (fracPartRaw !== '' && !/^\d+$/.test(fracPartRaw))) {
    throw new Error(`quoteDecimalToRewardTokenRaw: not a valid decimal amount: ${JSON.stringify(quoteAmount)}`);
  }
  const decimals = ROBINHOOD_REWARD_TOKEN.decimals;
  // Truncate (never round up) any fractional precision beyond the token's
  // decimals — rounding policy explicitly required by the spec (section 14):
  // floor, so the vault is never asked to pay out more raw units than the
  // quote amount actually justifies.
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, '0');
  const raw = BigInt(wholePart + fracPart || '0');
  return negative ? -raw : raw;
}

/**
 * Fails closed if the connected chain is not Robinhood Chain mainnet.
 * Call this immediately before any production settlement transaction
 * (settlement worker, deploy scripts) — section 49's "production guards":
 * never send a real settlement/deployment transaction to the wrong chain.
 */
export function assertRobinhoodChainMainnetLike(chainId: number): void {
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `Refusing to proceed: expected Robinhood Chain mainnet (chainId ${ROBINHOOD_CHAIN_ID}), got ${chainId}.`
    );
  }
}

/** Inverse of quoteDecimalToRewardTokenRaw, for display only — never for further arithmetic. */
export function rewardTokenRawToQuoteDecimal(raw: bigint): string {
  const decimals = ROBINHOOD_REWARD_TOKEN.decimals;
  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  const trimmedFrac = frac.replace(/0+$/, '');
  const result = trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
  return negative ? `-${result}` : result;
}
