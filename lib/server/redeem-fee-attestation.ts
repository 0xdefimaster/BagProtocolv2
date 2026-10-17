import { SupabaseClient } from '@supabase/supabase-js';
import { privateKeyToAccount } from 'viem/accounts';
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { computeB0Fee, decimalToRawCeil, feeBasisFromPositionPnl } from '@/lib/domain/basket-protocol/redeem/performance-fee-b0';
import { FEE_REDEEM_MAX_PRICE_DEVIATION_BPS, referenceValueRaw, selectRedeemLegQuote, type TierQuote } from '@/lib/domain/basket-protocol/redeem/redeem-quote-quality';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { getPriceProvider } from '@/lib/server/price-provider';
import { computePositionPnl } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, DEPLOYED_CONTRACTS } from '@/lib/config/robinhood-chain';
import { feeRedemptionPath } from '@/lib/server/fee-redemption-path';
import { buildRobinhoodSwapLeg, COMMON_FEE_TIERS } from '@/lib/blockchain/robinhood-swap-builder';
import { createRobinhoodUniswapQuoter } from '@/lib/blockchain/robinhood-uniswap-quoter';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';
import {
  FEE_ATTESTATION_TYPES,
  REDEEM_FEE_ROUTER_EIP712_DOMAIN_NAME,
  REDEEM_FEE_ROUTER_EIP712_DOMAIN_VERSION,
  computeLegsHash,
} from '@/lib/blockchain/redeem-fee-router-eip712';
import { getRedeemIntentForUser, updateRedeemIntentStatus } from '@/lib/server/redeem-intent-repo';
import { checkSaleCoverage } from '@/lib/server/sale-coverage';
import { listAllLedgerEventsForPosition } from '@/lib/server/ledger-repo';
import { purchaseInFlightFor } from '@/lib/server/fee-redemption-lock';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';

// -----------------------------------------------------------------------------
// V11 — real, multi-asset EIP-712 fee-attestation signing service for
// RedeemFeeRouter.sol. Every value bound into the signature is loaded from
// an authoritative server-side source — none of it is ever accepted from
// the request body. See RedeemFeeRouter.sol's own module doc for why this
// is what makes the router trustworthy: it never lets the frontend choose
// feeAmount/creator/inputToken(s) unilaterally, only submit (or withhold)
// an attestation the backend already committed to.
//
// SUPERSEDES the prior single-asset-only version of this file, which
// failed closed with `MultiAssetRedemptionNotSupportedError` for any
// redemption spanning more than one asset — the common case for a
// multi-asset Bag. That restriction is now GONE: every SWAP/KEEP step in
// the redeem intent becomes its own `RedeemLeg`, built via
// `buildRobinhoodSwapLeg()` against the verified Robinhood Chain
// SwapRouter02 (or a "no swap" leg when the held asset already IS the
// quote token — see that module's doc).
//
// V12 — closes the "no live slippage protection" gap V11's own hardening
// report (docs/archive/V11_HARDENING_REPORT.md §10.2) flagged as the one real,
// open HIGH-severity finding left after that pass: every swap leg's
// `minOutput` and the attestation's `minUserProceeds` were hardcoded to 0,
// meaning a misbehaving or manipulated swap could return far less than
// expected and neither the per-leg Uniswap call nor the router's own
// `swapOutput < minUserProceeds + feeAmount` check would catch it. Fixed
// by reusing the SAME `QuoterV2` staticcall quoter already built and
// tested for the purchase side (`robinhood-uniswap-quoter.ts` —
// `createRobinhoodUniswapQuoter`), rather than writing a second one: this
// endpoint now quotes each swap leg for real before attesting to it,
// tries `COMMON_FEE_TIERS` in order (same fallback-across-tiers pattern
// the purchase-side leg builder already uses) so a leg isn't rejected
// just because the *first* tier lacks a pool, and derives BOTH the
// per-leg `minOutput` and the aggregate `minUserProceeds` from the real
// on-chain quote rather than from a fabricated zero. Uses the same
// `DEFAULT_COMPOSER_SLIPPAGE_BPS` (100 = 1%) the purchase side already
// treats as this protocol's standard slippage tolerance, rather than
// inventing a second, redeem-specific number to keep in sync.
// -----------------------------------------------------------------------------

const ATTESTATION_TTL_MS = 5 * 60 * 1000; // 5 minutes — short-lived, matches this codebase's PURCHASE_INTENT_TTL_MS's "quote goes stale fast" convention.

