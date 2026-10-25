import { decodeEventLog, hashTypedData, keccak256, stringToHex } from 'viem';
import { chainIdOf, normalizeAddress } from './chains';
import { computeDefinitionHash } from './definition';
import { BagSdkError } from './errors';
import { splitByWeight } from './split';
import type { BagDocument, Hex } from './types';

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

export const FUNDING_KINDS = Object.freeze({ ALLOWANCE: 0, DELEGATION: 1 } as const);
/** Uniswap v3 fee tiers the executor accepts (hundredths of a bip). 10000 = 1 %. */
export const RECURRING_ALLOWED_FEE_TIERS = Object.freeze([100, 500, 3000, 10000] as const);
export const RECURRING_MAX_ASSETS = 10;

export interface RecurringAssetLimit {
  asset: Hex;
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

/**
 * Builds the authorization a user signs from a bag.json and the chosen DCA terms. Asset order, weights and
 * decimals come from the definition; nothing is inferred from metadata. Throws `RECURRING_TERMS_INVALID` for
 * anything the executor would refuse.
 */
export function buildRecurringAuthorization(input: RecurringTermsInput): RecurringAuthorization {
  const { bag } = input;
  const owner = addr(input.owner, 'owner');
  const recipient = input.recipient === undefined ? owner : addr(input.recipient, 'recipient');
  const inputToken = addr(input.inputToken, 'inputToken');
  const fundingKind = input.funding.kind === 'ALLOWANCE' ? FUNDING_KINDS.ALLOWANCE : input.funding.kind === 'DELEGATION' ? FUNDING_KINDS.DELEGATION : fail('funding.kind must be ALLOWANCE or DELEGATION.');
  const fundingContract = input.funding.kind === 'DELEGATION' ? addr(input.funding.delegationManager, 'funding.delegationManager') : inputToken;

  if (!Number.isInteger(input.runs) || input.runs < 1 || input.runs > 0xffffffff) fail('runs must be a positive integer.');
  if (typeof input.amountPerRunRaw !== 'bigint' || input.amountPerRunRaw <= BigInt(0)) fail('amountPerRunRaw must be a positive bigint.');
  if (input.totalBudgetRaw !== input.amountPerRunRaw * BigInt(input.runs)) {
    fail(`totalBudgetRaw ${input.totalBudgetRaw} does not equal amountPerRunRaw × runs (${input.amountPerRunRaw * BigInt(input.runs)}).`);
  }
  if (input.periodSeconds <= BigInt(0) || input.startsAt <= BigInt(0)) fail('startsAt and periodSeconds must be positive.');
  const expiresAt = input.expiresAt ?? input.startsAt + input.periodSeconds * BigInt(input.runs);
  if (expiresAt <= input.startsAt || expiresAt > MAX_UINT64) fail('expiresAt must be after startsAt.');

  const assets: RecurringAssetLimit[] = bag.definition.assets.map((a, i) => {
    const asset = addr(a.address, `definition.assets[${i}].address`);
    if (asset === inputToken) fail('the input token cannot be a BAG asset in a recurring purchase (no kept share in this version).');
    const limit = Object.entries(input.maxPriceRaw).find(([k]) => k.toLowerCase() === asset)?.[1];
    if (typeof limit !== 'bigint' || limit <= BigInt(0) || limit >= MAX_UINT256) fail(`a finite positive maxPriceRaw is required for ${asset}.`);
    return { asset, weightBps: a.weightBps, decimals: a.decimals, maxPriceRaw: limit as bigint };
  });
  if (assets.length === 0 || assets.length > RECURRING_MAX_ASSETS) fail(`a recurring purchase supports 1–${RECURRING_MAX_ASSETS} assets.`);
  if (assets.reduce((s, a) => s + a.weightBps, 0) !== 10_000) fail('weights must sum to 10000.');

  const allowedFees = [...(input.route.allowedFees ?? RECURRING_ALLOWED_FEE_TIERS)];
  if (allowedFees.length === 0 || allowedFees.some((f) => !(RECURRING_ALLOWED_FEE_TIERS as readonly number[]).includes(f))) fail('allowedFees must be a non-empty subset of 100/500/3000/10000.');

  const strategyId = input.registry.strategyId ? bytes32(input.registry.strategyId, 'registry.strategyId') : ZERO32;
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
      compositionHash: bytes32(input.registry.compositionHash, 'registry.compositionHash'),
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

/**
 * BagFactory / Bag `compositionHash` convention of the BAG app (lib/domain/basket-protocol/version.ts):
 * keccak256 of `chain:address:symbol:decimals:weightBps` per asset, sorted by symbol, joined with `|`.
 * NOT part of bag.json v1 (symbols are display metadata); a verification helper to tie a bag.json to an
 * on-chain Bag. Returns null when the document has no symbol for an asset.
 */
export function bagFactoryCompositionHash(bag: BagDocument): Hex | null {
  const symbols = new Map((bag.metadata?.assets ?? []).map((m) => [m.address.toLowerCase(), m.symbol]));
  const rows: { symbol: string; line: string }[] = [];
  for (const a of bag.definition.assets) {
    const symbol = symbols.get(a.address.toLowerCase());
    if (!symbol) return null;
    rows.push({ symbol, line: `${a.chain}:${a.address.toLowerCase()}:${symbol}:${a.decimals}:${a.weightBps}` });
  }
  rows.sort((x, y) => x.symbol.localeCompare(y.symbol, 'en'));
  return keccak256(stringToHex(rows.map((r) => r.line).join('|')));
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
  assets: { asset: Hex; weightBps: number; legInputRaw: bigint; maxPriceRaw: bigint; minimumOutRaw: bigint }[];
  route: { router: Hex; swapTarget: Hex; allowedFees: number[] };
  bag: RecurringAuthorization['bag'];
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
    assets: auth.assets.map((a, i) => ({ asset: a.asset, weightBps: a.weightBps, legInputRaw: legIn[i], maxPriceRaw: a.maxPriceRaw, minimumOutRaw: minOut[i] })),
    route: auth.route,
    bag: auth.bag,
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

// ----------------------------------------------------------------------------- receipt

const EXECUTOR_EVENT_ABI = [
  {
    type: 'event',
    name: 'PurchaseExecuted',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'authorizationId', type: 'bytes32', indexed: true },
      { name: 'executionHash', type: 'bytes32', indexed: true },
      { name: 'window', type: 'uint256', indexed: false },
      { name: 'executionIndex', type: 'uint256', indexed: false },
      { name: 'grossAmount', type: 'uint256', indexed: false },
      { name: 'sourceDebit', type: 'uint256', indexed: false },
    ],
  },
] as const;
const TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export interface RecurringReceiptClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; to: string | null; blockNumber: bigint; logs: { address: string; topics: readonly Hex[]; data: Hex }[] }>;
}

