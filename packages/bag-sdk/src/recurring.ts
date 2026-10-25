import { decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, parseAbi, stringToHex } from 'viem';
import { chainIdOf, isNativeToken, normalizeAddress } from './chains';
import { computeDefinitionHash } from './definition';
import { BagSdkError } from './errors';
import { resolveV1Rules } from './rules';
import { splitByWeight } from './split';
import type { PurchaseBalanceEvidence, PurchaseReceiptClient } from './receipt';
import type { BagDocument, Hex } from './types';
import { validateBag } from './validate';

// -----------------------------------------------------------------------------
// Recurring (DCA) purchases through RecurringPurchaseExecutor
// (contracts/dca/RecurringPurchaseExecutor.sol). Pure helpers plus a read-only
// receipt verifier; the SDK never signs, sends or stores anything.
//
// The owner of the funds signs ONE EIP-712 `Authorization`. Its id is the
// EIP-712 digest, so it binds the chain and the executor deployment. The
// executor enforces every field on chain; these helpers build the same object
// from a bag.json, show it, and check a receipt against it. bag.json v1 itself
// is unchanged: the authorization refers to it by `definitionHash`.
// -----------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

export const RECURRING_PURCHASE_DOMAIN = Object.freeze({ name: 'BagRecurringPurchase', version: '1' });

