import { normalizeAddress } from './chains';
import { planPurchase, type PurchasePlan, type PurchaseRequest } from './purchase';
import type { BagDocument, Hex } from './types';

// -----------------------------------------------------------------------------
// quoteBag / compileBag / simulateBag. The SDK builds an UNSIGNED transaction
// for the buyer's own wallet. It never signs, never sends, holds no key and
// owns no endpoint: routing comes from a ComposerProvider the caller passes in
// (e.g. `lifiComposer({ apiKey })` from @bag-protocol/sdk/lifi, with the
// caller's own LI.FI credentials), chain reads from the caller's viem client.
//
// Every answer from the provider is checked before it is returned: the
// transaction is for the planned chain, approvals are only for the input token
// and never above the swapped amount, every leg delivers the planned token,
// and the reported price impact is within the plan's limit.
// -----------------------------------------------------------------------------

/** What the SDK asks a routing provider to build. Provider-neutral. */
export interface ComposerCompileRequest {
  chainId: number;
  inputToken: string;
  /** Amount to swap (the plan's `swapAmountRaw`). */
  amountRaw: bigint;
  signer: string;
  /** Legs in order; leg i < n−1 is split off with `cascadeSplitBps[i]` of what remains, the last takes the rest. */
  legs: { token: string }[];
  cascadeSplitBps: number[];
  slippageBps: number;
  maxPriceImpactBps: number;
}

/** A provider's compiled purchase, normalized. `null` = the provider did not report it (never guessed). */
export interface ComposerCompileResult {
  transaction: { to: string; data: string; value: string; chainId: number | null };
  /** Contract that executes the program on the signer's behalf (informational). */
  executor: string | null;
  approvals: { token: string; spender: string; amountRaw: string }[];
  legs: { token: string | null; expectedOutRaw: string | null; minOutRaw: string | null }[];
  priceImpactBps: number | null;
  gasLimit: string | null;
  fees: { token: string; recipient: string; bps: number; amountRaw: string | null }[];
}

export interface ComposerProvider {
  readonly name: string;
  compile(request: ComposerCompileRequest): Promise<ComposerCompileResult>;
}

export interface QuotedLeg {
  token: string;
  /** Exact target input for this leg (the on-chain split stays within the v1 execution bound of it). */
  targetInputRaw: bigint;
  /** Simulated output: an estimate, not a guarantee. */
  expectedOutRaw: string | null;
  /** The provider's on-chain minimum at the swap: the transaction reverts below it. */
  minOutRaw: string | null;
}

export interface PurchaseQuote {
  plan: PurchasePlan;
  provider: string;
  legs: QuotedLeg[];
  priceImpactBps: number | null;
  fees: ComposerCompileResult['fees'];
  gasLimit: string | null;
}

export interface CompiledPurchase {
  quote: PurchaseQuote;
  /** Unsigned. The buyer's wallet signs and sends it, after the approvals. */
  transaction: { to: Hex; data: Hex; value: bigint; chainId: number };
  approvals: { token: Hex; spender: Hex; amountRaw: bigint }[];
  executor: string | null;
}

export class ProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const UINT_RE = /^\d+$/;

function requestFor(plan: PurchasePlan): ComposerCompileRequest {
  return {
    chainId: plan.chainId,
    inputToken: plan.inputToken,
    amountRaw: plan.swapAmountRaw,
    signer: plan.signer,
    legs: plan.legs.map((l) => ({ token: l.token })),
    cascadeSplitBps: plan.cascadeSplitBps,
    slippageBps: plan.slippageBps,
    maxPriceImpactBps: plan.maxPriceImpactBps,
  };
}