/** No pool (at any of `COMMON_FEE_TIERS`) had enough liquidity to quote a leg's swap — cannot honestly attest a fee or a minOutput without a real price. Fails closed: the caller gets a clear 422, never a fabricated quote. */
export class NoLiquidityError extends Error {
  constructor(tokenIn: string, tokenOut: string) {
    super(`No Uniswap v3 pool (fee tiers ${COMMON_FEE_TIERS.join(', ')}) quoted a price for ${tokenIn} -> ${tokenOut} on Robinhood Chain — cannot safely attest this redemption's fee.`);
    this.name = 'NoLiquidityError';
  }
}

/** A4: the wallet or the books no longer cover this intent's legs; the intent is failed and nothing is signed. */
export class SaleNoLongerCoveredError extends Error {
  constructor() {
    super('Your position or wallet balance changed since this sale was quoted. Start a new sale.');
    this.name = 'SaleNoLongerCoveredError';
  }
}

/** A4: wallet balances could not be read right now; nothing is signed and the intent stays as it is. */
export class BalanceUnavailableError extends Error {
  constructor() {
    super('Your wallet balances could not be read right now. Please try again shortly.');
    this.name = 'BalanceUnavailableError';
  }
}

/** The best on-chain quote for a leg is too far below its value at BAG's verified price; nothing is signed. */
export class ExecutionPriceTooLowError extends Error {
  constructor(public readonly token: string, public readonly deviationBps: number, public readonly maxDeviationBps: number) {
    super(
      `The best available swap for ${token} is ${(deviationBps / 100).toFixed(2)}% below its verified price (allowed: ${(maxDeviationBps / 100).toFixed(2)}%). ` +
        'This sale cannot go through at a fair price right now. Nothing was signed.'
    );
    this.name = 'ExecutionPriceTooLowError';
  }
}

/** No verified price (or no registry decimals) for a leg: its sale price cannot be checked, so nothing is signed. */
export class PriceUnavailableForSaleError extends Error {
  constructor(public readonly token: string, detail: string) {
    super(`No verified price for ${token} right now (${detail}); the sale price cannot be checked. Nothing was signed.`);
    this.name = 'PriceUnavailableForSaleError';
  }
}

/** The sale's quote expired before the fee was attested; nothing is signed. */
export class SaleQuoteExpiredError extends Error {
  constructor() {
    super('This sale quote has expired. Start a new sale.');
    this.name = 'SaleQuoteExpiredError';
  }
}

/** B0 (§5.6): a purchase of the same position is in flight; its fill would change the basis being attested. Nothing is signed. */
export class PositionBusyError extends Error {
  constructor() {
    super('A purchase of this Bag is still in progress. Wait for it to finish, then start the sale again.');
    this.name = 'PositionBusyError';
  }
}

/** B0: the books cannot give the basis or realized P&L this fee needs; never guessed, nothing is signed. */
export class FeeBasisUnavailableError extends Error {
  constructor(public readonly reason: 'BASIS_UNKNOWN' | 'BASIS_APPROXIMATE' | 'SOLD_EXCEEDS_BOOKS' | 'REALIZED_PNL_UNKNOWN') {
    super(`The performance fee for this sale cannot be computed from your records (${reason}). Nothing was signed.`);
    this.name = 'FeeBasisUnavailableError';
  }
}

export class RouterNotConfiguredError extends Error {
  constructor() {
    super('REDEEM_FEE_ROUTER_ADDRESS / CREATOR_REWARDS_VAULT_ADDRESS is not set — the router has not been deployed/configured yet.');
    this.name = 'RouterNotConfiguredError';
  }
}

export interface AttestedRedeemLeg {
  inputToken: `0x${string}`;
  inputAmount: string; // raw base units, decimal string (bigint-safe over JSON)
  swapTarget: `0x${string}`; // zeroAddress for a "no swap" leg
  swapCallData: `0x${string}`; // '0x' for a "no swap" leg
}