export const RECURRING_AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'owner', type: 'address' },
    { name: 'sourceAccount', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'fundingKind', type: 'uint8' },
    { name: 'fundingContract', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'bag', type: 'BagRef' },
    { name: 'assets', type: 'AssetLimit[]' },
    { name: 'schedule', type: 'Schedule' },
    { name: 'route', type: 'Route' },
    { name: 'nonce', type: 'uint256' },
  ],
  AssetLimit: [
    { name: 'asset', type: 'address' },
    { name: 'symbol', type: 'string' },
    { name: 'weightBps', type: 'uint16' },
    { name: 'decimals', type: 'uint8' },
    { name: 'maxPriceRaw', type: 'uint256' },
  ],
  BagRef: [
    { name: 'bagId', type: 'bytes32' },
    { name: 'bagVersion', type: 'uint256' },
    { name: 'compositionHash', type: 'bytes32' },
    { name: 'definitionHash', type: 'bytes32' },
    { name: 'strategyId', type: 'bytes32' },
    { name: 'strategyVersion', type: 'uint32' },
  ],
  Route: [
    { name: 'router', type: 'address' },
    { name: 'swapTarget', type: 'address' },
    { name: 'allowedFees', type: 'uint24[]' },
  ],
  Schedule: [
    { name: 'grossAmountPerRun', type: 'uint256' },
    { name: 'totalBudget', type: 'uint256' },
    { name: 'maxExecutions', type: 'uint32' },
    { name: 'startsAt', type: 'uint64' },
    { name: 'periodSeconds', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export const RECURRING_REVOCATION_TYPES = {
  Revocation: [
    { name: 'owner', type: 'address' },
    { name: 'authorizationId', type: 'bytes32' },
  ],
} as const;

/**
 * RecurringPurchaseExecutor ABI (the calls a keeper or wallet needs, its event and its errors), so a consumer
 * needs no build artifacts. contracts/test/RecurringPurchaseExecutor.test.ts checks it against the compiled contract.
 */
export const RECURRING_EXECUTOR_ABI = parseAbi([
  'struct BagRef { bytes32 bagId; uint256 bagVersion; bytes32 compositionHash; bytes32 definitionHash; bytes32 strategyId; uint32 strategyVersion; }',
  'struct AssetLimit { address asset; string symbol; uint16 weightBps; uint8 decimals; uint256 maxPriceRaw; }',
  'struct Schedule { uint256 grossAmountPerRun; uint256 totalBudget; uint32 maxExecutions; uint64 startsAt; uint64 periodSeconds; uint64 expiresAt; }',
  'struct Route { address router; address swapTarget; uint24[] allowedFees; }',
  'struct Authorization { address owner; address sourceAccount; address recipient; uint8 fundingKind; address fundingContract; address inputToken; BagRef bag; AssetLimit[] assets; Schedule schedule; Route route; uint256 nonce; }',
  'struct Leg { address target; bytes callData; uint256 value; address approveToken; uint256 approveAmount; }',
  'struct OutputCheck { address token; uint256 minAmountOut; }',
  'struct ExecutionPlan { bytes32 bagId; bytes32 executionPlanHash; address wallet; address inputToken; uint256 inputAmount; uint256 deadline; Leg[] legs; OutputCheck[] minOutputs; }',
  'struct PurchaseExecution { bytes32 authorizationId; uint64 window; uint64 quoteDeadline; ExecutionPlan plan; bytes planSignature; }',
  'struct ExecutionState { uint32 executions; uint256 grossUsed; uint64 lastWindow; uint64 lastExecutionAt; bool revoked; }',
  'function execute(Authorization a, PurchaseExecution x, bytes ownerSignature, bytes fundingProof) returns (uint256 executionIndex)',
  'function revoke(bytes32 authorizationId)',
  'function revokeBySig(address owner, bytes32 authorizationId, bytes signature)',
  'function getState(address owner, bytes32 authorizationId) view returns (ExecutionState)',
  'function authorizationIdOf(Authorization a) view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',
  'function chainLabel() view returns (string)',
  'function compositionHashOf(AssetLimit[] assets) view returns (bytes32)',
  'event PurchaseExecuted(address indexed owner, bytes32 indexed authorizationId, bytes32 indexed executionHash, uint256 window, uint256 executionIndex, uint256 grossAmount, uint256 sourceDebit)',
  'event AuthorizationRevoked(address indexed owner, bytes32 indexed authorizationId)',
  'error AuthorizationMismatch(bytes32 expected, bytes32 given)',
  'error InvalidOwnerSignature()',
  'error RevokedAuthorization(bytes32 authorizationId)',
  'error InvalidTerms(uint256 code)',
  'error UnknownBag(bytes32 bagId)',
  'error BagChanged(uint256 version, bytes32 compositionHash)',
  'error CompositionMismatch(bytes32 signedList, bytes32 registered)',
  'error StrategyNotRegistered(bytes32 strategyId, uint32 version)',
  'error AssetDecimalsMismatch(address asset, uint8 signed, uint8 actual)',
  'error NotDue()',
  'error Expired()',
  'error QuoteExpired(uint256 deadline)',
  'error WrongWindow(uint256 current, uint256 planned)',
  'error Exhausted()',
  'error BudgetExceeded()',
  'error PlanMismatch(uint256 code)',
  'error RouteViolation(uint256 leg, uint256 code)',
  'error FundingMismatch()',
  'error InputNotFullySpent(uint256 refunded)',
  'error OutputBelowLimit(address asset, uint256 received, uint256 minimum)',
  'error DeliveryMismatch(address asset)',
]);

export const FUNDING_KINDS = Object.freeze({ ALLOWANCE: 0, DELEGATION: 1 } as const);
/** Uniswap v3 fee tiers the executor accepts (hundredths of a bip). 10000 = 1 %. */
export const RECURRING_ALLOWED_FEE_TIERS = Object.freeze([100, 500, 3000, 10000] as const);
export const RECURRING_MAX_ASSETS = 10;

export interface RecurringAssetLimit {
  asset: Hex;
  /** The symbol in the Bag's registered composition (BAG app metadata); part of the composition hash. */
  symbol: string;
  weightBps: number;
  decimals: number;
  /** Most input-token raw units the owner accepts to pay for ONE whole token (10**decimals units). */
  maxPriceRaw: bigint;
}

export interface RecurringAuthorization {
  owner: Hex;
  sourceAccount: Hex;
  recipient: Hex;
  fundingKind: number;
  fundingContract: Hex;
  inputToken: Hex;
  bag: { bagId: Hex; bagVersion: bigint; compositionHash: Hex; definitionHash: Hex; strategyId: Hex; strategyVersion: number };
  assets: RecurringAssetLimit[];
  schedule: { grossAmountPerRun: bigint; totalBudget: bigint; maxExecutions: number; startsAt: bigint; periodSeconds: bigint; expiresAt: bigint };
  route: { router: Hex; swapTarget: Hex; allowedFees: number[] };
  nonce: bigint;
}

/** Where the authorization is valid: the EIP-712 domain. */
export interface RecurringDeployment {
  chainId: number;
  executor: Hex;
}

export interface RecurringTermsInput {
  bag: BagDocument;
  /** The account whose funds are spent and who signs (EOA, or a smart account that validates via ERC-1271). */
  owner: string;
  /** Defaults to the owner. */
  recipient?: string;
  funding: { kind: 'ALLOWANCE' } | { kind: 'DELEGATION'; delegationManager: string };
  /** The input token the user pays with (e.g. USDG); its decimals must be verified on chain by the caller. */
  inputToken: string;
  /** Input token precision. Required when the strategy sets a positive `minInvestment` (each run is one purchase). */
  inputTokenDecimals?: number;
  /** On-chain BAG identity, read from BagFactory/Bag (and StrategyRegistry when registered). */
  registry: { bagId: string; bagVersion: bigint | number; compositionHash: string; strategyId?: string | null; strategyVersion?: number | null };
  amountPerRunRaw: bigint;
  runs: number;
  /** Must equal amountPerRunRaw × runs; it is never recomputed silently. */
  totalBudgetRaw: bigint;
  startsAt: bigint;
  periodSeconds: bigint;
  /** Defaults to startsAt + runs × periodSeconds. */
  expiresAt?: bigint;
  /** Per asset (any address case): the owner's maximum price for one whole token, in input-token raw units. */
  maxPriceRaw: Record<string, bigint>;
  route: { router: string; swapTarget: string; allowedFees?: readonly number[] };
  nonce: bigint;
}

const fail = (message: string): never => {
  throw new BagSdkError('RECURRING_TERMS_INVALID', message);
};
const addr = (value: string, label: string): Hex => {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) fail(`${label} is not an address.`);
  return normalizeAddress(value) as Hex;
};
const bytes32 = (value: string, label: string): Hex => {
  if (typeof value !== 'string' || !BYTES32_RE.test(value)) fail(`${label} is not a bytes32.`);
  return value.toLowerCase() as Hex;
};

/** ceil(amount × 10^decimals) for a canonical decimal string: the smallest raw amount that is not below it. */
function decimalToRawCeil(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const kept = fraction.slice(0, decimals).padEnd(decimals, '0');
  const raw = BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(kept === '' ? '0' : kept);
  return /[1-9]/.test(fraction.slice(decimals)) ? raw + BigInt(1) : raw;
}

/**
 * Builds the authorization a user signs from a bag.json and the chosen DCA terms. The asset list is the Bag's
 * registered composition (weights and decimals from the definition, symbols from metadata, registered order) and
 * must reproduce `registry.compositionHash`; the executor checks the same on chain. Each run is one bag.json v1 purchase,
 * so the v1 rules apply per run: a valid document, `minInvestment`, the BLOCK no-route policy and no
 * performance fee (fee accounting is not part of this version). Throws `RECURRING_TERMS_INVALID` for anything
 * the executor would refuse or bag.json v1 does not allow.
 */
export function buildRecurringAuthorization(input: RecurringTermsInput): RecurringAuthorization {
  const { bag } = input;
  const validation = validateBag(bag);
  if (!validation.valid) fail(`the bag.json is not valid: ${validation.errors.map((e) => e.code).join(', ')}.`);
  const rules = resolveV1Rules(bag.definition);
  if (rules.performanceFeeBps.value !== 0) fail('strategies with a performance fee are not supported by recurring purchases yet.');
  if (rules.noRouteAssetPolicy.value !== 'BLOCK') fail(`noRouteAssetPolicy ${rules.noRouteAssetPolicy.value} is not supported; a recurring run buys every asset or nothing (BLOCK).`);
  const owner = addr(input.owner, 'owner');
  const recipient = input.recipient === undefined ? owner : addr(input.recipient, 'recipient');
  const inputToken = addr(input.inputToken, 'inputToken');
  if (isNativeToken(inputToken)) fail('the native token cannot fund a recurring purchase; use an ERC-20 the owner approves.');
  const fundingKind = input.funding.kind === 'ALLOWANCE' ? FUNDING_KINDS.ALLOWANCE : input.funding.kind === 'DELEGATION' ? FUNDING_KINDS.DELEGATION : fail('funding.kind must be ALLOWANCE or DELEGATION.');
  const fundingContract = input.funding.kind === 'DELEGATION' ? addr(input.funding.delegationManager, 'funding.delegationManager') : inputToken;

  if (!Number.isInteger(input.runs) || input.runs < 1 || input.runs > 0xffffffff) fail('runs must be a positive integer.');
  if (typeof input.amountPerRunRaw !== 'bigint' || input.amountPerRunRaw <= BigInt(0)) fail('amountPerRunRaw must be a positive bigint.');
  const minInvestment = rules.minInvestmentAmount.value;
  if (minInvestment !== '0') {
    const d = input.inputTokenDecimals;
    if (d === undefined || !Number.isInteger(d) || d < 0 || d > 255) fail(`inputTokenDecimals is required to enforce the strategy minimum of ${minInvestment} per run.`);
    if (input.amountPerRunRaw < decimalToRawCeil(minInvestment, d as number)) fail(`amountPerRunRaw is below the strategy minimum of ${minInvestment} payment-token units per purchase.`);
  }
  if (input.totalBudgetRaw !== input.amountPerRunRaw * BigInt(input.runs)) {
    fail(`totalBudgetRaw ${input.totalBudgetRaw} does not equal amountPerRunRaw × runs (${input.amountPerRunRaw * BigInt(input.runs)}).`);
  }
  if (input.periodSeconds <= BigInt(0) || input.startsAt <= BigInt(0)) fail('startsAt and periodSeconds must be positive.');
  const expiresAt = input.expiresAt ?? input.startsAt + input.periodSeconds * BigInt(input.runs);
  if (expiresAt <= input.startsAt || expiresAt > MAX_UINT64) fail('expiresAt must be after startsAt.');

  const registered = recurringRegisteredAssets(bag) ?? fail('every asset needs its symbol in metadata: the Bag composition is keyed by symbol.');
  const assets: RecurringAssetLimit[] = registered.map((a) => {
    const asset = addr(a.asset, `asset ${a.symbol}`);
    if (!COMPOSITION_FIELD_RE.test(a.symbol) || a.symbol.length > 64) fail(`symbol ${JSON.stringify(a.symbol)} cannot be part of a composition row (no ':' or '|', 1–64 characters).`);
    if (isNativeToken(asset)) fail('native-token basket assets are not supported (ERC-20 assets only, as in the v1 purchase executor).');
    if (asset === inputToken) fail('the input token cannot be a BAG asset in a recurring purchase (no kept share in this version).');
    const limit = Object.entries(input.maxPriceRaw).find(([k]) => k.toLowerCase() === asset)?.[1];
    if (typeof limit !== 'bigint' || limit <= BigInt(0) || limit >= MAX_UINT256) fail(`a finite positive maxPriceRaw is required for ${asset}.`);
    return { asset, symbol: a.symbol, weightBps: a.weightBps, decimals: a.decimals, maxPriceRaw: limit as bigint };
  });
  const compositionHash = bytes32(input.registry.compositionHash, 'registry.compositionHash');
  if (recurringCompositionHash(bag.definition.chain, assets) !== compositionHash) {
    fail('the bag.json assets do not reproduce registry.compositionHash: this document is not the registered content of that Bag version.');
  }
  if (assets.length === 0 || assets.length > RECURRING_MAX_ASSETS) fail(`a recurring purchase supports 1–${RECURRING_MAX_ASSETS} assets.`);
  if (assets.reduce((s, a) => s + a.weightBps, 0) !== 10_000) fail('weights must sum to 10000.');

  const allowedFees = [...(input.route.allowedFees ?? RECURRING_ALLOWED_FEE_TIERS)];
  if (allowedFees.length === 0 || allowedFees.some((f) => !(RECURRING_ALLOWED_FEE_TIERS as readonly number[]).includes(f))) fail('allowedFees must be a non-empty subset of 100/500/3000/10000.');

  const strategyId = input.registry.strategyId ? bytes32(input.registry.strategyId, 'registry.strategyId') : ZERO32;
  const legIn = recurringLegAmounts({ assets, schedule: { grossAmountPerRun: input.amountPerRunRaw } as RecurringAuthorization['schedule'] });
  legIn.forEach((x, i) => x <= BigInt(0) && fail(`amountPerRunRaw gives ${assets[i].asset} nothing to buy; increase the amount per run.`));
  return {
    owner,
    sourceAccount: owner,
    recipient,
    fundingKind,
    fundingContract,
    inputToken,
    bag: {
      bagId: bytes32(input.registry.bagId, 'registry.bagId'),
      bagVersion: BigInt(input.registry.bagVersion),
      compositionHash,
      definitionHash: computeDefinitionHash(bag.definition) as Hex,
      strategyId,
      strategyVersion: strategyId === ZERO32 ? 0 : Number(input.registry.strategyVersion ?? 0),
    },
    assets,
    schedule: { grossAmountPerRun: input.amountPerRunRaw, totalBudget: input.totalBudgetRaw, maxExecutions: input.runs, startsAt: input.startsAt, periodSeconds: input.periodSeconds, expiresAt },
    route: { router: addr(input.route.router, 'route.router'), swapTarget: addr(input.route.swapTarget, 'route.swapTarget'), allowedFees },
    nonce: input.nonce,
  };
}

/** The EIP-712 typed-data request shown to the owner's wallet (the SDK never signs). */
export function recurringAuthorizationTypedData(auth: RecurringAuthorization, deployment: RecurringDeployment) {
  return {
    domain: { ...RECURRING_PURCHASE_DOMAIN, chainId: deployment.chainId, verifyingContract: deployment.executor },
    types: RECURRING_AUTHORIZATION_TYPES,
    primaryType: 'Authorization' as const,
    message: auth,
  };
}

/** The authorization id: the EIP-712 digest (what the executor stores counters under). */
export function recurringAuthorizationId(auth: RecurringAuthorization, deployment: RecurringDeployment): Hex {
  return hashTypedData(recurringAuthorizationTypedData(auth, deployment));
}

/** A gasless revocation anyone can submit with `revokeBySig`. */
export function recurringRevocationTypedData(owner: string, authorizationId: string, deployment: RecurringDeployment) {
  return {
    domain: { ...RECURRING_PURCHASE_DOMAIN, chainId: deployment.chainId, verifyingContract: deployment.executor },
    types: RECURRING_REVOCATION_TYPES,
    primaryType: 'Revocation' as const,
    message: { owner: addr(owner, 'owner'), authorizationId: bytes32(authorizationId, 'authorizationId') },
  };
}

/** Per-asset input of one run, in authorization order: the bag.json v1 split (`splitByWeight`), as the executor computes it. */
export function recurringLegAmounts(auth: Pick<RecurringAuthorization, 'assets' | 'schedule'>): bigint[] {
  const split = splitByWeight(auth.schedule.grossAmountPerRun, {
    assets: auth.assets.map((a) => ({ chain: 'robinhood' as const, address: a.asset, decimals: a.decimals, weightBps: a.weightBps })),
  });
  return auth.assets.map((a) => split.get(`robinhood:${a.asset.toLowerCase()}`)!);
}

/** Minimum output per asset implied by the owner's price limits: ceil(legInput × 10^decimals / maxPriceRaw). */
export function recurringMinimumOutputs(auth: Pick<RecurringAuthorization, 'assets' | 'schedule'>): bigint[] {
  const legIn = recurringLegAmounts(auth);
  return auth.assets.map((a, i) => {
    const num = legIn[i] * BigInt(10) ** BigInt(a.decimals);
    return (num + a.maxPriceRaw - BigInt(1)) / a.maxPriceRaw;
  });
}

/** The calendar window at `timestampSeconds`, or null before the start / at or after expiry. */
export function recurringWindowAt(auth: Pick<RecurringAuthorization, 'schedule'>, timestampSeconds: bigint): bigint | null {
  const s = auth.schedule;
  if (timestampSeconds < s.startsAt || timestampSeconds >= s.expiresAt) return null;
  return (timestampSeconds - s.startsAt) / s.periodSeconds;
}

/** A composition field cannot contain the row (`:`) or list (`|`) separator, so a row list maps to one string. */
const COMPOSITION_FIELD_RE = /^[^:|]+$/;

/**
 * The Bag's registered composition, in its registered order: BagFactory / Bag `compositionHash` convention of the
 * BAG app (lib/domain/basket-protocol/version.ts, onchain.ts) — rows `chain:address:symbol:decimals:weightBps`
 * (lowercase address) sorted by symbol. Symbols come from the document's metadata; null when one is missing.
 */
export function recurringRegisteredAssets(bag: BagDocument): { chain: string; asset: Hex; symbol: string; decimals: number; weightBps: number }[] | null {
  const symbols = new Map((bag.metadata?.assets ?? []).map((m) => [m.address.toLowerCase(), m.symbol]));
  const rows = [];
  for (const a of bag.definition.assets) {
    const symbol = symbols.get(a.address.toLowerCase());
    if (!symbol) return null;
    rows.push({ chain: a.chain as string, asset: a.address.toLowerCase() as Hex, symbol, decimals: a.decimals, weightBps: a.weightBps });
  }
  return rows.sort((x, y) => x.symbol.localeCompare(y.symbol, 'en'));
}

/** keccak256 of the composition string of `assets` IN THE GIVEN ORDER — what the executor's `compositionHashOf` returns. */
export function recurringCompositionHash(chain: string, assets: readonly { asset: string; symbol: string; decimals: number; weightBps: number }[]): Hex {
  return keccak256(stringToHex(assets.map((a) => `${chain}:${a.asset.toLowerCase()}:${a.symbol}:${a.decimals}:${a.weightBps}`).join('|')));
}

/** The Bag's registered `compositionHash` for a bag.json (null without symbols). A verification helper; not part of bag.json v1. */
export function bagFactoryCompositionHash(bag: BagDocument): Hex | null {
  const rows = recurringRegisteredAssets(bag);
  return rows ? recurringCompositionHash(bag.definition.chain, rows) : null;
}

/** One line per field a person must see before signing. Amounts stay raw; formatting is the caller's. */
export interface RecurringSummary {
  owner: Hex;
  recipient: Hex;
  funding: 'ALLOWANCE' | 'DELEGATION';
  fundsStayInOwnerAddress: boolean;
  perRunRaw: bigint;
  runs: number;
  totalBudgetRaw: bigint;
  firstWindowStart: bigint;
  periodSeconds: bigint;
  lastWindowStart: bigint;
  expiresAt: bigint;
  assets: { asset: Hex; symbol: string; weightBps: number; legInputRaw: bigint; maxPriceRaw: bigint; minimumOutRaw: bigint }[];
  route: { router: Hex; swapTarget: Hex; allowedFees: number[] };
  bag: RecurringAuthorization['bag'];
  /**
   * The price limit is a FIXED ceiling per asset, not slippage protection against the current market price
   * (the keeper's quote − slippage is a separate, later bound). While any asset's market price is above its
   * ceiling, that window has no purchase; a skipped window is not made up later; if prices stay above until
   * expiry, the remaining runs and budget are never used.
   */
  priceLimit: { kind: 'FIXED_MAX_PRICE_PER_ASSET'; isSlippageProtection: false; windowSkippedWhileAbove: true; catchUp: false; mayEndBeforeAllRuns: true };
  /**
   * What each purchase still depends on. Composer is not used. Every run needs a BagExecutionRouter plan signed
   * by the router's planSigner (a BAG service key) and a transaction from any keeper; the router owner must keep
   * the swap target allowlisted. None of them can exceed the signed limits; each can stop or delay purchases.
   */
  dependencies: { composer: 'NOT_USED'; planSignerSignatureEachRun: true; keeperTransactionEachRun: true; routerOwnerAllowlist: true; canExceedSignedLimits: false; canStopOrDelayPurchases: true };
}

export function summarizeRecurringAuthorization(auth: RecurringAuthorization): RecurringSummary {
  const legIn = recurringLegAmounts(auth);
  const minOut = recurringMinimumOutputs(auth);
  const s = auth.schedule;
  return {
    owner: auth.owner,
    recipient: auth.recipient,
    funding: auth.fundingKind === FUNDING_KINDS.ALLOWANCE ? 'ALLOWANCE' : 'DELEGATION',
    fundsStayInOwnerAddress: auth.fundingKind === FUNDING_KINDS.ALLOWANCE,
    perRunRaw: s.grossAmountPerRun,
    runs: s.maxExecutions,
    totalBudgetRaw: s.totalBudget,
    firstWindowStart: s.startsAt,
    periodSeconds: s.periodSeconds,
    lastWindowStart: s.startsAt + s.periodSeconds * BigInt(s.maxExecutions - 1),
    expiresAt: s.expiresAt,
    assets: auth.assets.map((a, i) => ({ asset: a.asset, symbol: a.symbol, weightBps: a.weightBps, legInputRaw: legIn[i], maxPriceRaw: a.maxPriceRaw, minimumOutRaw: minOut[i] })),
    route: auth.route,
    bag: auth.bag,
    priceLimit: { kind: 'FIXED_MAX_PRICE_PER_ASSET', isSlippageProtection: false, windowSkippedWhileAbove: true, catchUp: false, mayEndBeforeAllRuns: true },
    dependencies: { composer: 'NOT_USED', planSignerSignatureEachRun: true, keeperTransactionEachRun: true, routerOwnerAllowlist: true, canExceedSignedLimits: false, canStopOrDelayPurchases: true },
  };
}

/**
 * Decodes typed data handed to a wallet back into an authorization, refusing anything that is not exactly the
 * executor's type set. A signing page shows THIS, never a separately supplied summary.
 */
export function decodeRecurringAuthorizationTypedData(typedData: unknown, deployment: RecurringDeployment): RecurringAuthorization {
  const td = typedData as { domain?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, any> };
  if (!td || typeof td !== 'object' || td.primaryType !== 'Authorization' || !td.message) fail('not an Authorization request.');
  const d = td.domain ?? {};
  if (d.name !== RECURRING_PURCHASE_DOMAIN.name || d.version !== RECURRING_PURCHASE_DOMAIN.version) fail('unexpected EIP-712 domain name/version.');
  if (Number(d.chainId) !== deployment.chainId) fail(`domain chainId ${String(d.chainId)} is not ${deployment.chainId}.`);
  if (typeof d.verifyingContract !== 'string' || d.verifyingContract.toLowerCase() !== deployment.executor.toLowerCase()) fail('domain verifyingContract is not the executor.');
  const { EIP712Domain: _domain, ...types } = (td.types ?? {}) as Record<string, unknown>;
  if (JSON.stringify(types) !== JSON.stringify(RECURRING_AUTHORIZATION_TYPES)) fail('typed data types differ from the executor type set.');
  const m = td.message!;
  const big = (x: unknown, label: string) => {
    try {
      return BigInt(x as string);
    } catch {
      return fail(`${label} is not an integer.`);
    }
  };
  return {
    owner: addr(m.owner, 'owner'),
    sourceAccount: addr(m.sourceAccount, 'sourceAccount'),
    recipient: addr(m.recipient, 'recipient'),
    fundingKind: Number(m.fundingKind),
    fundingContract: addr(m.fundingContract, 'fundingContract'),
    inputToken: addr(m.inputToken, 'inputToken'),
    bag: {
      bagId: bytes32(m.bag?.bagId, 'bag.bagId'),
      bagVersion: big(m.bag?.bagVersion, 'bag.bagVersion'),
      compositionHash: bytes32(m.bag?.compositionHash, 'bag.compositionHash'),
      definitionHash: bytes32(m.bag?.definitionHash, 'bag.definitionHash'),
      strategyId: bytes32(m.bag?.strategyId, 'bag.strategyId'),
      strategyVersion: Number(m.bag?.strategyVersion),
    },
    assets: (Array.isArray(m.assets) ? m.assets : fail('assets is not an array.')).map((a: any, i: number) => ({
      asset: addr(a?.asset, `assets[${i}].asset`),
      symbol: typeof a?.symbol === 'string' ? a.symbol : fail(`assets[${i}].symbol is not a string.`),
      weightBps: Number(a?.weightBps),
      decimals: Number(a?.decimals),
      maxPriceRaw: big(a?.maxPriceRaw, `assets[${i}].maxPriceRaw`),
    })),
    schedule: {
      grossAmountPerRun: big(m.schedule?.grossAmountPerRun, 'schedule.grossAmountPerRun'),
      totalBudget: big(m.schedule?.totalBudget, 'schedule.totalBudget'),
      maxExecutions: Number(m.schedule?.maxExecutions),
      startsAt: big(m.schedule?.startsAt, 'schedule.startsAt'),
      periodSeconds: big(m.schedule?.periodSeconds, 'schedule.periodSeconds'),
      expiresAt: big(m.schedule?.expiresAt, 'schedule.expiresAt'),
    },
    route: {
      router: addr(m.route?.router, 'route.router'),
      swapTarget: addr(m.route?.swapTarget, 'route.swapTarget'),
      allowedFees: (Array.isArray(m.route?.allowedFees) ? m.route.allowedFees : fail('route.allowedFees is not an array.')).map((f: unknown) => Number(f)),
    },
    nonce: big(m.nonce, 'nonce'),
  };
}

/** Field-by-field comparison of a decoded request with what the user chose. Empty array = identical. */
export function compareRecurringAuthorization(actual: RecurringAuthorization, expected: RecurringAuthorization): string[] {
  const issues: string[] = [];
  const walk = (a: unknown, e: unknown, path: string) => {
    if (Array.isArray(e)) {
      if (!Array.isArray(a) || a.length !== e.length) return void issues.push(`${path}: length differs`);
      e.forEach((x, i) => walk(a[i], x, `${path}[${i}]`));
    } else if (e !== null && typeof e === 'object') {
      for (const k of Object.keys(e as object)) walk((a as any)?.[k], (e as any)[k], path ? `${path}.${k}` : k);
    } else if (String(a).toLowerCase() !== String(e).toLowerCase()) {
      issues.push(`${path}: ${String(a)} ≠ ${String(e)}`);
    }
  };
  walk(actual, expected, '');
  return issues;
}

// ----------------------------------------------------------------------------- plan check

/** A BagExecutionRouter plan (structurally the `@bagprotocol/sdk/uniswap-v3` RouterExecutionPlan). */
export interface RecurringRouterPlan {
  bagId: Hex;
  executionPlanHash: Hex;
  wallet: Hex;
  inputToken: Hex;
  inputAmount: bigint;
  deadline: bigint;
  legs: readonly { target: Hex; callData: Hex; value: bigint; approveToken: Hex; approveAmount: bigint }[];
  minOutputs: readonly { token: Hex; minAmountOut: bigint }[];
}

/** The `PurchaseExecution` the executor receives. */
export interface RecurringExecution {
  authorizationId: Hex;
  window: bigint;
  quoteDeadline: bigint;
  plan: RecurringRouterPlan;
  planSignature: Hex;
}

const EXACT_INPUT_SINGLE_SELECTOR = '0x04e45aaf';
const EXACT_INPUT_SINGLE_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  },
] as const;
const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The executor's plan check (`_checkPlan`), off chain: every way a router plan leaves the signed authorization,
 * with the executor's error and code. Empty = the executor accepts the plan's shape and minimums.
 */
