import { decodeEventLog, hashTypedData, keccak256, parseAbi, stringToHex } from 'viem';
import { isNativeToken, normalizeAddress } from './chains';
import { computeDefinitionHash } from './definition';
import { BagSdkError } from './errors';
import { resolveV1Rules } from './rules';
import { splitByWeight } from './split';
import type { BagDocument, Hex } from './types';
import { validateBag } from './validate';

// -----------------------------------------------------------------------------
// Automated DCA v1 (contracts/dca/BagDcaExecutor.sol + UniswapV3ExactInAdapter).
// Pure helpers and a read-only receipt verifier: the SDK never signs, sends or
// stores anything.
//
// The owner signs ONE EIP-712 `DcaAuthorization` (domain BagDcaExecutor/1,
// chain id + executor). Its id is the EIP-712 digest. The executor enforces
// every field on chain; these helpers build the same object from a bag.json,
// compute what the contract computes (split, ceiling minimums, calendar) and
// verify a run from the executor's own `AssetDelivered` events.
// -----------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const ZERO = BigInt(0);
const ONE = BigInt(1);

export const DCA_DOMAIN = Object.freeze({ name: 'BagDcaExecutor', version: '1' });
export const DCA_ALLOWED_FEE_TIERS = Object.freeze([100, 500, 3000, 10000] as const);
export const DCA_MAX_ASSETS = 10;
export const DCA_MAX_DECIMALS = 36;

