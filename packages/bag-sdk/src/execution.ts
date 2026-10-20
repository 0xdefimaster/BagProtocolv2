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
// The caller trust policy and purchase plan are checked before the provider
// call. Provider-returned transaction chain/target, approval token/spender/
// amount, planned output legs, and price impact are checked after the response
// and before returning an unsigned transaction.
// -----------------------------------------------------------------------------

/** What the SDK asks a routing provider to build. Provider-neutral. */
export interface ComposerCompileRequest {
  chainId: number;
  inputToken: string;
  /** 'native': declare the input as the chain's native coin (deposited as msg.value). 'erc20': an ERC-20 input. */
  inputKind: 'native' | 'erc20';
  /** Amount to swap (the plan's `swapAmountRaw`). */
  amountRaw: bigint;
  signer: string;
  /** Legs in order, each with its whole-bp share of `amountRaw` (summing to 10000). Build the partition with `planPartition(legs.map(l => l.legBps))`. */
  legs: { token: string; legBps: number }[];
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

/** Caller-owned trust boundary for contracts the wallet may be asked to call or approve. */
export interface ExecutionTrustPolicy {
  /** Must equal the strategy chain. Address allowlists are never shared across chains. */
  chainId: number;
  /** Explicit contracts allowed as the compiled transaction target. */
  allowedTransactionTargets: readonly string[];
  /** Explicit contracts allowed to receive an ERC-20 approval. May be empty if no approval is needed. */
  allowedApprovalSpenders: readonly string[];
}

export interface QuotedLeg {
  token: string;
  /** Exact target input for this leg (the on-chain split stays within the v1 execution bound of it). */
  targetInputRaw: bigint;
  /** Simulated output: an estimate, not a guarantee. */
  expectedOutRaw: string | null;
  /** Required on-chain minimum output. A missing or zero floor is rejected before a transaction is returned. */
  minOutRaw: string;
}

export interface PurchaseQuote {
  plan: PurchasePlan;
  provider: string;
  legs: QuotedLeg[];
  /** Required, validated non-negative integer bps reported by the routing provider. */
  priceImpactBps: number;
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
/** A transaction value: decimal or 0x-hex (providers use either). */
const VALUE_RE = /^(\d+|0x[0-9a-fA-F]+)$/;

interface TrustedContracts {
  targets: Set<string>;
  spenders: Set<string>;
}

function trustedContracts(plan: PurchasePlan, provider: string, trust: ExecutionTrustPolicy): TrustedContracts {
  const fail = (m: string): never => {
    throw new ProviderResponseError(`${provider}: ${m}`);
  };
  if (!trust || trust.chainId !== plan.chainId) fail(`trust policy chain ${trust?.chainId ?? 'missing'} does not match plan chain ${plan.chainId}.`);
  if (!Array.isArray(trust.allowedTransactionTargets) || trust.allowedTransactionTargets.length === 0 || trust.allowedTransactionTargets.some((a) => typeof a !== 'string' || !ADDRESS_RE.test(a))) {
    fail('trust policy must contain at least one valid transaction target.');
  }
  if (!Array.isArray(trust.allowedApprovalSpenders) || trust.allowedApprovalSpenders.some((a) => typeof a !== 'string' || !ADDRESS_RE.test(a))) {
    fail('trust policy contains an invalid approval spender list.');
  }
  return {
    targets: new Set(trust.allowedTransactionTargets.map((a) => a.toLowerCase())),
    spenders: new Set(trust.allowedApprovalSpenders.map((a) => a.toLowerCase())),
  };
}

function requestFor(plan: PurchasePlan): ComposerCompileRequest {
  return {
    chainId: plan.chainId,
    inputToken: plan.inputToken,
    inputKind: plan.inputKind,
    amountRaw: plan.swapAmountRaw,
    signer: plan.signer,
    legs: plan.legs.map((l) => ({ token: l.token, legBps: l.legBps })),
    slippageBps: plan.slippageBps,
    maxPriceImpactBps: plan.maxPriceImpactBps,
  };
}

/** Checks a provider answer against the plan. Throws ProviderResponseError on anything unexpected. */
function checked(plan: PurchasePlan, provider: string, r: ComposerCompileResult, trusted: TrustedContracts): CompiledPurchase {
  const fail = (m: string): never => {
    throw new ProviderResponseError(`${provider}: ${m}`);
  };

  // ComposerProvider is a runtime trust boundary. TypeScript types do not validate
  // an HTTP response, third-party adapter, malformed fixture or compromised provider.
  if (!r || typeof r !== 'object') fail('provider returned a non-object response.');
  if (!r.transaction || typeof r.transaction !== 'object') fail('provider returned no transaction object.');
  if (!Array.isArray(r.approvals)) fail('provider returned a malformed approvals list.');
  if (!Array.isArray(r.legs)) fail('provider returned a malformed output-legs list.');
  if (!Array.isArray(r.fees)) fail('provider returned a malformed fees list.');

  if (r.priceImpactBps === null || !Number.isSafeInteger(r.priceImpactBps) || r.priceImpactBps < 0) {
    fail('price impact is missing or malformed; refusing to compile an unpriced purchase.');
  }
  if (r.executor !== null && (typeof r.executor !== 'string' || !ADDRESS_RE.test(r.executor))) {
    fail('malformed executor address.');
  }
  if (r.gasLimit !== null && (typeof r.gasLimit !== 'string' || !VALUE_RE.test(r.gasLimit) || BigInt(r.gasLimit) <= BigInt(0))) {
    fail('malformed gas limit.');
  }

  const tx = r.transaction;
  if (
    typeof tx.to !== 'string' || !ADDRESS_RE.test(tx.to) ||
    typeof tx.data !== 'string' || !HEX_RE.test(tx.data) || tx.data.length < 10 || tx.data.length % 2 !== 0 ||
    typeof tx.value !== 'string' || !VALUE_RE.test(tx.value)
  ) fail('malformed transaction.');
  if (!Number.isSafeInteger(tx.chainId) || tx.chainId !== plan.chainId) {
    fail(`transaction chain ${tx.chainId ?? 'missing'} does not match plan chain ${plan.chainId}.`);
  }
  if (!trusted.targets.has(tx.to.toLowerCase())) {
    fail(`transaction target ${tx.to} is not in the caller's trusted target allowlist.`);
  }

  const value = BigInt(tx.value);
  if (plan.inputKind === 'native') {
    // Native value must be exact; no surprise value and no approval request.
    if (value !== plan.swapAmountRaw) {
      fail(`a native purchase must send exactly ${plan.swapAmountRaw} wei, the transaction sends ${value}.`);
    }
    if (r.approvals.length > 0) fail('a native purchase needs no approval, the provider requested one.');
  } else if (value !== BigInt(0)) {
    fail('an ERC-20 purchase must not send native value.');
  }

  const seenSpenders = new Set<string>();
  const approvals = r.approvals.map((a, i) => {
    if (
      !a || typeof a !== 'object' ||
      typeof a.token !== 'string' || !ADDRESS_RE.test(a.token) ||
      typeof a.spender !== 'string' || !ADDRESS_RE.test(a.spender) ||
      typeof a.amountRaw !== 'string' || !UINT_RE.test(a.amountRaw)
    ) fail(`malformed approval at index ${i}.`);
    if (normalizeAddress(a.token) !== plan.inputToken) {
      fail(`approval requested for ${a.token}, not the input token.`);
    }
    const spender = a.spender.toLowerCase();
    if (!trusted.spenders.has(spender)) {
      fail(`approval spender ${a.spender} is not in the caller's trusted spender allowlist.`);
    }
    if (seenSpenders.has(spender)) fail(`duplicate approval spender ${a.spender}.`);
    seenSpenders.add(spender);

    const amount = BigInt(a.amountRaw);
    if (amount <= BigInt(0)) fail('approval amount must be positive.');
    if (amount > plan.swapAmountRaw) fail('approval above the swapped amount.');
    return { token: plan.inputToken as Hex, spender: a.spender as Hex, amountRaw: amount };
  });

  if (r.legs.length !== plan.legs.length) {
    fail(`returned ${r.legs.length} legs, planned ${plan.legs.length}.`);
  }
  const legs: QuotedLeg[] = plan.legs.map((l, i) => {
    const got = r.legs[i];
    if (!got || typeof got !== 'object') fail(`leg ${i} is missing or malformed.`);
    if (typeof got.token !== 'string' || !ADDRESS_RE.test(got.token)) {
      fail(`leg ${i} output token was not reported as a valid address.`);
    }
    if (normalizeAddress(got.token) !== l.token) {
      fail(`leg ${i} delivers ${got.token}, planned ${l.token}.`);
    }
    for (const amount of [got.expectedOutRaw, got.minOutRaw]) {
      if (amount !== null && (typeof amount !== 'string' || !UINT_RE.test(amount))) {
        fail(`leg ${i} has a malformed amount.`);
      }
    }
    // An unsigned transaction without a verifiable positive on-chain minOut is
    // not safe to surface as a compiled purchase, even if the provider says success.
    if (got.minOutRaw === null) {
      fail(`leg ${i} has no reported on-chain minimum output; refusing to return an unprotected transaction.`);
    }
    const minimum = BigInt(got.minOutRaw);
    if (minimum <= BigInt(0)) fail(`leg ${i} minimum output must be positive.`);
    if (got.expectedOutRaw !== null && minimum > BigInt(got.expectedOutRaw)) {
      fail(`leg ${i} minimum output is above its expected output.`);
    }
    return {
      token: l.token,
      targetInputRaw: l.targetInputRaw,
      expectedOutRaw: got.expectedOutRaw,
      minOutRaw: got.minOutRaw,
    };
  });

  if (r.priceImpactBps > plan.maxPriceImpactBps) {
    fail(`price impact ${r.priceImpactBps} bps is above the limit ${plan.maxPriceImpactBps} bps.`);
  }

  const fees = r.fees.map((fee, i) => {
    if (
      !fee || typeof fee !== 'object' ||
      typeof fee.token !== 'string' || !ADDRESS_RE.test(fee.token) ||
      typeof fee.recipient !== 'string' || !ADDRESS_RE.test(fee.recipient) ||
      !Number.isSafeInteger(fee.bps) || fee.bps < 0 || fee.bps > 10000 ||
      (fee.amountRaw !== null && (typeof fee.amountRaw !== 'string' || !UINT_RE.test(fee.amountRaw)))
    ) fail(`malformed fee entry at index ${i}.`);
    return fee;
  });

  return {
    quote: { plan, provider, legs, priceImpactBps: r.priceImpactBps, fees, gasLimit: r.gasLimit },
    transaction: { to: tx.to as Hex, data: tx.data as Hex, value, chainId: plan.chainId },
    approvals,
    executor: r.executor,
  };
}

/** Plans the purchase and asks the provider for a priced route. Returns the quote only (no transaction). */
export async function quoteBag(bag: BagDocument, req: PurchaseRequest, options: { provider: ComposerProvider; trust: ExecutionTrustPolicy }): Promise<PurchaseQuote> {
  return (await compileBag(bag, req, options)).quote;
}

/** Plans the purchase, compiles it with the provider, checks the answer and returns the unsigned transaction. */
export async function compileBag(bag: BagDocument, req: PurchaseRequest, options: { provider: ComposerProvider; trust: ExecutionTrustPolicy }): Promise<CompiledPurchase> {
  const plan = planPurchase(bag, req);
  const trusted = trustedContracts(plan, options.provider.name, options.trust);
  // The provider response is the first point where the compiled target and
  // approval spenders are available to compare with the caller's allowlists.
  return checked(plan, options.provider.name, await options.provider.compile(requestFor(plan)), trusted);
}

/** Anything with viem's `readContract` and `call` (a viem PublicClient on the strategy's chain); `getBalance` for a native purchase. */
export interface SimulationClient {
  getChainId(): Promise<number>;
  getBalance?(args: { address: Hex }): Promise<bigint>;
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

  let balance: bigint;
  if (plan.inputKind === 'native') {
    if (!client.getBalance) throw new Error('simulateBag: a native purchase needs a client with getBalance.');
    // The value only; the network fee comes on top and the wallet shows it.
    balance = BigInt(await client.getBalance({ address: signer }));
  } else {
    balance = BigInt((await client.readContract({ address: plan.inputToken as Hex, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [signer] })) as bigint);
  }
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