export function checkRecurringPlan(auth: RecurringAuthorization, plan: RecurringRouterPlan, deployment: RecurringDeployment): string[] {
  const issues: string[] = [];
  if (!eqAddr(plan.wallet, deployment.executor)) issues.push('PlanMismatch(1): wallet is not the executor');
  if (!eqAddr(plan.inputToken, auth.inputToken)) issues.push('PlanMismatch(2): input token');
  if (plan.inputAmount !== auth.schedule.grossAmountPerRun) issues.push('PlanMismatch(3): input amount is not one run');
  if (plan.bagId.toLowerCase() !== auth.bag.bagId.toLowerCase()) issues.push('PlanMismatch(4): another bagId');
  if (plan.legs.length !== auth.assets.length || plan.minOutputs.length !== auth.assets.length) return [...issues, 'PlanMismatch(5): leg or minimum count'];
  const legIn = recurringLegAmounts(auth);
  const floors = recurringMinimumOutputs(auth);
  plan.legs.forEach((leg, i) => {
    const bad = (code: number, what: string) => issues.push(`RouteViolation(${i},${code}): ${what}`);
    if (!eqAddr(leg.target, auth.route.swapTarget)) bad(1, 'target is not the signed swap target');
    if (leg.value !== BigInt(0)) bad(2, 'native value');
    if (!eqAddr(leg.approveToken, auth.inputToken) || leg.approveAmount !== legIn[i]) bad(3, 'approval is not exactly this leg');
    const data = leg.callData.toLowerCase();
    if (data.length !== 2 + 2 * (4 + 7 * 32) || !data.startsWith(EXACT_INPUT_SINGLE_SELECTOR)) bad(4, 'not SwapRouter02 exactInputSingle');
    else {
      const [p] = decodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, `0x${data.slice(10)}` as Hex);
      if (!eqAddr(p.tokenIn, auth.inputToken) || !eqAddr(p.tokenOut, auth.assets[i].asset)) bad(5, 'token in/out');
      if (!eqAddr(p.recipient, auth.route.router)) bad(6, 'swap output does not go to the router');
      if (p.amountIn !== legIn[i]) bad(7, 'leg amount');
      if (p.sqrtPriceLimitX96 !== BigInt(0)) bad(8, 'price limit (partial fill)');
      if (!auth.route.allowedFees.includes(p.fee)) bad(9, 'fee tier not signed');
    }
    if (!eqAddr(plan.minOutputs[i].token, auth.assets[i].asset)) bad(10, 'minimum for another token');
    if (plan.minOutputs[i].minAmountOut < floors[i]) bad(11, "minimum below the owner's price limit");
  });
  return issues;
}