export const DCA_AUTHORIZATION_TYPES = {
  DcaAuthorization: [
    { name: 'owner', type: 'address' },
    { name: 'recipient', type: 'address' },
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
    { name: 'adapter', type: 'address' },
    { name: 'swapRouter', type: 'address' },
    { name: 'allowedFees', type: 'uint24[]' },
  ],
  Schedule: [
    { name: 'amountPerRun', type: 'uint256' },
    { name: 'totalBudget', type: 'uint256' },
    { name: 'maxRuns', type: 'uint32' },
    { name: 'startsAt', type: 'uint64' },
    { name: 'periodSeconds', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export const DCA_REVOCATION_TYPES = {
  Revocation: [
    { name: 'owner', type: 'address' },
    { name: 'authorizationId', type: 'bytes32' },
  ],
} as const;

/** BagDcaExecutor ABI: what a keeper, wallet or verifier needs. contracts/test/BagDcaParity.test.ts checks it against the build. */
export const DCA_EXECUTOR_ABI = parseAbi([
  'struct BagRef { bytes32 bagId; uint256 bagVersion; bytes32 compositionHash; bytes32 definitionHash; bytes32 strategyId; uint32 strategyVersion; }',
  'struct AssetLimit { address asset; string symbol; uint16 weightBps; uint8 decimals; uint256 maxPriceRaw; }',
  'struct Schedule { uint256 amountPerRun; uint256 totalBudget; uint32 maxRuns; uint64 startsAt; uint64 periodSeconds; uint64 expiresAt; }',
  'struct Route { address adapter; address swapRouter; uint24[] allowedFees; }',
  'struct DcaAuthorization { address owner; address recipient; address inputToken; BagRef bag; AssetLimit[] assets; Schedule schedule; Route route; uint256 nonce; }',
  'struct RunParams { bytes32 authorizationId; uint64 window; uint64 deadline; uint24[] fees; uint256[] minOutFloors; }',
  'struct RunState { uint32 runs; uint256 spent; uint64 lastWindow; uint64 lastRunAt; bool revoked; }',
  'function execute(DcaAuthorization a, RunParams r, bytes ownerSignature) returns (uint256 executionIndex)',
  'function revoke(bytes32 authorizationId)',
  'function revokeBySig(address owner, bytes32 authorizationId, bytes signature)',
  'function getState(address owner, bytes32 authorizationId) view returns (RunState)',
  'function authorizationIdOf(DcaAuthorization a) view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',
  'function chainLabel() view returns (string)',
  'function adapter() view returns (address)',
  'function swapRouter() view returns (address)',
  'function bagFactory() view returns (address)',
  'function strategyRegistry() view returns (address)',
  'function compositionHashOf(AssetLimit[] assets) view returns (bytes32)',
  'function legAmounts(uint256 amount, AssetLimit[] assets) pure returns (uint256[])',
  'function ceilingMinimums(uint256 amount, AssetLimit[] assets) pure returns (uint256[])',
  'event AssetDelivered(address indexed owner, bytes32 indexed authorizationId, uint256 indexed executionIndex, address recipient, address token, uint256 balanceBefore, uint256 balanceAfter, uint256 minReceived)',
  'event PurchaseExecuted(address indexed owner, bytes32 indexed authorizationId, uint256 indexed executionIndex, uint256 window, address recipient, uint256 amountIn, uint256 assetCount)',
  'event AuthorizationRevoked(address indexed owner, bytes32 indexed authorizationId)',
  'error ZeroAddress()',
  'error InvalidChainLabel()',
  'error AuthorizationMismatch(bytes32 expected, bytes32 given)',
  'error InvalidOwnerSignature()',
  'error RevokedAuthorization(bytes32 authorizationId)',
  'error InvalidTerms(uint256 code)',
  'error UnknownBag(bytes32 bagId)',
  'error BagChanged(uint256 version, bytes32 compositionHash)',
  'error CompositionMismatch(bytes32 signedList, bytes32 registered)',
  'error StrategyNotRegistered(bytes32 strategyId, uint32 version)',
  'error AssetDecimalsMismatch(address asset, uint8 signed, uint256 actual)',
  'error NotDue()',
  'error Expired()',
  'error RunDeadlinePassed(uint256 deadline)',
  'error WrongWindow(uint256 current, uint256 planned)',
  'error Exhausted()',
  'error BudgetExceeded()',
  'error BadRunParams(uint256 code)',
  'error FeeNotAllowed(uint256 leg, uint24 fee)',
  'error LegTooSmall(uint256 leg)',
  'error FundingMismatch(uint256 ownerDebit, uint256 received)',
  'error AdapterAllowanceLeft(uint256 leg, uint256 left)',
  'error DeliveryBelowMinimum(address asset, uint256 received, uint256 minimum)',
  'error InputLeftover(uint256 left)',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
]);

/** UniswapV3ExactInAdapter errors (they bubble up through `execute`). */
export const DCA_ADAPTER_ABI = parseAbi([
  'function swapRouter() view returns (address)',
  'function poolFactory() view returns (address)',
  'error InvalidSwap(uint256 code)',
  'error UnsupportedFee(uint24 fee)',
  'error PoolNotFound(address tokenIn, address tokenOut, uint24 fee)',
  'error InputTransferMismatch(uint256 received, uint256 expected)',
  'error InputNotFullySpent(uint256 left)',
  'error OutputMismatch(uint256 measured, uint256 reported)',
  'error OutputBelowMinimum(uint256 measured, uint256 minimum)',
  'error ApprovalNotReset(uint256 left)',
]);

export interface DcaAssetLimit {
  asset: Hex;
  /** The symbol in the Bag's registered composition row. */
  symbol: string;
  weightBps: number;
  decimals: number;
  /** Most input-token raw units the owner pays for ONE whole token. A ceiling, not a fair price. */
  maxPriceRaw: bigint;
}

export interface DcaAuthorization {
  owner: Hex;
  recipient: Hex;
  inputToken: Hex;
  bag: { bagId: Hex; bagVersion: bigint; compositionHash: Hex; definitionHash: Hex; strategyId: Hex; strategyVersion: number };
  assets: DcaAssetLimit[];
  schedule: { amountPerRun: bigint; totalBudget: bigint; maxRuns: number; startsAt: bigint; periodSeconds: bigint; expiresAt: bigint };
  route: { adapter: Hex; swapRouter: Hex; allowedFees: number[] };
  nonce: bigint;
}

/** Where an authorization is valid: the EIP-712 domain. */
export interface DcaDeployment {
  chainId: number;
  executor: Hex;
}

/** `getState(owner, id)`. */
export interface DcaRunState {
  runs: number;
  spent: bigint;
  lastWindow: bigint;
  lastRunAt: bigint;
  revoked: boolean;
}

const fail = (message: string): never => {
  throw new BagSdkError('DCA_TERMS_INVALID', message);
};
const addr = (value: string, label: string): Hex => {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) fail(`${label} is not an address.`);
  return normalizeAddress(value) as Hex;
};
const bytes32 = (value: string, label: string): Hex => {
  if (typeof value !== 'string' || !BYTES32_RE.test(value)) fail(`${label} is not a bytes32.`);
  return value.toLowerCase() as Hex;
};
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ----------------------------------------------------------------- typed data

export function dcaAuthorizationTypedData(auth: DcaAuthorization, deployment: DcaDeployment) {
  return {
    domain: { ...DCA_DOMAIN, chainId: deployment.chainId, verifyingContract: deployment.executor },
    types: DCA_AUTHORIZATION_TYPES,
    primaryType: 'DcaAuthorization' as const,
    message: auth,
  };
}

/** The authorization id: the EIP-712 digest the owner signs and the executor stores counters under. */
export function dcaAuthorizationId(auth: DcaAuthorization, deployment: DcaDeployment): Hex {
  return hashTypedData(dcaAuthorizationTypedData(auth, deployment));
}

/** A gasless revocation anyone can submit with `revokeBySig`. */
export function dcaRevocationTypedData(owner: string, authorizationId: string, deployment: DcaDeployment) {
  return {
    domain: { ...DCA_DOMAIN, chainId: deployment.chainId, verifyingContract: deployment.executor },
    types: DCA_REVOCATION_TYPES,
    primaryType: 'Revocation' as const,
    message: { owner: addr(owner, 'owner'), authorizationId: bytes32(authorizationId, 'authorizationId') },
  };
}

// ----------------------------------------------------------------- the contract's arithmetic

/** Per-asset input of one run, in authorization order: the bag.json v1 split, as the executor computes it. */
export function dcaLegAmounts(auth: Pick<DcaAuthorization, 'assets' | 'schedule'>): bigint[] {
  const split = splitByWeight(auth.schedule.amountPerRun, {
    assets: auth.assets.map((a) => ({ chain: 'robinhood' as const, address: a.asset, decimals: a.decimals, weightBps: a.weightBps })),
  });
  return auth.assets.map((a) => split.get(`robinhood:${a.asset.toLowerCase()}`)!);
}

/** The owner's minimum per asset: ceil(leg × 10^decimals / maxPriceRaw). The executor uses max(this, keeper floor). */
export function dcaCeilingMinimums(auth: Pick<DcaAuthorization, 'assets' | 'schedule'>): bigint[] {
  const legs = dcaLegAmounts(auth);
  return auth.assets.map((a, i) => {
    if (a.maxPriceRaw <= ZERO) fail(`maxPriceRaw of ${a.asset} must be positive.`);
    const num = legs[i] * BigInt(10) ** BigInt(a.decimals);
    return num === ZERO ? ZERO : (num - ONE) / a.maxPriceRaw + ONE;
  });
}

/** keccak256 of the composition string of `assets` IN THE GIVEN ORDER (lowercase addresses), as `compositionHashOf`. */
export function dcaCompositionHash(chain: string, assets: readonly { asset: string; symbol: string; decimals: number; weightBps: number }[]): Hex {
  return keccak256(stringToHex(assets.map((a) => `${chain}:${a.asset.toLowerCase()}:${a.symbol}:${a.decimals}:${a.weightBps}`).join('|')));
}

/** The calendar window at `t`, or null before the start / at or after expiry. */
export function dcaWindowAt(auth: Pick<DcaAuthorization, 'schedule'>, t: bigint): bigint | null {
  const s = auth.schedule;
  if (t < s.startsAt || t >= s.expiresAt) return null;
  return (t - s.startsAt) / s.periodSeconds;
}

export type DcaDueState = 'REVOKED' | 'COMPLETED' | 'EXPIRED' | 'SCHEDULED' | 'DONE_THIS_WINDOW' | 'DUE';

/**
 * Whether a run is allowed at block time `t`, by the executor's own rules (`_reserve`): inside [startsAt, expiresAt),
 * one run per window, at least one period after the previous run, runs and budget left, not revoked. Missed windows
 * are never made up. `nextDueAt` is the earliest time a later run can be allowed (null when none can).
 */
export function dcaRunDue(auth: Pick<DcaAuthorization, 'schedule'>, st: DcaRunState, t: bigint): { state: DcaDueState; window: bigint | null; nextDueAt: bigint | null } {
  const s = auth.schedule;
  if (st.revoked) return { state: 'REVOKED', window: null, nextDueAt: null };
  if (st.runs >= s.maxRuns || st.spent + s.amountPerRun > s.totalBudget) return { state: 'COMPLETED', window: null, nextDueAt: null };
  if (t >= s.expiresAt) return { state: 'EXPIRED', window: null, nextDueAt: null };
  if (t < s.startsAt) return { state: 'SCHEDULED', window: null, nextDueAt: s.startsAt };
  const window = (t - s.startsAt) / s.periodSeconds;
  if (st.runs > 0 && (window <= st.lastWindow || t < st.lastRunAt + s.periodSeconds)) {
    const nextWindowStart = s.startsAt + (st.lastWindow + ONE) * s.periodSeconds;
    const gap = st.lastRunAt + s.periodSeconds;
    const next = nextWindowStart > gap ? nextWindowStart : gap;
    return next >= s.expiresAt ? { state: 'EXPIRED', window, nextDueAt: null } : { state: 'DONE_THIS_WINDOW', window, nextDueAt: next };
  }
  return { state: 'DUE', window, nextDueAt: null };
}

// ----------------------------------------------------------------- terms

/**
 * The executor's static checks (`_checkTerms`), without the on-chain reads. Returns problems; empty = the
 * executor would not refuse the terms themselves (the BAG registry, decimals and calendar are checked on chain).
 */
export function checkDcaTerms(auth: DcaAuthorization, deployment?: { adapter?: string; swapRouter?: string; executor?: string }): string[] {
  const p: string[] = [];
  const special = [deployment?.executor, deployment?.adapter, deployment?.swapRouter, auth.route.adapter, auth.route.swapRouter].filter(Boolean).map((x) => x!.toLowerCase());
  if (/^0x0{40}$/i.test(auth.owner)) p.push('owner is zero');
  if (/^0x0{40}$/i.test(auth.recipient) || special.includes(auth.recipient.toLowerCase())) p.push('recipient is zero or a contract of the route');
  if (/^0x0{40}$/i.test(auth.inputToken) || special.includes(auth.inputToken.toLowerCase())) p.push('input token is zero or a contract of the route');
  const s = auth.schedule;
  if (s.amountPerRun <= ZERO || s.periodSeconds <= ZERO || s.maxRuns < 1 || s.startsAt <= ZERO || s.expiresAt <= s.startsAt || s.expiresAt > MAX_UINT64) p.push('schedule is invalid');
  if (s.totalBudget !== s.amountPerRun * BigInt(s.maxRuns)) p.push('totalBudget must equal amountPerRun × maxRuns');
  if (auth.assets.length === 0 || auth.assets.length > DCA_MAX_ASSETS) p.push(`1–${DCA_MAX_ASSETS} assets`);
  const seen = new Set<string>();
  let weights = 0;
  for (const a of auth.assets) {
    const k = a.asset.toLowerCase();
    if (/^0x0{40}$/.test(k) || eq(k, auth.inputToken) || eq(k, auth.recipient) || special.includes(k)) p.push(`asset ${a.asset} is not allowed`);
    if (seen.has(k)) p.push(`asset ${a.asset} is duplicated`);
    seen.add(k);
    if (!Number.isInteger(a.weightBps) || a.weightBps <= 0) p.push(`weight of ${a.asset} must be positive`);
    if (a.maxPriceRaw <= ZERO) p.push(`maxPriceRaw of ${a.asset} must be positive`);
    if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > DCA_MAX_DECIMALS) p.push(`decimals of ${a.asset} must be 0–${DCA_MAX_DECIMALS}`);
    if (!/^[^:|]+$/.test(a.symbol) || new TextEncoder().encode(a.symbol).length > 64) p.push(`symbol ${JSON.stringify(a.symbol)} cannot be a composition field`);
    weights += a.weightBps;
  }
  if (weights !== 10_000) p.push('weights must sum to 10000');
  const fees = auth.route.allowedFees;
  if (fees.length === 0 || fees.length > 4 || new Set(fees).size !== fees.length || fees.some((f) => !(DCA_ALLOWED_FEE_TIERS as readonly number[]).includes(f))) {
    p.push('allowedFees must be a non-empty, duplicate-free subset of 100/500/3000/10000');
  }
  if (deployment?.adapter && !eq(deployment.adapter, auth.route.adapter)) p.push('route.adapter is not the executor adapter');
  if (deployment?.swapRouter && !eq(deployment.swapRouter, auth.route.swapRouter)) p.push('route.swapRouter is not the adapter router');
  if (eq(auth.bag.definitionHash, ZERO32) || eq(auth.bag.compositionHash, ZERO32)) p.push('BAG hashes must be set');
  if (eq(auth.bag.strategyId, ZERO32) && auth.bag.strategyVersion !== 0) p.push('strategyVersion without strategyId');
  if (p.length === 0) {
    const legs = dcaLegAmounts(auth);
    legs.forEach((x, i) => x <= ZERO && p.push(`amountPerRun gives ${auth.assets[i].asset} nothing to buy`));
  }
  return p;
}

/** The Bag's registered composition from a bag.json: rows sorted by symbol (BAG app convention), lowercase addresses. */
export function dcaRegisteredAssets(bag: BagDocument): { asset: Hex; symbol: string; decimals: number; weightBps: number }[] | null {
  const symbols = new Map((bag.metadata?.assets ?? []).map((m) => [m.address.toLowerCase(), m.symbol]));
  const rows = [];
  for (const a of bag.definition.assets) {
    const symbol = symbols.get(a.address.toLowerCase());
    if (!symbol) return null;
    rows.push({ asset: a.address.toLowerCase() as Hex, symbol, decimals: a.decimals, weightBps: a.weightBps });
  }
  return rows.sort((x, y) => x.symbol.localeCompare(y.symbol));
}

export interface DcaTermsInput {
  bag: BagDocument;
  /** The wallet whose funds are spent and who signs (EOA, or an ERC-1271 smart account). */
  owner: string;
  /** Defaults to the owner. */
  recipient?: string;
  inputToken: string;
  /** Input token precision; required when the strategy sets a positive minInvestment (each run is one purchase). */
  inputTokenDecimals?: number;
  /** On-chain BAG identity read from BagFactory/Bag (and StrategyRegistry when registered). */
  registry: { bagId: string; bagVersion: bigint | number; compositionHash: string; strategyId?: string | null; strategyVersion?: number | null };
  amountPerRunRaw: bigint;
  runs: number;
  /** Must equal amountPerRunRaw × runs; never recomputed silently. */
  totalBudgetRaw: bigint;
  startsAt: bigint;
  periodSeconds: bigint;
  /** Defaults to startsAt + runs × periodSeconds. */
  expiresAt?: bigint;
  /** Per asset (any address case): the ceiling for one whole token, input-token raw units. */
  maxPriceRaw: Record<string, bigint>;
  route: { adapter: string; swapRouter: string; allowedFees?: readonly number[] };
  nonce: bigint;
}

/**
 * Builds the authorization a user signs. The asset list is the Bag's registered composition and must reproduce
 * `registry.compositionHash` (the executor checks the same on chain). bag.json v1 rules apply per run: valid
 * document, minInvestment, BLOCK no-route policy, no performance fee. Throws DCA_TERMS_INVALID otherwise.
 */
export function buildDcaAuthorization(input: DcaTermsInput): DcaAuthorization {
  const { bag } = input;
  const validation = validateBag(bag);
  if (!validation.valid) fail(`the bag.json is not valid: ${validation.errors.map((e) => e.code).join(', ')}.`);
  const rules = resolveV1Rules(bag.definition);
  if (rules.performanceFeeBps.value !== 0) fail('strategies with a performance fee are not supported by DCA v1.');
  if (rules.noRouteAssetPolicy.value !== 'BLOCK') fail(`noRouteAssetPolicy ${rules.noRouteAssetPolicy.value} is not supported; a DCA run buys every asset or nothing.`);
  const owner = addr(input.owner, 'owner');
  const recipient = input.recipient === undefined ? owner : addr(input.recipient, 'recipient');
  const inputToken = addr(input.inputToken, 'inputToken');
  if (isNativeToken(inputToken)) fail('the native token cannot fund a DCA; use an ERC-20 the owner approves.');
  if (!Number.isInteger(input.runs) || input.runs < 1 || input.runs > 0xffffffff) fail('runs must be a positive integer.');
  if (typeof input.amountPerRunRaw !== 'bigint' || input.amountPerRunRaw <= ZERO) fail('amountPerRunRaw must be a positive bigint.');
  const minInvestment = rules.minInvestmentAmount.value;
  if (minInvestment !== '0') {
    const d = input.inputTokenDecimals;
    if (d === undefined || !Number.isInteger(d) || d < 0 || d > 255) fail(`inputTokenDecimals is required to enforce the strategy minimum of ${minInvestment} per run.`);
    const [whole, fraction = ''] = minInvestment.split('.');
    const kept = fraction.slice(0, d).padEnd(d as number, '0');
    let raw = BigInt(whole) * BigInt(10) ** BigInt(d as number) + BigInt(kept === '' ? '0' : kept);
    if (/[1-9]/.test(fraction.slice(d))) raw += ONE;
    if (input.amountPerRunRaw < raw) fail(`amountPerRunRaw is below the strategy minimum of ${minInvestment} per purchase.`);
  }
  if (input.totalBudgetRaw !== input.amountPerRunRaw * BigInt(input.runs)) fail(`totalBudgetRaw must equal amountPerRunRaw × runs (${input.amountPerRunRaw * BigInt(input.runs)}).`);
  const expiresAt = input.expiresAt ?? input.startsAt + input.periodSeconds * BigInt(input.runs);
  const registered = dcaRegisteredAssets(bag) ?? fail('every asset needs its symbol in metadata: the Bag composition is keyed by symbol.');
  const assets: DcaAssetLimit[] = registered.map((a) => {
    const limit = Object.entries(input.maxPriceRaw).find(([k]) => k.toLowerCase() === a.asset)?.[1];
    if (typeof limit !== 'bigint' || limit <= ZERO) fail(`a positive maxPriceRaw is required for ${a.asset}.`);
    if (isNativeToken(a.asset)) fail('native-token basket assets are not supported.');
    return { asset: a.asset, symbol: a.symbol, weightBps: a.weightBps, decimals: a.decimals, maxPriceRaw: limit as bigint };
  });
  const compositionHash = bytes32(input.registry.compositionHash, 'registry.compositionHash');
  if (dcaCompositionHash(bag.definition.chain, assets) !== compositionHash) fail('the bag.json assets do not reproduce registry.compositionHash: this document is not the registered content of that Bag version.');
  const strategyId = input.registry.strategyId ? bytes32(input.registry.strategyId, 'registry.strategyId') : ZERO32;
  const auth: DcaAuthorization = {
    owner,
    recipient,
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
    schedule: { amountPerRun: input.amountPerRunRaw, totalBudget: input.totalBudgetRaw, maxRuns: input.runs, startsAt: input.startsAt, periodSeconds: input.periodSeconds, expiresAt },
    route: { adapter: addr(input.route.adapter, 'route.adapter'), swapRouter: addr(input.route.swapRouter, 'route.swapRouter'), allowedFees: [...(input.route.allowedFees ?? DCA_ALLOWED_FEE_TIERS)] },
    nonce: input.nonce,
  };
  const problems = checkDcaTerms(auth);
  if (problems.length) fail(problems.join('; '));
  return auth;
}

/** What a signing page must show. Amounts stay raw; formatting is the caller's. */
export interface DcaSummary {
  owner: Hex;
  recipient: Hex;
  /** The ERC-20 approval the owner gives: exactly the total budget; funds stay in the wallet until each run. */
  approval: { token: Hex; spender: 'EXECUTOR'; amountRaw: bigint };
  perRunRaw: bigint;
  runs: number;
  totalBudgetRaw: bigint;
  startsAt: bigint;
  periodSeconds: bigint;
  expiresAt: bigint;
  assets: { asset: Hex; symbol: string; weightBps: number; legInputRaw: bigint; maxPriceRaw: bigint; minimumOutRaw: bigint }[];
  route: DcaAuthorization['route'];
  bag: DcaAuthorization['bag'];
  priceLimit: { kind: 'CEILING_PER_ASSET'; isFairPrice: false; keeperMayExecuteUpToCeiling: true; wholeRunSkippedIfAnyAssetAbove: true; catchUp: false };
  dependencies: { composer: 'NOT_USED'; keeperTransactionEachRun: true; keeperCanExceedSignedLimits: false; keeperCanStopOrDelay: true; venue: 'UNISWAP_V3_SWAPROUTER02' };
}

export function summarizeDcaAuthorization(auth: DcaAuthorization): DcaSummary {
  const legs = dcaLegAmounts(auth);
  const mins = dcaCeilingMinimums(auth);
  const s = auth.schedule;
  return {
    owner: auth.owner,
    recipient: auth.recipient,
    approval: { token: auth.inputToken, spender: 'EXECUTOR', amountRaw: s.totalBudget },
    perRunRaw: s.amountPerRun,
    runs: s.maxRuns,
    totalBudgetRaw: s.totalBudget,
    startsAt: s.startsAt,
    periodSeconds: s.periodSeconds,
    expiresAt: s.expiresAt,
    assets: auth.assets.map((a, i) => ({ asset: a.asset, symbol: a.symbol, weightBps: a.weightBps, legInputRaw: legs[i], maxPriceRaw: a.maxPriceRaw, minimumOutRaw: mins[i] })),
    route: auth.route,
    bag: auth.bag,
    priceLimit: { kind: 'CEILING_PER_ASSET', isFairPrice: false, keeperMayExecuteUpToCeiling: true, wholeRunSkippedIfAnyAssetAbove: true, catchUp: false },
    dependencies: { composer: 'NOT_USED', keeperTransactionEachRun: true, keeperCanExceedSignedLimits: false, keeperCanStopOrDelay: true, venue: 'UNISWAP_V3_SWAPROUTER02' },
  };
}

// ----------------------------------------------------------------- receipt verification

export interface DcaReceiptLog {
  address: Hex;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
  transactionHash: Hex | null;
  blockHash: Hex | null;
  blockNumber: bigint | null;
  removed?: boolean;
}

/** Caller-owned read-only client; a viem public client satisfies it. */
export interface DcaReceiptClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ transactionHash: Hex; blockHash: Hex; blockNumber: bigint; status: 'success' | 'reverted'; logs: readonly DcaReceiptLog[] }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  /** Needed only with `expectedExecutorCodeHash`. */
  getCode?(args: { address: Hex; blockNumber?: bigint }): Promise<Hex | undefined>;
}

