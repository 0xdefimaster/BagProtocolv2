import { BagSdkError, compilePlannedPurchase, V1_EXECUTION_POLICY, type Hex } from '@/packages/bag-sdk/src';
import { lifiComposer, resolveLifiComposerAccount, type ComposerAccount, type ComposerAccountClient, type ComposerDeployment } from '@/packages/bag-sdk/src/adapters/lifi';
import type { ChainId } from '@/types/basket-protocol';
import { composerLegEnforcedMinOutputRaw, composerLegSimulatedOutputRaw, type ComposerPurchaseResult } from './lifi-composer-adapter';

// -----------------------------------------------------------------------------
// M3a (docs/architecture/M3_PURCHASE_SLICE_PLAN.md §3): the app's purchase compile, cross-checked by the BAG SDK.
//
// The app compiles a purchase with its own Composer adapter and signs whatever transaction target and approval
// spender the Composer API returns (T-2). The SDK's `compilePlannedPurchase` refuses any target or spender outside a
// caller-owned allowlist; here that allowlist comes from the wallet's Composer account, resolved on chain from the
// REVIEWED per-chain deployment pin (`COMPOSER_FACTORY_<CHAIN>`, `COMPOSER_FACTORY_CODE_HASH_<CHAIN>`) — never from
// the API response.
//
// No second network call: the legacy compile runs through a recording fetch, and the SDK compiles the SAME plan
// against a replay of that exchange. The replay first requires the SDK's request to be the legacy request (same URL,
// same program and run; only the flow's display id differs, and the price-impact limit when the app sent none), so
// both sides read one response. Then the outputs are compared: transaction to/data/value, approvals, user proxy, and
// each leg's simulated and enforced minimum output. Anything but MATCH is reported with stable reason codes.
//
// BAG_SDK_COMPOSER_COMPILE: off (default; nothing here runs) | shadow (cross-check and log, the legacy result is
// used either way) | on (the purchase proceeds only on MATCH). Delivery proof (M3b) is NOT enabled: the signed
// program is unchanged.
// -----------------------------------------------------------------------------

export type SdkComposerCompileMode = 'off' | 'shadow' | 'on';

export function sdkComposerCompileMode(env: Record<string, string | undefined> = process.env): SdkComposerCompileMode {
  const raw = (env.BAG_SDK_COMPOSER_COMPILE ?? '').trim().toLowerCase();
  return raw === 'shadow' || raw === 'on' ? raw : 'off';
}

/** The Composer API the legacy adapter calls (lifi-composer-adapter.ts default). The replay checks the SDK asks the same URL. */
export const COMPOSER_API_BASE_URL = 'https://composer.li.quest';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CODE_HASH = /^0x[0-9a-fA-F]{64}$/;

/** The reviewed Composer deployment pin for `chain` from server env, or null when none is configured (no default, no cross-chain reuse). */
export function reviewedComposerDeployment(chain: ChainId, chainId: number, env: Record<string, string | undefined> = process.env): ComposerDeployment | null {
  const key = chain.toUpperCase();
  const factory = (env[`COMPOSER_FACTORY_${key}`] ?? '').trim();
  const factoryCodeHash = (env[`COMPOSER_FACTORY_CODE_HASH_${key}`] ?? '').trim();
  if (!ADDRESS.test(factory) || !CODE_HASH.test(factoryCodeHash)) return null;
  return { chainId, factory: factory as Hex, factoryCodeHash: factoryCodeHash as Hex };
}

// --- record / replay -----------------------------------------------------------------------------------------

export interface RecordedExchange {
  url: string;
  method: string;
  body: string | null;
  status: number;
  statusText: string;
  headers: [string, string][];
  responseText: string;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function replayResponse(x: RecordedExchange): Response {
  return new Response(NULL_BODY_STATUS.has(x.status) ? null : x.responseText, { status: x.status, statusText: x.statusText, headers: x.headers });
}

function headerEntries(h: Headers | undefined): [string, string][] {
  const out: [string, string][] = [];
  h?.forEach((value, name) => out.push([name, value]));
  return out;
}

/** A fetch that passes through to `base` and records each exchange (the response is read once and handed back intact). */
export function recordingFetch(base: typeof fetch = fetch): { fetch: typeof fetch; exchanges: RecordedExchange[] } {
  const exchanges: RecordedExchange[] = [];
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, init);
    const responseText = await res.text();
    const x: RecordedExchange = {
      url: String(input instanceof Request ? input.url : input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : null,
      status: res.status,
      statusText: res.statusText ?? '',
      headers: headerEntries(res.headers),
      responseText,
    };
    exchanges.push(x);
    return replayResponse(x);
  }) as typeof fetch;
  return { fetch: recording, exchanges };
}