// ----------------------------------------------------------------------------- purchase verification

const PLAN_PARAM = (() => {
  const execute = RECURRING_EXECUTOR_ABI.find((x) => x.type === 'function' && x.name === 'execute') as { inputs: readonly { components?: readonly { name?: string }[] }[] };
  return execute.inputs[1].components!.find((c) => c.name === 'plan')!;
})();
/** The executor's `executionHash` of a plan: keccak256(abi.encode(plan)). */
export function recurringExecutionHash(plan: RecurringRouterPlan): Hex {
  return keccak256(encodeAbiParameters([PLAN_PARAM] as never, [plan] as never));
}

const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'));
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** What the keeper prepared and planSigner signed BEFORE sending; the mined call must be exactly this. */
export interface RecurringPurchaseIntent {
  execution: RecurringExecution;
  ownerSignature: Hex;
  /** `0x` when no permit is attached. */
  fundingProof: Hex;
}

export type RecurringVerificationIssueCode =
  | 'RPC_CHAIN_MISMATCH' | 'NOT_MINED' | 'RPC_ERROR' | 'MALFORMED_RPC_RESPONSE' | 'TRANSACTION_HASH_MISMATCH'
  | 'NON_CANONICAL_RECEIPT' | 'INSUFFICIENT_CONFIRMATIONS' | 'TRANSACTION_REVERTED'
  | 'NOT_EXECUTOR_TX' | 'CALL_MISMATCH' | 'CALL_NOT_EXECUTE' | 'AUTHORIZATION_MISMATCH' | 'PLAN_OUTSIDE_AUTHORIZATION'
  | 'INVALID_RECEIPT_LOGS' | 'EVENT_MISSING' | 'EXECUTION_HASH_MISMATCH' | 'WINDOW_MISMATCH' | 'GROSS_MISMATCH'
  | 'BALANCE_EVIDENCE_UNAVAILABLE' | 'INVALID_BALANCE_EVIDENCE' | 'SOURCE_DEBIT_MISMATCH' | 'SOURCE_BALANCE_BELOW_RUN'
  | 'BELOW_PRICE_LIMIT' | 'BELOW_PLAN_MINIMUM' | 'TRANSIT_BALANCE' | 'LOG_BALANCE_MISMATCH';

