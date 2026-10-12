import { SupabaseClient } from '@supabase/supabase-js';
import { getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { computeB0Fee, decimalToRawCeil, feeBasisFromPositionPnl } from '@/lib/domain/basket-protocol/redeem/performance-fee-b0';
import { FEE_REDEEM_MAX_PRICE_DEVIATION_BPS, referenceValueRaw, selectRedeemLegQuote } from '@/lib/domain/basket-protocol/redeem/redeem-quote-quality';
import { computePositionPnl } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { getPriceProvider } from '@/lib/server/price-provider';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, DEPLOYED_CONTRACTS } from '@/lib/config/robinhood-chain';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';
import { buildComposerSettlementRedeem, buildComposerSweep, composerLegEnforcedMinOutputRaw, sweepNodeId } from '@/lib/blockchain/lifi-composer-adapter';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import {
  SETTLEMENT_TYPES,
  computeSettlementContextHash,
  settlementDomain,
  toCompactSignature,
  type SettlementContext,
  type SettlementMessage,
} from '@/lib/blockchain/redeem-settlement-eip712';
import {
  claimRedeemSettlementAttestation,
  getRedeemIntentForUser,
  listLiveSettlementAttestations,
  listOpenRedeemIntentsForBag,
  setRedeemSettlementAttested,
  setRedeemSettlementPlan,
  updateRedeemIntentStatus,
} from '@/lib/server/redeem-intent-repo';
import { checkSaleCoverage } from '@/lib/server/sale-coverage';
import { listAllLedgerEventsForPosition } from '@/lib/server/ledger-repo';
import { purchaseInFlightFor } from '@/lib/server/fee-redemption-lock';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import type { RedeemIntent, RedeemSettlementPlan } from '@/types/redeem-intent';
import {
  BalanceUnavailableError,
  ExecutionPriceTooLowError,
  FeeBasisUnavailableError,
  PositionBusyError,
  PriceUnavailableForSaleError,
  SaleNoLongerCoveredError,
  SaleQuoteExpiredError,
} from '@/lib/server/redeem-fee-attestation';

// -----------------------------------------------------------------------------
// Two-phase settlement attestation for a fee-paying redemption through
// RedeemSettlement (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §9).
//
// The backend is NOT the fee authority: the contract computes the fee from the
// USDG that actually arrives (B). The backend only attests the inputs it owns —
// who the user, creator and executor are, the ledger's basis and loss carry, the
// Bag's locked rate — plus the user's floor, and binds the state it checked into
// one context hash. Nothing here sends "the fee to pay" to the contract.
//
//   Phase 1  quoteSettlement   — state + lock + coverage, ledger basis/carry, a Composer quote,
//                                #16 price quality per leg, the floor, the executor (the user's
//                                Composer proxy); records the plan. Signs nothing.
//   Phase 2  attestSettlement  — re-reads the state, recomputes the context hash and refuses
//                                unless it equals phase 1's (TOCTOU), re-checks lock, coverage
//                                and expiry, creator freeze preflight, signs, compiles the final
//                                Composer flow and refuses unless its proxy is the attested
//                                executor. Records the one transaction the wallet signs.
//
// Every input comes from the server; the request carries only the intent id.
// -----------------------------------------------------------------------------

const PLAN_TTL_MS = 2 * 60 * 1000;
const ATTESTATION_TTL_MS = 2 * 60 * 1000;