export interface RecurringReceiptVerification {
  status: 'VERIFIED' | 'FAILED';
  authorizationId: Hex;
  window: bigint | null;
  executionIndex: bigint | null;
  sourceDebitRaw: bigint;
  deliveries: { asset: Hex; receivedRaw: bigint; minimumRaw: bigint }[];
  issues: { code: string; detail: string }[];
}

/**
 * Checks one executor transaction against the authorization, from the receipt alone (no archive state needed):
 * success, sent to the executor, exactly one `PurchaseExecuted` for this authorization id, the source account
 * debited exactly one run of the input token, every asset delivered to the recipient at or above the owner's
 * price-limit minimum, and nothing left with the executor or the router (net transfers zero).
 */
export async function verifyRecurringPurchaseReceipt(params: {
  client: RecurringReceiptClient;
  transactionHash: Hex;
  auth: RecurringAuthorization;
  deployment: RecurringDeployment;
}): Promise<RecurringReceiptVerification> {
  const { auth, deployment } = params;
  const id = recurringAuthorizationId(auth, deployment);
  const issues: RecurringReceiptVerification['issues'] = [];
  const minOut = recurringMinimumOutputs(auth);
  const result: RecurringReceiptVerification = { status: 'FAILED', authorizationId: id, window: null, executionIndex: null, sourceDebitRaw: BigInt(0), deliveries: [], issues };
  let receipt: Awaited<ReturnType<RecurringReceiptClient['getTransactionReceipt']>>;
  try {
    receipt = await params.client.getTransactionReceipt({ hash: params.transactionHash });
  } catch {
    throw new BagSdkError('RPC_READ_FAILED');
  }
  const executor = deployment.executor.toLowerCase();
  if (receipt.status !== 'success') issues.push({ code: 'TX_FAILED', detail: 'receipt status is not success' });
  if ((receipt.to ?? '').toLowerCase() !== executor) issues.push({ code: 'NOT_EXECUTOR_TX', detail: `sent to ${receipt.to}` });

  const executed = receipt.logs
    .filter((l) => l.address.toLowerCase() === executor)
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: EXECUTOR_EVENT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] })];
      } catch {
        return [];
      }
    })
    .filter((e) => e.eventName === 'PurchaseExecuted');
  const mine = executed.filter((e) => e.args.authorizationId.toLowerCase() === id.toLowerCase() && e.args.owner.toLowerCase() === auth.owner.toLowerCase());
  if (mine.length !== 1) issues.push({ code: 'EVENT_MISSING', detail: `${mine.length} PurchaseExecuted events for ${id}` });
  else {
    result.window = mine[0].args.window;
    result.executionIndex = mine[0].args.executionIndex;
    if (mine[0].args.grossAmount !== auth.schedule.grossAmountPerRun) issues.push({ code: 'GROSS_MISMATCH', detail: `event gross ${mine[0].args.grossAmount}` });
  }

  const transfers = receipt.logs.flatMap((l) => {
    try {
      const e = decodeEventLog({ abi: TRANSFER_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return [{ token: l.address.toLowerCase(), from: e.args.from.toLowerCase(), to: e.args.to.toLowerCase(), value: e.args.value }];
    } catch {
      return [];
    }
  });
  const net = (token: string, who: string) =>
    transfers.filter((t) => t.token === token.toLowerCase()).reduce((s, t) => s + (t.to === who.toLowerCase() ? t.value : BigInt(0)) - (t.from === who.toLowerCase() ? t.value : BigInt(0)), BigInt(0));
  result.sourceDebitRaw = -net(auth.inputToken, auth.sourceAccount);
  if (result.sourceDebitRaw !== auth.schedule.grossAmountPerRun) issues.push({ code: 'SOURCE_DEBIT_MISMATCH', detail: `source debit ${result.sourceDebitRaw}, expected ${auth.schedule.grossAmountPerRun}` });
  for (const holder of [deployment.executor, auth.route.router]) {
    for (const token of [auth.inputToken, ...auth.assets.map((a) => a.asset)]) {
      const n = net(token, holder);
      if (n !== BigInt(0)) issues.push({ code: 'TRANSIT_BALANCE', detail: `${holder} kept ${n} of ${token}` });
    }
  }
  result.deliveries = auth.assets.map((a, i) => {
    const receivedRaw = transfers.filter((t) => t.token === a.asset.toLowerCase() && t.from === executor && t.to === auth.recipient.toLowerCase()).reduce((s, t) => s + t.value, BigInt(0));
    if (receivedRaw < minOut[i]) issues.push({ code: 'BELOW_PRICE_LIMIT', detail: `${a.asset}: ${receivedRaw} < ${minOut[i]}` });
    return { asset: a.asset, receivedRaw, minimumRaw: minOut[i] };
  });
  result.status = issues.length === 0 ? 'VERIFIED' : 'FAILED';
  return result;
}

/** Chain id of a v1 bag document's chain (re-exported for callers building a deployment). */
export function recurringChainIdOf(bag: BagDocument): number {
  return chainIdOf(bag.definition.chain);
}