export interface RecurringPurchaseVerification {
  status: 'VERIFIED' | 'FAILED' | 'INDETERMINATE';
  /** BALANCE deltas are the default; the event-only mode must be requested and is labelled. */
  evidence: 'TRANSACTION_AND_BALANCE_DELTAS' | 'TRANSACTION_AND_TRANSFER_LOGS';
  /** PREPARED_INTENT: the mined calldata equals the prepared call byte for byte. DECODED_CALL: no intent was given;
   *  the mined call was decoded and checked against the authorization (weaker: proves what ran, not what was planned). */
  transactionBinding: 'PREPARED_INTENT' | 'DECODED_CALL' | null;
  balanceScope: PurchaseBalanceEvidence['scope'] | null;
  authorizationId: Hex;
  window: bigint | null;
  executionIndex: bigint | null;
  blockNumber: bigint | null;
  confirmations: bigint;
  source: { account: Hex; token: Hex; beforeRaw: bigint | null; afterRaw: bigint | null; debitRaw: bigint } | null;
  deliveries: { asset: Hex; minimumRaw: bigint; priceLimitFloorRaw: bigint; receivedRaw: bigint; logReceivedRaw: bigint; balanceBeforeRaw: bigint | null; balanceAfterRaw: bigint | null }[];
  transit: { account: Hex; token: Hex; netRaw: bigint }[];
  issues: { code: RecurringVerificationIssueCode; detail: string }[];
}