export class SettlementNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} is not set — RedeemSettlement is not deployed/configured yet.`);
    this.name = 'SettlementNotConfiguredError';
  }
}

/** A configured value that cannot be used (e.g. a malformed attestor key). Never includes the value itself. */
export class SettlementMisconfiguredError extends Error {
  constructor(what: string) {
    super(`${what} — RedeemSettlement is misconfigured on this deployment. Nothing was signed.`);
    this.name = 'SettlementMisconfiguredError';
  }
}

/**
 * The attestor key as an operator pastes it into a dashboard: surrounding whitespace or quotes and a missing `0x` are
 * tolerated; anything that is not then exactly 32 bytes of hex is refused with a message that never contains it.
 */
export function attestorKeyFromEnv(raw: string): `0x${string}` {
  let k = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  k = /^0x/i.test(k) ? `0x${k.slice(2)}` : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new SettlementMisconfiguredError('REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY is not a 32-byte hex private key');
  return k.toLowerCase() as `0x${string}`;
}
/** The redemption has nothing to swap (only USDG holdings): there is no Composer quote to check, so nothing is planned. */
export class NothingToSettleError extends Error {
  constructor() {
    super('This sale has no tokens to sell into USDG.');
    this.name = 'NothingToSettleError';
  }
}
/** Phase 2: there is no phase-1 plan for this intent, or it expired. */
export class SettlementPlanMissingError extends Error {
  constructor(reason: 'NO_PLAN' | 'PLAN_EXPIRED') {
    super(reason === 'NO_PLAN' ? 'Quote this sale first.' : 'This sale quote has expired. Quote it again.');
    this.name = 'SettlementPlanMissingError';
  }
}
/** Phase 2: the state no longer hashes to the context phase 1 checked (position, ledger, version, creator, rate…). */
export class SettlementStateChangedError extends Error {
  constructor() {
    super('Something about this position changed since the sale was quoted. Quote it again. Nothing was signed.');
    this.name = 'SettlementStateChangedError';
  }
}
/**
 * Another sale of the same position is open, or holds a settlement attestation still valid on-chain. Its execution
 * would change the ledger this one is attested against (or this one would change its), so nothing is signed (§9).
 */
export class AnotherSaleOpenError extends Error {
  constructor(public readonly otherIntentId: string) {
    super('Another sale of this Bag is still open. Wait for it to finish or expire, then try again. Nothing was signed.');
    this.name = 'AnotherSaleOpenError';
  }
}
/** Phase 2 preflight: USDG reports the creator's address as frozen; the fee transfer would revert. */
export class CreatorFrozenError extends Error {
  constructor() {
    super("The Bag creator's address cannot receive USDG right now, so a fee-paying sale cannot settle. Nothing was signed.");
    this.name = 'CreatorFrozenError';
  }
}
/** Phase 2: the final Composer flow would be executed by a different proxy than the one attested. */
export class ExecutorMismatchError extends Error {
  constructor(public readonly attested: string, public readonly compiled: string) {
    super('The execution account changed between the quote and the final transaction. Quote again. Nothing to sign.');
    this.name = 'ExecutorMismatchError';
  }
}

interface SettlementState {
  intent: RedeemIntent;
  context: SettlementContext;
  contextHash: `0x${string}`;
  redeemer: `0x${string}`;
  creator: `0x${string}`;
  /** The root creator of the Bag's lineage when it is a fork by someone else; null otherwise. */
  rootCreator: `0x${string}` | null;
  feeRateBps: number;
  creatorIsRedeemer: boolean;
  consumedBasisRaw: bigint;
  lossCarryRaw: bigint;
  legs: { token: `0x${string}`; amountRaw: bigint; chain: RedeemIntent['outputAsset']['chain'] }[];
}

function settlementAddress(): `0x${string}` {
  const a = DEPLOYED_CONTRACTS.redeemSettlement;
  if (!a) throw new SettlementNotConfiguredError('REDEEM_SETTLEMENT_ADDRESS');
  return getAddress(a);
}

/** Refuses while any OTHER intent of the position is open or holds a live settlement attestation (§9). */
async function assertNoOtherSale(admin: SupabaseClient, userId: string, bagId: string, intentId: string): Promise<void> {
  const open = (await listOpenRedeemIntentsForBag(admin, userId, bagId)).find((i) => i.id !== intentId);
  if (open) throw new AnotherSaleOpenError(open.id);
  const live = (await listLiveSettlementAttestations(admin, userId, bagId)).find((i) => i.id !== intentId);
  if (live) throw new AnotherSaleOpenError(live.id);
}

/**
 * Everything both phases read from authoritative server state. Phase 2 calls this again from scratch: the context
 * hash it returns must equal phase 1's, or nothing is signed.
 */
async function loadSettlementState(admin: SupabaseClient, userId: string, intentId: string, settlement: `0x${string}`): Promise<SettlementState> {
  const r = await getRedeemIntentForUser(admin, intentId, userId);
  if (!r.ok) throw new Error(`Redeem intent not accessible: ${r.error}`);
  const intent = r.intent;
  if (intent.status !== 'READY') throw new SaleQuoteExpiredError();
  if (!(new Date(intent.expiresAt).getTime() > Date.now())) throw new SaleQuoteExpiredError();

  const assetSteps = intent.steps.filter((s) => (s.action === 'SWAP' || s.action === 'KEEP') && BigInt(s.inputAmountRaw) > BigInt(0));
  if (assetSteps.length === 0) throw new NothingToSettleError();

  const bag = await getBagById(admin, intent.bagId);
  if (!bag) throw new Error(`Bag ${intent.bagId} not found.`);
  const version = await getCurrentBagVersion(admin, intent.bagId);
  if (!version) throw new Error(`Bag ${intent.bagId} has no current version.`);
  // The LOCKED rate once an external investor exists (migration 0033).
  const lockedRate = bag.performanceFeeBpsLocked ?? version.recipe.performanceFeeBps ?? 0;
  const creatorIsRedeemer = bag.creatorId === userId;
  const feeRateBps = creatorIsRedeemer ? 0 : lockedRate;

  // Fork royalty: the root of the lineage, from BAG's own records (never the caller). Only a fork by someone else.
  const rootBag = bag.rootBagId && bag.rootBagId !== bag.id ? await getBagById(admin, bag.rootBagId) : null;
  const rootCreatorId = rootBag && rootBag.creatorId !== bag.creatorId ? rootBag.creatorId : null;

  const wallets = await admin.from('users').select('id, wallet_address').in('id', [bag.creatorId, userId, ...(rootCreatorId ? [rootCreatorId] : [])]);
  if (wallets.error) throw new Error(wallets.error.message);
  const walletOf = (id: string) => (wallets.data as { id: string; wallet_address: string | null }[]).find((u) => u.id === id)?.wallet_address;
  const creatorWallet = walletOf(bag.creatorId);
  const redeemerWallet = walletOf(userId);
  if (!creatorWallet) throw new Error(`Bag ${intent.bagId}'s creator has no wallet_address on file.`);
  if (!redeemerWallet) throw new Error(`User ${userId} has no wallet_address on file.`);
  const rootCreatorWallet = rootCreatorId ? walletOf(rootCreatorId) : null;
  if (rootCreatorId && !rootCreatorWallet) throw new Error(`Bag ${intent.bagId}'s root creator has no wallet_address on file.`);
  if (redeemerWallet.toLowerCase() !== intent.walletAddress.toLowerCase()) throw new SettlementStateChangedError();

  // A4 pre-sign check: the wallet and the books still cover every leg.
  const coverage = await checkSaleCoverage(admin, { userId, walletAddress: redeemerWallet }, intent);
  if (coverage === 'BALANCE_UNAVAILABLE') throw new BalanceUnavailableError();
  if (coverage === 'NOT_COVERED') {
    await updateRedeemIntentStatus(admin, { id: intent.id, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    throw new SaleNoLongerCoveredError();
  }

  // §5.6: a purchase of the same position in flight would change the basis read below.
  if (feeRateBps > 0 && (await purchaseInFlightFor(admin, userId, intent.bagId))) throw new PositionBusyError();
  // §9: so would another sale of it — open, or already terminal but holding an attestation still valid on-chain.
  await assertNoOtherSale(admin, userId, intent.bagId, intent.id);

  const ledger = await listAllLedgerEventsForPosition(admin, userId, intent.bagId);
  let consumedBasisRaw = BigInt(0);
  let lossCarryRaw = BigInt(0);
  if (feeRateBps > 0) {
    const basis = feeBasisFromPositionPnl(
      computePositionPnl(ledger),
      assetSteps.map((s) => ({ chain: s.inputAsset.chain, address: s.inputAsset.address, quantityRaw: s.inputAmountRaw }))
    );
    if (!basis.ok) throw new FeeBasisUnavailableError(basis.reason);
    // Rounded UP: a smaller fee base, in the user's favour (§5.7).
    consumedBasisRaw = decimalToRawCeil(basis.consumedBasisQuote, ROBINHOOD_REWARD_TOKEN.decimals);
    lossCarryRaw = decimalToRawCeil(basis.lossCarryQuote, ROBINHOOD_REWARD_TOKEN.decimals);
  }
  const head = ledger.length > 0 ? ledger[ledger.length - 1].seq : '0';

  const legs = assetSteps.map((s) => ({ token: getAddress(s.inputAsset.address), amountRaw: BigInt(s.inputAmountRaw), chain: s.inputAsset.chain }));
  const context: SettlementContext = {
    chainId: ROBINHOOD_CHAIN_ID,
    settlement,
    bagId: bag.id,
    bagContract: bag.contractAddress,
    strategyVersion: version.version,
    compositionHash: version.compositionHash,
    redeemIntentId: intent.id,
    user: redeemerWallet,
    creator: creatorWallet,
    rootCreator: rootCreatorWallet ?? null,
    sharesRaw: intent.sharesRaw,
    legs: legs.map((l) => ({ token: l.token, amountRaw: l.amountRaw.toString() })),
    ledgerHeadSeq: head,
    ledgerEventCount: ledger.length,
    consumedBasisRaw: consumedBasisRaw.toString(),
    lossCarryRaw: lossCarryRaw.toString(),
    feeRateBps,
  };
  return {
    intent,
    context,
    contextHash: computeSettlementContextHash(context),
    redeemer: getAddress(redeemerWallet),
    creator: getAddress(creatorWallet),
    rootCreator: rootCreatorWallet ? getAddress(rootCreatorWallet) : null,
    feeRateBps,
    creatorIsRedeemer,
    consumedBasisRaw,
    lossCarryRaw,
    legs,
  };
}

export interface SettlementQuote {
  plan: RedeemSettlementPlan;
  /** Informational: what the contract would charge if exactly the minimum arrived. Never sent to the contract. */
  feeAtMinimumRaw: string;
}

/** Phase 1. Signs nothing. */
export async function quoteSettlement(admin: SupabaseClient, userId: string, intentId: string): Promise<SettlementQuote> {
  const settlement = settlementAddress();
  const apiKey = process.env.LIFI_API_KEY;
  if (!apiKey) throw new SettlementNotConfiguredError('LIFI_API_KEY');
  const state = await loadSettlementState(admin, userId, intentId, settlement);

  const usdg = ROBINHOOD_REWARD_TOKEN.address.toLowerCase();
  const swapLegs = state.legs.filter((l) => l.token.toLowerCase() !== usdg);
  if (swapLegs.length === 0) throw new NothingToSettleError();

  // A quote of the same sales (sold back to the wallet): per-leg simulated output and provider-enforced minimum,
  // and the user's Composer proxy — the executor.
  const quote = await buildComposerSweep({
    chain: 'robinhood',
    inputs: swapLegs.map((l) => ({ address: l.token, amountRaw: l.amountRaw.toString(), symbol: l.token })),
    outputTokenAddress: ROBINHOOD_REWARD_TOKEN.address,
    signerAddress: state.redeemer,
    slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
    apiKey,
  });

  // #16 price quality: each leg's quoted output against its value at BAG's verified price.
  const priceProvider = getPriceProvider();
  const decimalsByKey = new Map(
    (await getAssetsByIdentities(admin, swapLegs.map((l) => ({ chain: l.chain, address: l.token })))).map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a.decimals])
  );
  let grossMinimum = BigInt(0);
  for (const [i, leg] of swapLegs.entries()) {
    const sim = quote.producedResources[`${sweepNodeId(i)}.amountOut`]?.simulated;
    const out = sim?.amountOut !== undefined ? BigInt(String(sim.amountOut)) : null;
    const decimals = decimalsByKey.get(assetIdentityKey({ chain: leg.chain, address: leg.token }));
    if (decimals === undefined) throw new PriceUnavailableForSaleError(leg.token, 'asset not in the registry');
    let priceUsd: string;
    try {
      priceUsd = (await priceProvider.getPrice({ chain: leg.chain, address: leg.token })).price;
    } catch (e) {
      throw new PriceUnavailableForSaleError(leg.token, (e as Error).message);
    }
    const reference = referenceValueRaw(leg.amountRaw, decimals, priceUsd, ROBINHOOD_REWARD_TOKEN.decimals);
    if (reference <= BigInt(0)) throw new PriceUnavailableForSaleError(leg.token, 'amount too small to value');
    const selection = selectRedeemLegQuote(out === null ? [] : [{ feeTier: 0, amountOut: out }], reference, FEE_REDEEM_MAX_PRICE_DEVIATION_BPS);
    if (!selection.ok && selection.reason === 'NO_QUOTE') throw new PriceUnavailableForSaleError(leg.token, 'no Composer quote for this leg');
    if (!selection.ok) throw new ExecutionPriceTooLowError(leg.token, selection.deviationBps, FEE_REDEEM_MAX_PRICE_DEVIATION_BPS);
    const enforcedMin = composerLegEnforcedMinOutputRaw(quote.producedResources, i);
    grossMinimum += enforcedMin !== null ? BigInt(enforcedMin) : (selection.quoteRaw * BigInt(10000 - DEFAULT_COMPOSER_SLIPPAGE_BPS)) / BigInt(10000);
  }
  for (const l of state.legs) if (l.token.toLowerCase() === usdg) grossMinimum += l.amountRaw;

  // The user's floor after the fee. Not a fee sent anywhere: the user receives ≥ this iff ≥ grossMinimum arrives,
  // because received − fee(received) only grows with received (rate ≤ 100%). Same formula as the contract.
  const atMinimum = computeB0Fee({
    grossMinimumProceedsRaw: grossMinimum,
    consumedBasisRaw: state.consumedBasisRaw,
    lossCarryRaw: state.lossCarryRaw,
    rateBps: state.feeRateBps,
    creatorIsRedeemer: false,
  });

  const now = Date.now();
  const plan: RedeemSettlementPlan = {
    schema: 1,
    settlement,
    contextHash: state.contextHash,
    executor: getAddress(quote.userProxy),
    user: state.redeemer,
    creator: state.creator,
    rootCreator: state.rootCreator,
    consumedBasisRaw: state.consumedBasisRaw.toString(),
    lossCarryRaw: state.lossCarryRaw.toString(),
    feeRateBps: state.feeRateBps,
    grossMinimumRaw: grossMinimum.toString(),
    minUserProceedsRaw: atMinimum.minUserProceedsRaw.toString(),
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + PLAN_TTL_MS, new Date(state.intent.expiresAt).getTime())).toISOString(),
  };
  const saved = await setRedeemSettlementPlan(admin, state.intent.id, 'READY', plan);
  if (!saved) throw new SaleQuoteExpiredError();
  return { plan, feeAtMinimumRaw: atMinimum.feeRaw.toString() };
}