export type DcaReceiptIssueCode =
  | 'RPC_CHAIN_MISMATCH' | 'RPC_ERROR' | 'NOT_MINED' | 'NON_CANONICAL_RECEIPT' | 'INSUFFICIENT_CONFIRMATIONS' | 'REMOVED_LOG'
  | 'EXECUTOR_CODE_MISMATCH' | 'EXECUTOR_CODE_UNAVAILABLE'
  | 'TRANSACTION_REVERTED' | 'UNDECODABLE_EXECUTOR_LOG' | 'NO_PURCHASE_EVENT' | 'DUPLICATE_PURCHASE_EVENT' | 'EXECUTION_INDEX_MISMATCH'
  | 'PURCHASE_EVENT_MISMATCH' | 'WINDOW_MISMATCH' | 'MISSING_DELIVERY' | 'DUPLICATE_DELIVERY' | 'UNEXPECTED_DELIVERY'
  | 'DELIVERY_ORDER' | 'RECIPIENT_MISMATCH' | 'DELIVERY_BELOW_MINIMUM' | 'MINIMUM_BELOW_CEILING';

const INDETERMINATE_CODES: readonly DcaReceiptIssueCode[] = ['RPC_ERROR', 'NOT_MINED', 'NON_CANONICAL_RECEIPT', 'INSUFFICIENT_CONFIRMATIONS', 'REMOVED_LOG', 'EXECUTOR_CODE_UNAVAILABLE'];