/** Checks a provider answer against the plan. Throws ProviderResponseError on anything unexpected. */
function checked(plan: PurchasePlan, provider: string, r: ComposerCompileResult): CompiledPurchase {
  const fail = (m: string): never => {
    throw new ProviderResponseError(`${provider}: ${m}`);
  };
  const tx = r.transaction;
  if (!ADDRESS_RE.test(tx.to) || !HEX_RE.test(tx.data) || tx.data.length < 10 || !UINT_RE.test(tx.value)) fail('malformed transaction.');
  if (tx.chainId !== null && tx.chainId !== plan.chainId) fail(`transaction is for chain ${tx.chainId}, the plan is for ${plan.chainId}.`);
  if (BigInt(tx.value) !== BigInt(0)) fail('an ERC-20 purchase must not send native value.');

  const approvals = r.approvals.map((a) => {
    if (normalizeAddress(a.token) !== plan.inputToken) fail(`approval requested for ${a.token}, not the input token.`);
    if (!ADDRESS_RE.test(a.spender) || !UINT_RE.test(a.amountRaw)) fail('malformed approval.');
    if (BigInt(a.amountRaw) > plan.swapAmountRaw) fail('approval above the swapped amount.');
    return { token: plan.inputToken as Hex, spender: a.spender as Hex, amountRaw: BigInt(a.amountRaw) };
  });

  if (r.legs.length !== plan.legs.length) fail(`returned ${r.legs.length} legs, planned ${plan.legs.length}.`);
  const legs: QuotedLeg[] = plan.legs.map((l, i) => {
    const got = r.legs[i];
    if (got.token !== null && normalizeAddress(got.token) !== l.token) fail(`leg ${i} delivers ${got.token}, planned ${l.token}.`);
    for (const v of [got.expectedOutRaw, got.minOutRaw]) if (v !== null && !UINT_RE.test(v)) fail(`leg ${i} has a malformed amount.`);
    return { token: l.token, targetInputRaw: l.targetInputRaw, expectedOutRaw: got.expectedOutRaw, minOutRaw: got.minOutRaw };
  });

  if (r.priceImpactBps !== null && r.priceImpactBps > plan.maxPriceImpactBps) {
    fail(`price impact ${r.priceImpactBps} bps is above the limit ${plan.maxPriceImpactBps} bps.`);
  }

  return {
    quote: { plan, provider, legs, priceImpactBps: r.priceImpactBps, fees: r.fees, gasLimit: r.gasLimit },
    transaction: { to: tx.to as Hex, data: tx.data as Hex, value: BigInt(0), chainId: plan.chainId },
    approvals,
    executor: r.executor,
  };
}

/** Plans the purchase and asks the provider for a priced route. Returns the quote only (no transaction). */
export async function quoteBag(bag: BagDocument, req: PurchaseRequest, options: { provider: ComposerProvider }): Promise<PurchaseQuote> {
  return (await compileBag(bag, req, options)).quote;
}

/** Plans the purchase, compiles it with the provider, checks the answer and returns the unsigned transaction. */
export async function compileBag(bag: BagDocument, req: PurchaseRequest, options: { provider: ComposerProvider }): Promise<CompiledPurchase> {
  const plan = planPurchase(bag, req);
  return checked(plan, options.provider.name, await options.provider.compile(requestFor(plan)));
}

/** Anything with viem's `readContract` and `call` (a viem PublicClient on the strategy's chain). */
export interface SimulationClient {
  getChainId(): Promise<number>;
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  call(args: { account: Hex; to: Hex; data: Hex; value?: bigint }): Promise<unknown>;
}

export type SimulationResult =
  | { status: 'OK' }
  | { status: 'NEEDS_APPROVAL'; missing: CompiledPurchase['approvals'] }
  | { status: 'INSUFFICIENT_BALANCE'; balanceRaw: bigint; requiredRaw: bigint }
  | { status: 'REVERTED'; reason: string };

const ERC20_READ_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * Dry-runs a compiled purchase from the signer with `eth_call` on the caller's client. Read-only. Checks, in
 * order: the client is on the plan's chain, the signer holds the input, the approvals are in place, then the
 * call itself. A simulation is a point-in-time check, not a guarantee: prices and routes move.
 */
export async function simulateBag(compiled: CompiledPurchase, options: { client: SimulationClient }): Promise<SimulationResult> {
  const { client } = options;
  const plan = compiled.quote.plan;
  const chainId = await client.getChainId();
  if (chainId !== plan.chainId) throw new Error(`simulateBag: client is on chain ${chainId}, the purchase is for ${plan.chainId}.`);
  const signer = plan.signer as Hex;

  const balance = BigInt((await client.readContract({ address: plan.inputToken as Hex, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [signer] })) as bigint);
  if (balance < plan.swapAmountRaw) return { status: 'INSUFFICIENT_BALANCE', balanceRaw: balance, requiredRaw: plan.swapAmountRaw };

  const missing: CompiledPurchase['approvals'] = [];
  for (const a of compiled.approvals) {
    const allowance = BigInt((await client.readContract({ address: a.token, abi: ERC20_READ_ABI, functionName: 'allowance', args: [signer, a.spender] })) as bigint);
    if (allowance < a.amountRaw) missing.push(a);
  }
  if (missing.length > 0) return { status: 'NEEDS_APPROVAL', missing };

  try {
    await client.call({ account: signer, to: compiled.transaction.to, data: compiled.transaction.data, value: compiled.transaction.value });
    return { status: 'OK' };
  } catch (e) {
    return { status: 'REVERTED', reason: ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split('\n')[0] };
  }
}
