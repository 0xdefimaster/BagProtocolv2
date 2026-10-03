import { SupabaseClient } from '@supabase/supabase-js';
import { privateKeyToAccount } from 'viem/accounts';
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { previewPerformanceFee } from '@/lib/domain/basket-protocol/redeem/performance-fee-preview';
import { quoteDecimalToRewardTokenRaw, ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, DEPLOYED_CONTRACTS } from '@/lib/config/robinhood-chain';
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
import { getRedeemIntentForUser } from '@/lib/server/redeem-intent-repo';
import { getInvestorPosition } from '@/lib/server/bag-investor-position-repo';
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
// report (docs/V11_HARDENING_REPORT.md §10.2) flagged as the one real,
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
}

/**
 * Loads every authoritative input, computes the fee via
 * `previewPerformanceFee()` (the exact TypeScript mirror of
 * `apply_redeem_execution()`'s own SQL math), builds one `RedeemLeg` per
 * distinct asset actually held in this redemption, and signs the
 * resulting EIP-712 attestation with `REDEEM_FEE_ATTESTOR_PRIVATE_KEY`.
 * Callers MUST have already verified the requesting session owns
 * `redeemIntentId` (mirrors every other redeem-intent route's
 * `getRedeemIntentForUser()` ownership check).
 */
export async function signFeeAttestation(admin: SupabaseClient, userId: string, redeemIntentId: string): Promise<FeeAttestation> {
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

  const [position, bag] = await Promise.all([getInvestorPosition(admin, userId, intent.bagId), getBagById(admin, intent.bagId)]);
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

  // The position's shares/cost-basis BEFORE this specific redemption —
  // reconstructed from the CURRENT (already-quoted, not-yet-executed)
  // position, since this intent's own accounting hasn't been applied yet.
  // See performance-fee-preview.ts's own doc on why bit-for-bit parity
  // with apply_redeem_execution()'s SQL math matters here.
  const fee = previewPerformanceFee({
    positionCostBasisQuote: position.costBasisQuote,
    positionSharesRaw: position.sharesRaw,
    sharesBurnRaw: intent.sharesRaw,
    redeemValueQuote: intent.redeemValueQuote,
    performanceFeeBps,
    creatorIsRedeemer: bag.creatorId === userId,
  });
  const feeAmountRaw = quoteDecimalToRewardTokenRaw(fee.feeAmountQuote);

  const routerAddress = DEPLOYED_CONTRACTS.redeemFeeRouter;
  const quote = createRobinhoodUniswapQuoter(getRobinhoodPublicClient());

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

    // Try each fee tier in order (same fallback-across-tiers pattern
    // lib/execution/legbuilders/robinhood-uniswap-leg-builder.ts already
    // uses on the purchase side) until one has a real, quotable pool.
    let resolvedFeeTier: number | null = null;
    let expectedOut: bigint | null = null;
    for (const feeTier of COMMON_FEE_TIERS) {
      const result = await quote({
        tokenIn: inputToken,
        tokenOut: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`,
        amountIn: inputAmount,
        feeTier,
      });
      if (result) {
        resolvedFeeTier = feeTier;
        expectedOut = result.amountOut;
        break;
      }
    }
    if (resolvedFeeTier === null || expectedOut === null) {
      throw new NoLiquidityError(inputToken, ROBINHOOD_REWARD_TOKEN.address);
    }

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

  // The router's own on-chain check is `swapOutput >= minUserProceeds +
  // feeAmount` against the REAL combined result — this is the off-chain
  // mirror of that floor, built from the same per-leg quotes just used to
  // set each leg's own `minOutput`, not a second independent guess.
  // Clamped at 0 rather than allowed to go negative: a negative value here
  // would mean the attested fee exceeds even the worst-case (post-
  // slippage) quoted output, which previewPerformanceFee()'s own "fee is a
  // fraction of PROFIT, not of total redemption value" arithmetic should
  // never produce in practice, but this must never be allowed to encode as
  // a negative uint256 in the signed attestation.
  const minUserProceedsRaw = totalMinOutputRaw > feeAmountRaw ? totalMinOutputRaw - feeAmountRaw : BigInt(0);

  const deadline = Math.floor((Date.now() + ATTESTATION_TTL_MS) / 1000);
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
  };
}