export interface DcaDelivery {
  token: Hex;
  balanceBefore: bigint;
  balanceAfter: bigint;
  deltaRaw: bigint;
  minReceived: bigint;
  /** ceil(leg × 10^dec / maxPriceRaw) recomputed here from the signed terms. */
  ceilingMinimum: bigint;
  satisfied: boolean;
}

export interface DcaReceiptVerification {
  status: 'VERIFIED' | 'FAILED' | 'INDETERMINATE';
  /** The executor's own events; the trust root is the executor bytecode at `deployment.executor`. */
  evidence: 'EXECUTOR_EVENTS';
  executorCodeChecked: boolean;
  chainId: number | null;
  transactionHash: Hex;
  blockNumber: bigint | null;
  confirmations: bigint;
  authorizationId: Hex;
  executionIndex: bigint | null;
  window: bigint | null;
  deliveries: DcaDelivery[];
  issues: { code: DcaReceiptIssueCode; detail: string }[];
}

export interface VerifyDcaReceiptOptions {
  client: DcaReceiptClient;
  transactionHash: Hex;
  auth: DcaAuthorization;
  deployment: DcaDeployment;
  /** When given, the run must be exactly this index. */
  executionIndex?: bigint;
  /** Default 1. */
  minConfirmations?: bigint;
  /** keccak256 of the executor's runtime code (from the reviewed build). When set, the code at the block is checked. */
  expectedExecutorCodeHash?: Hex;
}