export class ReplayMismatchError extends Error {
  constructor(readonly reason: string) {
    super(`SDK compile request differs from the legacy request: ${reason}`);
    this.name = 'ReplayMismatchError';
  }
}

/**
 * The legacy and SDK compile bodies, made comparable: the flow's display id is the only field the two adapters name
 * differently (`bag-purchase-N-legs` / `bag-sdk-purchase-N-legs`), and the SDK always states a price-impact limit
 * while the app omits it until the buyer accepted one (then both send the same number). Everything else must be
 * byte-identical after this.
 */
function comparableBodies(legacy: string, sdk: string): [string, string] | null {
  let a: { flow?: { id?: unknown }; run?: Record<string, unknown> };
  let b: { flow?: { id?: unknown }; run?: Record<string, unknown> };
  try {
    a = JSON.parse(legacy);
    b = JSON.parse(sdk);
  } catch {
    return null;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || !a.flow || !b.flow || !a.run || !b.run) return null;
  a.flow.id = b.flow.id = '';
  if (!('maxPriceImpactBps' in a.run)) delete b.run.maxPriceImpactBps;
  return [JSON.stringify(a), JSON.stringify(b)];
}

/** A fetch that answers the SDK with the recorded exchanges, in order, only for requests equal to the recorded ones. */
export function replayFetch(recorded: readonly RecordedExchange[]): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const x = recorded[i++];
    if (!x) throw new ReplayMismatchError('EXTRA_REQUEST');
    const url = String(input instanceof Request ? input.url : input);
    if (url !== x.url) throw new ReplayMismatchError('URL');
    if ((init?.method ?? 'GET').toUpperCase() !== x.method) throw new ReplayMismatchError('METHOD');
    const body = typeof init?.body === 'string' ? init.body : null;
    if (body !== x.body) {
      const pair = body !== null && x.body !== null ? comparableBodies(x.body, body) : null;
      if (!pair || pair[0] !== pair[1]) throw new ReplayMismatchError('PROGRAM');
    }
    return replayResponse(x);
  }) as typeof fetch;
}

// --- cross-check ----------------------------------------------------------------------------------------------

export interface SdkCompileCheckInput {
  chain: ChainId;
  chainId: number;
  inputKind: 'native' | 'erc20';
  /** ERC-20 address (any case), or the native sentinel the legacy flow used. */
  inputToken: string;
  signer: string;
  swapAmountRaw: bigint;
  /** The app's legs in Composer order (`swap_<i>`), as sent to the legacy compile. */
  legs: { token: string; legBps: number; targetInputRaw: bigint }[];
  slippageBps: number;
  /** The limit the app sent (after a buyer accepted an impact); absent: the SDK's v1 default applies to its own check. */
  maxPriceImpactBps?: number;
  apiKey: string;
  legacy: ComposerPurchaseResult;
  exchanges: readonly RecordedExchange[];
}

export interface SdkCompileCheckDeps {
  env?: Record<string, string | undefined>;
  /** Chain reads for the account resolution; injected in tests. */
  client: ComposerAccountClient;
}

export type SdkCompileCheck =
  | { verdict: 'MATCH' }
  | { verdict: 'MISMATCH'; reasons: string[] }
  | { verdict: 'REFUSED'; code: string }
  | { verdict: 'UNAVAILABLE'; reason: 'NO_REVIEWED_DEPLOYMENT' | 'NOT_RECORDED' | 'ERROR' };

/** The SDK's v1 price-impact limit, used for the SDK's own check when the app sent none (Composer then applies its default). */
const SDK_DEFAULT_MAX_PRICE_IMPACT_BPS = V1_EXECUTION_POLICY.maxPriceImpactBps;

const lower = (s: string | null | undefined) => (typeof s === 'string' ? s.toLowerCase() : s ?? null);