export interface SettlementAttestation {
  composerTransaction: NonNullable<RedeemIntent['composerTransaction']>;
  message: Record<keyof SettlementMessage, string>;
  signature: `0x${string}`;
  deadline: number;
}

/** USDG is a Paxos token. Best-effort freeze read — a preflight only; the contract's revert is the guarantee. */
async function creatorFrozen(creator: `0x${string}`): Promise<boolean | null> {
  try {
    return (await getRobinhoodPublicClient().readContract({
      address: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`,
      abi: [{ type: 'function', name: 'isFrozen', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }] as const,
      functionName: 'isFrozen',
      args: [creator],
    })) as boolean;
  } catch {
    return null; // unknown: the contract still fails closed
  }
}

/** Phase 2. */
export async function attestSettlement(admin: SupabaseClient, userId: string, intentId: string): Promise<SettlementAttestation> {
  const settlement = settlementAddress();
  const privateKey = process.env.REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY;
  if (!privateKey) throw new SettlementNotConfiguredError('REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY');
  const apiKey = process.env.LIFI_API_KEY;
  if (!apiKey) throw new SettlementNotConfiguredError('LIFI_API_KEY');

  // Fresh state, read again from scratch — never phase 1's objects.
  const state = await loadSettlementState(admin, userId, intentId, settlement);
  const plan = state.intent.settlementPlan;
  if (!plan) throw new SettlementPlanMissingError('NO_PLAN');
  if (!(new Date(plan.expiresAt).getTime() > Date.now())) throw new SettlementPlanMissingError('PLAN_EXPIRED');

  // TOCTOU: the state must still be exactly what phase 1 checked, and the plan must describe it.
  if (state.contextHash !== plan.contextHash || plan.settlement.toLowerCase() !== settlement.toLowerCase()) throw new SettlementStateChangedError();
  if (
    plan.user.toLowerCase() !== state.redeemer.toLowerCase() ||
    plan.creator.toLowerCase() !== state.creator.toLowerCase() ||
    (plan.rootCreator ?? null)?.toLowerCase() !== state.rootCreator?.toLowerCase() ||
    plan.consumedBasisRaw !== state.consumedBasisRaw.toString() ||
    plan.lossCarryRaw !== state.lossCarryRaw.toString() ||
    plan.feeRateBps !== state.feeRateBps
  ) {
    throw new SettlementStateChangedError();
  }

  if (state.feeRateBps > 0 && (await creatorFrozen(state.creator)) === true) throw new CreatorFrozenError();
  if (state.feeRateBps > 0 && state.rootCreator && (await creatorFrozen(state.rootCreator)) === true) throw new CreatorFrozenError();

  // Never valid past the intent's expiry (the purchase lock is released then) nor the plan's.
  const deadlineMs = Math.min(Date.now() + ATTESTATION_TTL_MS, new Date(state.intent.expiresAt).getTime(), new Date(plan.expiresAt).getTime());
  if (!(deadlineMs > Date.now())) throw new SaleQuoteExpiredError();
  const deadline = Math.floor(deadlineMs / 1000);

  // Write-then-check (§9): record the deadline this attestation will carry BEFORE looking for other sales of the
  // position and before signing. A sale starting concurrently either sees this claim (and refuses), or wrote its own
  // intent first — and then the check below sees it. Never both proceed.
  const claimed = await claimRedeemSettlementAttestation(admin, state.intent.id, 'READY', { ...plan, deadline });
  if (!claimed) throw new SettlementStateChangedError();
  await assertNoOtherSale(admin, userId, state.intent.bagId, state.intent.id);
  if (state.feeRateBps > 0 && (await purchaseInFlightFor(admin, userId, state.intent.bagId))) throw new PositionBusyError();

  const message: SettlementMessage = {
    redemptionId: computeOnChainBagId(state.intent.id),
    user: state.redeemer,
    creator: state.creator,
    rootCreator: state.rootCreator ?? zeroAddress,
    executor: getAddress(plan.executor),
    contextHash: state.contextHash,
    consumedBasis: state.consumedBasisRaw,
    lossCarry: state.lossCarryRaw,
    feeRateBps: BigInt(state.feeRateBps),
    minUserProceeds: BigInt(plan.minUserProceedsRaw),
    deadline: BigInt(deadline),
  };
  const signature = await privateKeyToAccount(attestorKeyFromEnv(privateKey)).signTypedData({
    domain: settlementDomain(ROBINHOOD_CHAIN_ID, settlement),
    types: SETTLEMENT_TYPES,
    primaryType: 'Settlement',
    message,
  });
  const { r, vs } = toCompactSignature(signature);

  const final = await buildComposerSettlementRedeem({
    chain: 'robinhood',
    inputs: state.legs.map((l) => ({ address: l.token, amountRaw: l.amountRaw.toString(), symbol: l.token })),
    outputTokenAddress: ROBINHOOD_REWARD_TOKEN.address,
    settlementAddress: settlement,
    settle: { ...message, r, vs },
    signerAddress: state.redeemer,
    slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
    apiKey,
  });
  // The attested executor must be the account that will actually call settle.
  if (getAddress(final.userProxy) !== message.executor) throw new ExecutorMismatchError(message.executor, final.userProxy);
  if (!final.transactionRequest.data.toLowerCase().includes(settlement.slice(2).toLowerCase())) {
    throw new Error('The final Composer transaction does not reference the settlement contract.');
  }

  const composerTransaction = {
    to: final.transactionRequest.to,
    data: final.transactionRequest.data,
    value: final.transactionRequest.value,
    chainId: final.transactionRequest.chainId ?? ROBINHOOD_CHAIN_ID,
    approvals: final.approvals,
  };
  const saved = await setRedeemSettlementAttested(
    admin,
    state.intent.id,
    'READY',
    plan.contextHash,
    { ...plan, attestedAt: new Date().toISOString(), deadline },
    composerTransaction
  );
  if (!saved) throw new SettlementStateChangedError();
  // The wallet signs next: from here the existing step reports (AWAITING_SIGNATURE → SUBMITTED) and the Composer
  // verification path take over, with the contract's Settled event as the source of truth.
  const awaiting = await updateRedeemIntentStatus(admin, { id: state.intent.id, from: 'READY', to: 'AWAITING_SIGNATURE' });
  if (!awaiting) throw new SettlementStateChangedError();

  return {
    composerTransaction,
    message: Object.fromEntries(Object.entries(message).map(([k, v]) => [k, String(v)])) as Record<keyof SettlementMessage, string>,
    signature,
    deadline,
  };
}