/**
 * Verifies one DCA run from its receipt. VERIFIED only when, from canonical, sufficiently confirmed evidence on the
 * deployment's chain: the transaction succeeded; the executor emitted exactly one PurchaseExecuted for this
 * (owner, authorizationId) with the signed recipient, amount and asset count, in the window of the block time; and
 * exactly one AssetDelivered per signed asset, in signed order, for that execution index, each to the signed
 * recipient, with balanceAfter − balanceBefore ≥ minReceived ≥ the ceiling minimum recomputed from the signed terms.
 * Any unexpected, duplicate or undecodable executor event for this authorization fails. Missing or unreadable
 * evidence is INDETERMINATE, never VERIFIED. Events of OTHER authorizations in the same transaction are ignored.
 */
export async function verifyDcaReceipt(o: VerifyDcaReceiptOptions): Promise<DcaReceiptVerification> {
  const { client, auth, deployment } = o;
  const executor = deployment.executor.toLowerCase();
  const id = dcaAuthorizationId(auth, deployment);
  const out: DcaReceiptVerification = {
    status: 'INDETERMINATE', evidence: 'EXECUTOR_EVENTS', executorCodeChecked: false, chainId: null, transactionHash: o.transactionHash,
    blockNumber: null, confirmations: ZERO, authorizationId: id, executionIndex: null, window: null, deliveries: [], issues: [],
  };
  const issue = (code: DcaReceiptIssueCode, detail: string) => out.issues.push({ code, detail });
  const finish = () => {
    out.status = out.issues.length === 0 ? 'VERIFIED' : out.issues.some((i) => !INDETERMINATE_CODES.includes(i.code)) ? 'FAILED' : 'INDETERMINATE';
    return out;
  };

  let receipt: Awaited<ReturnType<DcaReceiptClient['getTransactionReceipt']>>;
  try {
    out.chainId = await client.getChainId();
    if (out.chainId !== deployment.chainId) {
      issue('RPC_CHAIN_MISMATCH', `reader is on chain ${out.chainId}, the authorization is for ${deployment.chainId}`);
      return finish();
    }
    receipt = await client.getTransactionReceipt({ hash: o.transactionHash });
  } catch (e) {
    issue((e as Error)?.name === 'TransactionReceiptNotFoundError' ? 'NOT_MINED' : 'RPC_ERROR', 'receipt not available');
    return finish();
  }
  out.blockNumber = receipt.blockNumber;
  if (receipt.transactionHash.toLowerCase() !== o.transactionHash.toLowerCase()) {
    issue('RPC_ERROR', 'receipt is for another transaction');
    return finish();
  }
  let blockTime: bigint;
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) issue('NON_CANONICAL_RECEIPT', `block ${receipt.blockNumber} is not ${receipt.blockHash}`);
    blockTime = block.timestamp;
    const head = await client.getBlockNumber({ cacheTime: 0 });
    out.confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + ONE : ZERO;
    if (out.confirmations < (o.minConfirmations ?? ONE)) issue('INSUFFICIENT_CONFIRMATIONS', `${out.confirmations} < ${o.minConfirmations ?? ONE}`);
    if (o.expectedExecutorCodeHash) {
      if (!client.getCode) issue('EXECUTOR_CODE_UNAVAILABLE', 'reader has no getCode');
      else {
        const code = await client.getCode({ address: deployment.executor, blockNumber: receipt.blockNumber });
        if (!code || code === '0x') issue('EXECUTOR_CODE_MISMATCH', 'no code at the executor');
        else if (keccak256(code) !== o.expectedExecutorCodeHash.toLowerCase()) issue('EXECUTOR_CODE_MISMATCH', 'executor runtime code differs from the reviewed build');
        else out.executorCodeChecked = true;
      }
    }
  } catch {
    issue('RPC_ERROR', 'block or code not available');
    return finish();
  }
  if (receipt.status !== 'success') {
    issue('TRANSACTION_REVERTED', 'the transaction reverted; nothing was bought');
    return finish();
  }

  type Decoded = { name: 'AssetDelivered' | 'PurchaseExecuted' | 'AuthorizationRevoked'; args: any; logIndex: number };
  const mine: Decoded[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== executor) continue;
    if (log.removed) issue('REMOVED_LOG', `log ${log.logIndex} was removed (reorg)`);
    let d: { eventName: string; args: any };
    try {
      d = decodeEventLog({ abi: DCA_EXECUTOR_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }) as any;
    } catch {
      issue('UNDECODABLE_EXECUTOR_LOG', `executor log ${log.logIndex} is not a known event`);
      continue;
    }
    if (!eq(d.args.owner, auth.owner) || !eq(d.args.authorizationId, id)) continue; // another authorization's run
    mine.push({ name: d.eventName as Decoded['name'], args: d.args, logIndex: log.logIndex ?? -1 });
  }

  const purchases = mine.filter((m) => m.name === 'PurchaseExecuted');
  if (purchases.length === 0) {
    issue('NO_PURCHASE_EVENT', 'no PurchaseExecuted for this authorization in the transaction');
    return finish();
  }
  if (purchases.length > 1) issue('DUPLICATE_PURCHASE_EVENT', `${purchases.length} PurchaseExecuted for this authorization`);
  const p = purchases[0];
  out.executionIndex = p.args.executionIndex;
  out.window = p.args.window;
  if (o.executionIndex !== undefined && p.args.executionIndex !== o.executionIndex) issue('EXECUTION_INDEX_MISMATCH', `index ${p.args.executionIndex}, expected ${o.executionIndex}`);
  if (!eq(p.args.recipient, auth.recipient)) issue('RECIPIENT_MISMATCH', `purchase recipient ${p.args.recipient}`);
  if (p.args.amountIn !== auth.schedule.amountPerRun) issue('PURCHASE_EVENT_MISMATCH', `amountIn ${p.args.amountIn} ≠ ${auth.schedule.amountPerRun}`);
  if (p.args.assetCount !== BigInt(auth.assets.length)) issue('PURCHASE_EVENT_MISMATCH', `assetCount ${p.args.assetCount} ≠ ${auth.assets.length}`);
  const expectedWindow = dcaWindowAt(auth, blockTime!);
  if (expectedWindow === null || expectedWindow !== p.args.window) issue('WINDOW_MISMATCH', `event window ${p.args.window}, block time gives ${expectedWindow}`);
  if (mine.some((m) => m.name === 'AuthorizationRevoked')) issue('PURCHASE_EVENT_MISMATCH', 'revocation event in the same transaction');

  const deliveries = mine.filter((m) => m.name === 'AssetDelivered');
  const mins = dcaCeilingMinimums(auth);
  for (const d of deliveries) {
    if (d.args.executionIndex !== p.args.executionIndex) issue('EXECUTION_INDEX_MISMATCH', `AssetDelivered for index ${d.args.executionIndex}`);
    if (!auth.assets.some((a) => eq(a.asset, d.args.token))) issue('UNEXPECTED_DELIVERY', `AssetDelivered for ${d.args.token}, not a signed asset`);
    if (d.logIndex > p.logIndex) issue('DELIVERY_ORDER', `AssetDelivered ${d.args.token} after PurchaseExecuted`);
  }
  auth.assets.forEach((a, i) => {
    const hits = deliveries.filter((d) => eq(d.args.token, a.asset));
    if (hits.length === 0) return void issue('MISSING_DELIVERY', `no AssetDelivered for ${a.asset}`);
    if (hits.length > 1) issue('DUPLICATE_DELIVERY', `${hits.length} AssetDelivered for ${a.asset}`);
    const d = hits[0];
    if (deliveries.indexOf(d) !== i) issue('DELIVERY_ORDER', `${a.asset} is not delivery #${i}`);
    if (!eq(d.args.recipient, auth.recipient)) issue('RECIPIENT_MISMATCH', `${a.asset} delivered to ${d.args.recipient}`);
    const before = d.args.balanceBefore as bigint;
    const after = d.args.balanceAfter as bigint;
    const delta: bigint = after >= before ? after - before : ZERO;
    const satisfied = d.args.balanceAfter > d.args.balanceBefore && delta >= d.args.minReceived && d.args.minReceived >= mins[i];
    if (!(d.args.balanceAfter > d.args.balanceBefore) || delta < d.args.minReceived) issue('DELIVERY_BELOW_MINIMUM', `${a.asset}: +${delta} < ${d.args.minReceived}`);
    if (d.args.minReceived < mins[i]) issue('MINIMUM_BELOW_CEILING', `${a.asset}: minReceived ${d.args.minReceived} < ceiling minimum ${mins[i]}`);
    out.deliveries.push({ token: a.asset, balanceBefore: d.args.balanceBefore, balanceAfter: d.args.balanceAfter, deltaRaw: delta, minReceived: d.args.minReceived, ceilingMinimum: mins[i], satisfied });
  });
  return finish();
}

/** Runs of an authorization that the chain shows, and the windows that closed without one (never made up). */
export function dcaMissedWindows(auth: Pick<DcaAuthorization, 'schedule'>, purchasedWindows: readonly bigint[], t: bigint): bigint[] {
  const s = auth.schedule;
  if (t <= s.startsAt) return [];
  const closedThrough = t >= s.expiresAt ? (s.expiresAt - s.startsAt + s.periodSeconds - ONE) / s.periodSeconds : (t - s.startsAt) / s.periodSeconds;
  const bought = new Set(purchasedWindows.map(String));
  const missed: bigint[] = [];
  const runsLeft = BigInt(s.maxRuns) - BigInt(purchasedWindows.length);
  for (let w = ZERO; w < closedThrough; w++) {
    if (bought.has(String(w))) continue;
    if (runsLeft <= ZERO && purchasedWindows.length > 0 && w > purchasedWindows.reduce((m, x) => (x > m ? x : m), ZERO)) break;
    missed.push(w);
  }
  return missed;
}