export interface FeeAttestation {
  redemptionId: `0x${string}`;
  user: `0x${string}`;
  creator: `0x${string}`;
  legs: AttestedRedeemLeg[];
  feeAmount: string; // raw base units, decimal string
  minUserProceeds: string; // raw base units, decimal string
  deadline: number; // unix seconds
  signature: `0x${string}`;
  /**
   * How `feeAmount` was computed (B0, docs/FEE_ECONOMICS_DESIGN.md): on the guaranteed minimum proceeds, not the
   * actual result, so the charged fee never exceeds the fee on the actual result. Raw settlement-token units.
   * Informational: the signature binds `feeAmount` and `minUserProceeds`, not this breakdown.
   */
  feeBreakdown: {
    method: 'B0_FLOOR';
    rateBps: number;
    grossMinimumProceeds: string;
    consumedBasis: string;
    lossCarry: string;
    feeBase: string;
  };
}

/**
 * Loads every authoritative input, builds one `RedeemLeg` per distinct asset
 * actually held in this redemption (each with a real on-chain quote and its
 * minimum output), computes the B0 fee on the resulting
 * grossMinimumProceeds (`computeB0Fee`: A3 basis of the quantities sold, loss
 * carried forward, raw units, floor), and signs the EIP-712 attestation with
 * `REDEEM_FEE_ATTESTOR_PRIVATE_KEY`.
 * Callers MUST have already verified the requesting session owns
 * `redeemIntentId` (mirrors every other redeem-intent route's
 * `getRedeemIntentForUser()` ownership check).
 */