/**
 * Verifies one executor purchase from the chain, with the same evidence rules as `verifyPurchaseReceipt`:
 * the mined call is bound to the PREPARED intent (exact calldata) when one is given, the receipt is canonical and
 * deep enough, the executor emitted exactly one `PurchaseExecuted` for this authorization with the planned
 * window and execution hash, and — by default — transaction-scoped balance reads (the client's
 * `getPurchaseBalanceChanges`, e.g. `withReceiptEvidence` from `@bagprotocol/sdk/evm`) show the source debited
 * exactly one run, every asset delivered to the recipient at or above max(owner price limit, plan minimum), and
 * nothing left with the executor or the router. Event-only evidence must be requested (`TRANSFER_LOGS`).
 * No polling, signing or submission.
 */
export async function verifyRecurringPurchase(params: {
  client: PurchaseReceiptClient;
  transactionHash: Hex;
  auth: RecurringAuthorization;
  deployment: RecurringDeployment;
  intent?: RecurringPurchaseIntent;
  confirmations?: number;
  verification?: 'BALANCE_DELTA' | 'TRANSFER_LOGS';
}): Promise<RecurringPurchaseVerification> {
  const { client, transactionHash, auth, deployment, intent } = params;
  if (!HASH_RE.test(transactionHash)) throw new BagSdkError('INVALID_ARGUMENT', 'verifyRecurringPurchase: invalid transaction hash.');
  const depth = params.confirmations ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 1) throw new BagSdkError('INVALID_ARGUMENT', 'verifyRecurringPurchase: confirmations must be a positive safe integer.');
  if (params.verification !== undefined && params.verification !== 'BALANCE_DELTA' && params.verification !== 'TRANSFER_LOGS') {
    throw new BagSdkError('INVALID_ARGUMENT', 'verifyRecurringPurchase: unknown verification mode.');
  }
  const balanceMode = params.verification !== 'TRANSFER_LOGS';
  const id = recurringAuthorizationId(auth, deployment);
  const executor = deployment.executor.toLowerCase() as Hex;
  const router = auth.route.router.toLowerCase() as Hex;
  const result: RecurringPurchaseVerification = {
    status: 'INDETERMINATE', evidence: balanceMode ? 'TRANSACTION_AND_BALANCE_DELTAS' : 'TRANSACTION_AND_TRANSFER_LOGS', transactionBinding: null, balanceScope: null,
    authorizationId: id, window: null, executionIndex: null, blockNumber: null, confirmations: BigInt(0), source: null, deliveries: [], transit: [], issues: [],
  };
  const stop = (status: RecurringPurchaseVerification['status'], code: RecurringVerificationIssueCode, detail: string) => {
    result.status = status;
    result.issues.push({ code, detail });
    return result;
  };
  if (intent && intent.execution.authorizationId.toLowerCase() !== id.toLowerCase()) {
    return stop('FAILED', 'AUTHORIZATION_MISMATCH', 'the prepared execution names another authorization id');
  }
  try {
    if ((await client.getChainId()) !== deployment.chainId) return stop('FAILED', 'RPC_CHAIN_MISMATCH', 'RPC chain is not the deployment chain');
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash: transactionHash }), client.getTransactionReceipt({ hash: transactionHash })]);
    if (!tx || !receipt) return stop('INDETERMINATE', 'NOT_MINED', 'transaction or receipt is not available');
    if (!eqAddr(tx.hash, transactionHash) || !eqAddr(receipt.transactionHash, transactionHash)) return stop('FAILED', 'TRANSACTION_HASH_MISMATCH', 'RPC returned another transaction');
    if (typeof receipt.blockNumber !== 'bigint' || !HASH_RE.test(receipt.blockHash) || !Array.isArray(receipt.logs) || typeof tx.input !== 'string' || typeof tx.value !== 'bigint') {
      return stop('INDETERMINATE', 'MALFORMED_RPC_RESPONSE', 'invalid mined transaction fields');
    }
    result.blockNumber = receipt.blockNumber;

    // ---- the call: exactly the prepared one, or (no intent) a decoded execute for this authorization
    if (!eqAddr(tx.to ?? '', executor)) return stop('FAILED', 'NOT_EXECUTOR_TX', `sent to ${tx.to}`);
    if (tx.value !== BigInt(0)) return stop('FAILED', 'CALL_MISMATCH', 'native value sent with the purchase');
    let execution: RecurringExecution;
    if (intent) {
      const expected = encodeFunctionData({ abi: RECURRING_EXECUTOR_ABI, functionName: 'execute', args: [auth, intent.execution, intent.ownerSignature, intent.fundingProof] as never });
      if (tx.input.toLowerCase() !== expected.toLowerCase()) return stop('FAILED', 'CALL_MISMATCH', 'the mined calldata is not the prepared execute call');
      execution = intent.execution;
      result.transactionBinding = 'PREPARED_INTENT';
    } else {
      let decoded;
      try { decoded = decodeFunctionData({ abi: RECURRING_EXECUTOR_ABI, data: tx.input as Hex }); } catch { return stop('FAILED', 'CALL_NOT_EXECUTE', 'the transaction is not an executor call'); }
      if (decoded.functionName !== 'execute') return stop('FAILED', 'CALL_NOT_EXECUTE', `the transaction calls ${decoded.functionName}`);
      const [calledAuth, calledExecution] = decoded.args as unknown as [RecurringAuthorization, RecurringExecution];
      if (recurringAuthorizationId(calledAuth, deployment).toLowerCase() !== id.toLowerCase() || calledExecution.authorizationId.toLowerCase() !== id.toLowerCase()) {
        return stop('FAILED', 'AUTHORIZATION_MISMATCH', 'the mined call executes another authorization');
      }
      execution = calledExecution;
      result.transactionBinding = 'DECODED_CALL';
    }
    const planIssues = checkRecurringPlan(auth, execution.plan, deployment);
    if (planIssues.length) return stop('FAILED', 'PLAN_OUTSIDE_AUTHORIZATION', planIssues.join('; '));

    // ---- inclusion
    if (!eqAddr(tx.blockHash ?? '', receipt.blockHash) || tx.blockNumber !== receipt.blockNumber) return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'transaction and receipt inclusion differ');
    const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
    if (!eqAddr(block?.hash ?? '', receipt.blockHash) || typeof head !== 'bigint' || head < receipt.blockNumber) return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'receipt is not on the observed canonical chain');
    result.confirmations = head - receipt.blockNumber + BigInt(1);
    if (result.confirmations < BigInt(depth)) return stop('INDETERMINATE', 'INSUFFICIENT_CONFIRMATIONS', 'required depth not reached');
    if (receipt.status === 'reverted') return stop('FAILED', 'TRANSACTION_REVERTED', 'the purchase reverted; nothing was bought or consumed');
    if (receipt.status !== 'success') return stop('INDETERMINATE', 'MALFORMED_RPC_RESPONSE', 'unknown receipt status');

    // ---- the executor's event and the Transfer logs
    const events = [];
    const transfers: { token: string; from: string; to: string; value: bigint }[] = [];
    const seen = new Set<number>();
    for (const log of receipt.logs) {
      if (!log || log.removed || log.logIndex === null || seen.has(log.logIndex) || !eqAddr(log.transactionHash ?? '', transactionHash) || !eqAddr(log.blockHash ?? '', receipt.blockHash)) {
        return stop('INDETERMINATE', 'INVALID_RECEIPT_LOGS', 'duplicate, removed or differently bound log');
      }
      seen.add(log.logIndex);
      if (eqAddr(log.address, executor)) {
        try { const e = decodeEventLog({ abi: RECURRING_EXECUTOR_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }); if (e.eventName === 'PurchaseExecuted') events.push(e.args); } catch { /* not an executor event */ }
      }
      if (log.topics[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length === 3) {
        transfers.push({ token: log.address.toLowerCase(), from: `0x${log.topics[1].slice(-40)}`.toLowerCase(), to: `0x${log.topics[2].slice(-40)}`.toLowerCase(), value: BigInt(log.data) });
      }
    }
    const mine = events.filter((e) => e.authorizationId.toLowerCase() === id.toLowerCase() && eqAddr(e.owner, auth.owner));
    if (mine.length !== 1) return stop('FAILED', 'EVENT_MISSING', `${mine.length} PurchaseExecuted events for this authorization`);
    const ev = mine[0];
    result.window = ev.window;
    result.executionIndex = ev.executionIndex;
    if (ev.executionHash.toLowerCase() !== recurringExecutionHash(execution.plan).toLowerCase()) return stop('FAILED', 'EXECUTION_HASH_MISMATCH', 'the event is for another plan');
    if (ev.window !== execution.window) return stop('FAILED', 'WINDOW_MISMATCH', `event window ${ev.window}, planned ${execution.window}`);
    if (ev.grossAmount !== auth.schedule.grossAmountPerRun || ev.sourceDebit !== auth.schedule.grossAmountPerRun) return stop('FAILED', 'GROSS_MISMATCH', 'event amounts are not one run');

    const net = (token: string, who: string) => transfers.filter((t) => t.token === token.toLowerCase())
      .reduce((s, t) => s + (t.to === who.toLowerCase() ? t.value : BigInt(0)) - (t.from === who.toLowerCase() ? t.value : BigInt(0)), BigInt(0));
    const floors = recurringMinimumOutputs(auth);
    const tokens = [auth.inputToken.toLowerCase() as Hex, ...auth.assets.map((a) => a.asset.toLowerCase() as Hex)];
    const logDebit = -net(auth.inputToken, auth.sourceAccount);
    result.source = { account: auth.sourceAccount, token: auth.inputToken, beforeRaw: null, afterRaw: null, debitRaw: logDebit };
    result.deliveries = auth.assets.map((a, i) => {
      const logReceivedRaw = transfers.filter((t) => t.token === a.asset.toLowerCase() && t.from === executor && t.to === auth.recipient.toLowerCase()).reduce((s, t) => s + t.value, BigInt(0));
      const planMin = execution.plan.minOutputs[i].minAmountOut;
      return { asset: a.asset, priceLimitFloorRaw: floors[i], minimumRaw: planMin > floors[i] ? planMin : floors[i], receivedRaw: logReceivedRaw, logReceivedRaw, balanceBeforeRaw: null, balanceAfterRaw: null };
    });
    result.transit = [executor, router].flatMap((account) => tokens.map((token) => ({ account, token, netRaw: net(token, account) })));

    // ---- transaction-scoped balances (default)
    if (balanceMode) {
      if (!client.getPurchaseBalanceChanges) return stop('INDETERMINATE', 'BALANCE_EVIDENCE_UNAVAILABLE', 'transaction-scoped balance reads are required; event-only verification must be requested');
      const reads = new Map<string, Set<Hex>>();
      const want = (account: string, list: Hex[]) => { const k = account.toLowerCase(); const set = reads.get(k) ?? new Set<Hex>(); list.forEach((t) => set.add(t)); reads.set(k, set); };
      want(auth.sourceAccount, [tokens[0]]);
      want(auth.recipient, tokens.slice(1));
      want(executor, tokens);
      want(router, tokens);
      const balances = new Map<string, { beforeRaw: bigint; afterRaw: bigint }>();
      for (const [account, set] of reads) {
        const list = [...set];
        let proof: PurchaseBalanceEvidence;
        try { proof = await client.getPurchaseBalanceChanges({ transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, owner: account as Hex, tokens: list }); }
        catch { return stop('INDETERMINATE', 'BALANCE_EVIDENCE_UNAVAILABLE', `transaction-scoped balances of ${account} are unavailable`); }
        if (!proof || !eqAddr(proof.transactionHash, transactionHash) || !eqAddr(proof.blockHash, receipt.blockHash) || proof.blockNumber !== receipt.blockNumber || !eqAddr(proof.owner, account) ||
            !['TRANSACTION', 'SINGLE_TRANSACTION_BLOCK'].includes(proof.scope) || !Array.isArray(proof.balances) || proof.balances.length !== list.length) {
          return stop('INDETERMINATE', 'INVALID_BALANCE_EVIDENCE', `balance evidence for ${account} has another transaction, block, account or token set`);
        }
        if (result.balanceScope && result.balanceScope !== proof.scope) return stop('INDETERMINATE', 'INVALID_BALANCE_EVIDENCE', 'mixed balance scopes');
        result.balanceScope = proof.scope;
        for (const b of proof.balances) {
          const token = String(b?.token ?? '').toLowerCase();
          if (!list.includes(token as Hex) || balances.has(`${account}:${token}`) || typeof b.beforeRaw !== 'bigint' || typeof b.afterRaw !== 'bigint' || b.beforeRaw < BigInt(0) || b.afterRaw < BigInt(0)) {
            return stop('INDETERMINATE', 'INVALID_BALANCE_EVIDENCE', `invalid balance entry for ${account}`);
          }
          balances.set(`${account}:${token}`, { beforeRaw: b.beforeRaw, afterRaw: b.afterRaw });
        }
      }
      const of = (account: string, token: string) => balances.get(`${account.toLowerCase()}:${token.toLowerCase()}`)!;
      const src = of(auth.sourceAccount, auth.inputToken);
      result.source = { account: auth.sourceAccount, token: auth.inputToken, beforeRaw: src.beforeRaw, afterRaw: src.afterRaw, debitRaw: src.beforeRaw - src.afterRaw };
      result.deliveries = result.deliveries.map((d) => { const b = of(auth.recipient, d.asset); return { ...d, receivedRaw: b.afterRaw - b.beforeRaw, balanceBeforeRaw: b.beforeRaw, balanceAfterRaw: b.afterRaw }; });
      result.transit = [executor, router].flatMap((account) => tokens.map((token) => { const b = of(account, token); return { account, token, netRaw: b.afterRaw - b.beforeRaw }; }));
      if (src.beforeRaw < auth.schedule.grossAmountPerRun) result.issues.push({ code: 'SOURCE_BALANCE_BELOW_RUN', detail: `source held ${src.beforeRaw} before the purchase` });
      for (const d of result.deliveries) if (d.receivedRaw !== d.logReceivedRaw) result.issues.push({ code: 'LOG_BALANCE_MISMATCH', detail: `${d.asset}: balance delta ${d.receivedRaw}, Transfer logs ${d.logReceivedRaw}` });
    }
    if (result.source.debitRaw !== auth.schedule.grossAmountPerRun) result.issues.push({ code: 'SOURCE_DEBIT_MISMATCH', detail: `source debit ${result.source.debitRaw}, one run is ${auth.schedule.grossAmountPerRun}` });
    for (const d of result.deliveries) {
      if (d.receivedRaw < d.priceLimitFloorRaw) result.issues.push({ code: 'BELOW_PRICE_LIMIT', detail: `${d.asset}: ${d.receivedRaw} < owner limit ${d.priceLimitFloorRaw}` });
      else if (d.receivedRaw < d.minimumRaw) result.issues.push({ code: 'BELOW_PLAN_MINIMUM', detail: `${d.asset}: ${d.receivedRaw} < plan minimum ${d.minimumRaw}` });
    }
    for (const t of result.transit) if (t.netRaw !== BigInt(0)) result.issues.push({ code: 'TRANSIT_BALANCE', detail: `${t.account} changed by ${t.netRaw} of ${t.token}` });
    if (result.issues.length) { result.status = 'FAILED'; return result; }

    const [finalBlock, finalReceipt] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransactionReceipt({ hash: transactionHash })]);
    if (!eqAddr(finalBlock?.hash ?? '', receipt.blockHash) || !finalReceipt || !eqAddr(finalReceipt.blockHash, receipt.blockHash) || finalReceipt.status !== 'success') {
      return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'canonical inclusion changed while evidence was collected');
    }
    result.status = 'VERIFIED';
    return result;
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
    if (name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError') return stop('INDETERMINATE', 'NOT_MINED', 'transaction or receipt is not available');
    return stop('INDETERMINATE', 'RPC_ERROR', 'a read failed; verification is incomplete');
  }
}

/** Chain id of a v1 bag document's chain (re-exported for callers building a deployment). */
export function recurringChainIdOf(bag: BagDocument): number {
  return chainIdOf(bag.definition.chain);
}