export async function crossCheckComposerPurchase(input: SdkCompileCheckInput, deps: SdkCompileCheckDeps): Promise<SdkCompileCheck> {
  const deployment = reviewedComposerDeployment(input.chain, input.chainId, deps.env);
  if (!deployment) return { verdict: 'UNAVAILABLE', reason: 'NO_REVIEWED_DEPLOYMENT' };
  if (input.exchanges.length === 0) return { verdict: 'UNAVAILABLE', reason: 'NOT_RECORDED' };

  let account: ComposerAccount;
  try {
    account = await resolveLifiComposerAccount({ chainId: input.chainId, signer: input.signer as Hex, deployment, client: deps.client });
  } catch (err) {
    return err instanceof BagSdkError ? { verdict: 'REFUSED', code: err.code } : { verdict: 'UNAVAILABLE', reason: 'ERROR' };
  }

  let compiled;
  try {
    compiled = await compilePlannedPurchase(
      {
        chainId: input.chainId,
        inputToken: input.inputKind === 'erc20' ? input.inputToken.toLowerCase() : input.inputToken,
        inputKind: input.inputKind,
        signer: input.signer,
        swapAmountRaw: input.swapAmountRaw,
        legs: input.legs.map((l) => ({ token: l.token.toLowerCase(), legBps: l.legBps, targetInputRaw: l.targetInputRaw })),
        slippageBps: input.slippageBps,
        maxPriceImpactBps: input.maxPriceImpactBps ?? SDK_DEFAULT_MAX_PRICE_IMPACT_BPS,
        // The app's strategy identity stays the intent's own; this plan has no bag.json behind it.
        definitionHash: null,
      },
      {
        provider: lifiComposer({ apiKey: input.apiKey, baseUrl: COMPOSER_API_BASE_URL, fetch: replayFetch(input.exchanges), account, deliveryProof: false }),
        trust: account.trust,
      }
    );
  } catch (err) {
    const cause = (err as { cause?: unknown })?.cause;
    if (err instanceof ReplayMismatchError) return { verdict: 'MISMATCH', reasons: [`REQUEST_${err.reason}`] };
    if (cause instanceof ReplayMismatchError) return { verdict: 'MISMATCH', reasons: [`REQUEST_${cause.reason}`] };
    if (err instanceof BagSdkError) return { verdict: 'REFUSED', code: err.code };
    return { verdict: 'UNAVAILABLE', reason: 'ERROR' };
  }

  const reasons: string[] = [];
  const legacyTx = input.legacy.transactionRequest;
  if (lower(compiled.transaction.to) !== lower(legacyTx.to)) reasons.push('TX_TO');
  if (lower(compiled.transaction.data) !== lower(legacyTx.data)) reasons.push('TX_DATA');
  let legacyValue: bigint | null = null;
  try {
    legacyValue = BigInt(legacyTx.value);
  } catch {
    /* compared as different below */
  }
  if (legacyValue === null || compiled.transaction.value !== legacyValue) reasons.push('TX_VALUE');
  if (compiled.transaction.chainId !== (legacyTx.chainId ?? input.chainId)) reasons.push('TX_CHAIN');
  if (lower(compiled.executor) !== lower(input.legacy.userProxy)) reasons.push('USER_PROXY');
  const approvals = (a: { token: string; spender: string; amountRaw: string | bigint }[]) =>
    JSON.stringify(a.map((x) => [x.token.toLowerCase(), x.spender.toLowerCase(), String(x.amountRaw)]));
  if (approvals(compiled.approvals) !== approvals(input.legacy.approvals)) reasons.push('APPROVALS');
  compiled.quote.legs.forEach((leg, i) => {
    if (leg.minOutRaw !== composerLegEnforcedMinOutputRaw(input.legacy.outputs, i)) reasons.push(`LEG_${i}_MIN_OUT`);
    if (leg.expectedOutRaw !== composerLegSimulatedOutputRaw(input.legacy.outputs, i)) reasons.push(`LEG_${i}_EXPECTED_OUT`);
  });
  return reasons.length === 0 ? { verdict: 'MATCH' } : { verdict: 'MISMATCH', reasons };
}

/** One privacy-safe line per cross-check: chain, leg count, mode, verdict and codes. No wallet, amounts or calldata. */
export function logSdkCompileCheck(mode: SdkComposerCompileMode, chain: ChainId, legs: number, check: SdkCompileCheck): void {
  const detail = check.verdict === 'MISMATCH' ? check.reasons.join(',') : check.verdict === 'REFUSED' ? check.code : check.verdict === 'UNAVAILABLE' ? check.reason : '';
  const line = `[sdk-compile-${mode}] chain=${chain} legs=${legs} verdict=${check.verdict}${detail ? ` detail=${detail}` : ''}`;
  if (check.verdict === 'MATCH') console.info(line);
  else console.warn(line);
}