export async function signFeeAttestation(admin: SupabaseClient, userId: string, redeemIntentId: string): Promise<FeeAttestation> {
  // Routing invariant (lib/server/fee-redemption-path.ts): once RedeemSettlement is configured, a fee-paying sale
  // goes through it only — nothing is signed for the older router, whatever else is configured.
  if (feeRedemptionPath() !== 'FEE_ROUTER') throw new RouterNotConfiguredError();
  const privateKey = process.env.REDEEM_FEE_ATTESTOR_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('REDEEM_FEE_ATTESTOR_PRIVATE_KEY is not set — cannot sign fee attestations.');
  }
  if (!DEPLOYED_CONTRACTS.redeemFeeRouter || !DEPLOYED_CONTRACTS.creatorRewardsVault) {
    throw new RouterNotConfiguredError();
  }

  const intentResult = await getRedeemIntentForUser(admin, redeemIntentId, userId);
  if (!intentResult.ok) {
    throw new Error(`Redeem intent not accessible: ${intentResult.error}`);
  }
  const intent = intentResult.intent;

  const assetSteps = intent.steps.filter((s) => (s.action === 'SWAP' || s.action === 'KEEP') && BigInt(s.inputAmountRaw) > BigInt(0));
  if (assetSteps.length === 0) {
    throw new Error(`Redeem intent ${redeemIntentId} has no non-zero asset steps — nothing to redeem.`);
  }

  const bag = await getBagById(admin, intent.bagId);
  if (!bag) throw new Error(`Bag ${intent.bagId} not found.`);

  const version = await getCurrentBagVersion(admin, intent.bagId);
  // The LOCKED rate once an external investor exists (migration 0033) — this
  // amount is attested and paid on-chain, so it must be the immutable rate.
  const performanceFeeBps = bag.performanceFeeBpsLocked ?? version?.recipe.performanceFeeBps ?? 0;

  const { data: creatorRow, error: creatorErr } = await admin.from('users').select('wallet_address').eq('id', bag.creatorId).maybeSingle();
  if (creatorErr) throw new Error(creatorErr.message);
  const creatorWallet = (creatorRow as { wallet_address: string } | null)?.wallet_address;
  if (!creatorWallet) throw new Error(`Bag ${intent.bagId}'s creator has no wallet_address on file.`);

  const { data: redeemerRow, error: redeemerErr } = await admin.from('users').select('wallet_address').eq('id', userId).maybeSingle();
  if (redeemerErr) throw new Error(redeemerErr.message);
  const redeemerWallet = (redeemerRow as { wallet_address: string } | null)?.wallet_address;
  if (!redeemerWallet) throw new Error(`User ${userId} has no wallet_address on file.`);

  // A4 pre-sign check (lib/server/sale-coverage.ts), the same one the legacy path runs: the attestation is
  // what lets the wallet sign, so a sale no longer covered by the wallet and the books is never attested.
  const coverage = await checkSaleCoverage(admin, { userId, walletAddress: redeemerWallet }, intent);
  if (coverage === 'BALANCE_UNAVAILABLE') throw new BalanceUnavailableError();
  if (coverage === 'NOT_COVERED') {
    await updateRedeemIntentStatus(admin, { id: intent.id, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    throw new SaleNoLongerCoveredError();
  }

  // B0 (§5.6): the basis below is read from the ledger now; a purchase of the same position landing before this
  // sale executes would change it. Refuse while one is in flight (a purchase is likewise refused while this
  // fee-paying sale is open — lib/server/fee-redemption-lock.ts).
  const creatorIsRedeemer = bag.creatorId === userId;
  const feeApplies = !creatorIsRedeemer && performanceFeeBps > 0;
  if (feeApplies && (await purchaseInFlightFor(admin, userId, intent.bagId))) throw new PositionBusyError();

  // B0 (F2, F4): basis of exactly the quantities sold at the A3 average cost, and the loss carried forward, from
  // the position's ledger. Only needed when a fee applies; unknown values are never guessed.
  let consumedBasisRaw = BigInt(0);
  let lossCarryRaw = BigInt(0);
  if (feeApplies) {
    const pnl = computePositionPnl(await listAllLedgerEventsForPosition(admin, userId, intent.bagId));
    const basis = feeBasisFromPositionPnl(
      pnl,
      assetSteps.map((s) => ({ chain: s.inputAsset.chain, address: s.inputAsset.address, quantityRaw: s.inputAmountRaw }))
    );
    if (!basis.ok) throw new FeeBasisUnavailableError(basis.reason);
    // Rounded UP into raw units: a smaller fee base, in the user's favour (§5.7).
    consumedBasisRaw = decimalToRawCeil(basis.consumedBasisQuote, ROBINHOOD_REWARD_TOKEN.decimals);
    lossCarryRaw = decimalToRawCeil(basis.lossCarryQuote, ROBINHOOD_REWARD_TOKEN.decimals);
  }

  const routerAddress = DEPLOYED_CONTRACTS.redeemFeeRouter;
  const quote = createRobinhoodUniswapQuoter(getRobinhoodPublicClient());

  const priceProvider = getPriceProvider();
  const decimalsByKey = new Map(
    (await getAssetsByIdentities(admin, assetSteps.map((s) => s.inputAsset))).map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a.decimals])
  );

  let totalMinOutputRaw = BigInt(0);
  const legs: AttestedRedeemLeg[] = [];
  for (const step of assetSteps) {
    const inputToken = step.inputAsset.address as `0x${string}`;
    const inputAmount = BigInt(step.inputAmountRaw);

    if (inputToken.toLowerCase() === ROBINHOOD_REWARD_TOKEN.address.toLowerCase()) {
      // Already denominated in the settlement currency — "no swap" leg.
      // Contributes its full raw amount to the output total 1:1; there is
      // no swap here for slippage to apply to.
      totalMinOutputRaw += inputAmount;
      legs.push({
        inputToken,
        inputAmount: inputAmount.toString(),
        swapTarget: '0x0000000000000000000000000000000000000000',
        swapCallData: '0x',
      });
      continue;
    }

    // Price quality (redeem-quote-quality.ts): quote EVERY fee tier, take the best, and refuse it if it is more
    // than FEE_REDEEM_MAX_PRICE_DEVIATION_BPS below the leg's value at BAG's verified price. A minimum output only
    // protects against the price moving after this quote, not against the quote itself being a bad price (e.g. the
    // only pool being near-empty). No verified price → nothing is signed.
    const tierQuotes: TierQuote[] = [];
    for (const feeTier of COMMON_FEE_TIERS) {
      const result = await quote({
        tokenIn: inputToken,
        tokenOut: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`,
        amountIn: inputAmount,
        feeTier,
      });
      if (result) tierQuotes.push({ feeTier, amountOut: result.amountOut });
    }
    const decimals = decimalsByKey.get(assetIdentityKey(step.inputAsset));
    if (decimals === undefined) throw new PriceUnavailableForSaleError(inputToken, 'asset not in the registry');
    let priceUsd: string;
    try {
      priceUsd = (await priceProvider.getPrice(step.inputAsset)).price;
    } catch (e) {
      throw new PriceUnavailableForSaleError(inputToken, (e as Error).message);
    }
    const referenceRaw = referenceValueRaw(inputAmount, decimals, priceUsd, ROBINHOOD_REWARD_TOKEN.decimals);
    if (referenceRaw <= BigInt(0)) throw new PriceUnavailableForSaleError(inputToken, 'amount too small to value');
    const selection = selectRedeemLegQuote(tierQuotes, referenceRaw, FEE_REDEEM_MAX_PRICE_DEVIATION_BPS);
    if (!selection.ok && selection.reason === 'NO_QUOTE') throw new NoLiquidityError(inputToken, ROBINHOOD_REWARD_TOKEN.address);
    if (!selection.ok) throw new ExecutionPriceTooLowError(inputToken, selection.deviationBps, FEE_REDEEM_MAX_PRICE_DEVIATION_BPS);
    const resolvedFeeTier = selection.feeTier;
    const expectedOut = selection.quoteRaw;

    // Real slippage floor, derived from the actual on-chain quote — not a
    // fabricated 0 (see this file's V12 module doc note above).
    const minOutput = (expectedOut * BigInt(10000 - DEFAULT_COMPOSER_SLIPPAGE_BPS)) / BigInt(10000);
    totalMinOutputRaw += minOutput;

    const swapLeg = buildRobinhoodSwapLeg({
      inputToken,
      inputAmount,
      outputToken: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`,
      recipient: routerAddress, // the router itself is msg.sender to the swap target, not the user — it must hold the output to split fee vs. proceeds.
      minOutput,
      feeTier: resolvedFeeTier,
    });

    legs.push({
      inputToken,
      inputAmount: inputAmount.toString(),
      swapTarget: swapLeg.swapTarget,
      swapCallData: swapLeg.swapCallData,
    });
  }

  // B0: the fee is computed on grossMinimumProceeds — Σ the per-leg minimum outputs just quoted, the floor the
  // router enforces (`swapOutput ≥ minUserProceeds + feeAmount` = `swapOutput ≥ grossMinimumProceeds`). Actual
  // proceeds are never below it, so the fee never exceeds the fee on the actual result.
  const fee = computeB0Fee({
    grossMinimumProceedsRaw: totalMinOutputRaw,
    consumedBasisRaw,
    lossCarryRaw,
    rateBps: performanceFeeBps,
    creatorIsRedeemer,
  });
  const feeAmountRaw = fee.feeRaw;
  const minUserProceedsRaw = fee.minUserProceedsRaw;

  // Never valid past the intent's own expiry: the purchase lock (§5.6) is released when the intent expires, so an
  // attestation outliving it could execute after a purchase changed the basis it was computed from.
  const deadlineMs = Math.min(Date.now() + ATTESTATION_TTL_MS, new Date(intent.expiresAt).getTime());
  if (!(deadlineMs > Date.now())) throw new SaleQuoteExpiredError();
  const deadline = Math.floor(deadlineMs / 1000);
  const redemptionId = computeOnChainBagId(intent.id); // same UUID -> bytes32 convention as Bag ids (onchain.ts).

  const legsHash = computeLegsHash(
    legs.map((l) => ({
      inputToken: l.inputToken,
      inputAmount: BigInt(l.inputAmount),
      swapTarget: l.swapTarget as `0x${string}`,
      swapCallData: l.swapCallData as `0x${string}`,
    }))
  );

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const signature = await account.signTypedData({
    domain: {
      name: REDEEM_FEE_ROUTER_EIP712_DOMAIN_NAME,
      version: REDEEM_FEE_ROUTER_EIP712_DOMAIN_VERSION,
      chainId: ROBINHOOD_CHAIN_ID,
      verifyingContract: routerAddress,
    },
    types: FEE_ATTESTATION_TYPES,
    primaryType: 'FeeAttestation',
    message: {
      redemptionId,
      user: redeemerWallet as `0x${string}`,
      creator: creatorWallet as `0x${string}`,
      feeAmount: feeAmountRaw,
      minUserProceeds: minUserProceedsRaw,
      deadline: BigInt(deadline),
      legsHash,
    },
  });

  return {
    redemptionId,
    user: redeemerWallet as `0x${string}`,
    creator: creatorWallet as `0x${string}`,
    legs,
    feeAmount: feeAmountRaw.toString(),
    minUserProceeds: minUserProceedsRaw.toString(),
    deadline,
    signature,
    feeBreakdown: {
      method: 'B0_FLOOR',
      rateBps: feeApplies ? performanceFeeBps : 0,
      grossMinimumProceeds: totalMinOutputRaw.toString(),
      consumedBasis: consumedBasisRaw.toString(),
      lossCarry: lossCarryRaw.toString(),
      feeBase: fee.feeBaseRaw.toString(),
    },
  };
}
