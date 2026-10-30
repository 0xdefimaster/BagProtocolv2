import { domainSeparator as eip712DomainSeparator, encodeAbiParameters, hashStruct, hashTypedData, keccak256, type Address, type Hex, type TypedDataDomain } from 'viem';

// -----------------------------------------------------------------------------
// Off-chain twin of contracts/settlement/BasketTypes.sol: BagSettlementRouter's
// signed messages and the hashes the router recomputes. Pure. Both sides are
// pinned by contracts/test/vectors/basket-settlement-v1.json.
// Spec: docs/BAG_SETTLEMENT_ARCHITECTURE.md.
// -----------------------------------------------------------------------------

export const SETTLEMENT_DOMAIN_NAME = 'BagSettlementRouter';
export const SETTLEMENT_DOMAIN_VERSION = '1';
const TOTAL_BPS = BigInt(10_000);
const PRICE_SCALE = BigInt(10) ** BigInt(18);

export interface BasketIntent {
  payer: Address;
  recipient: Address;
  strategyId: Hex;
  strategyVersion: number;
  definitionHash: Hex;
  compositionHash: Hex;
  inputToken: Address;
  maxInput: bigint;
  /** `priceLimitsHash(maxPriceX18)`, composition order. */
  priceLimitsHash: Hex;
  maxIntegratorFeeBps: number;
  maxProtocolFeeBps: number;
  nonce: bigint;
  deadline: bigint;
}

export interface SellIntent {
  seller: Address;
  recipient: Address;
  strategyId: Hex;
  strategyVersion: number;
  /** `holdingsHash(tokens, amounts)`: the exact holdings sold. */
  holdingsHash: Hex;
  outputToken: Address;
  minGrossOutput: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface Leg {
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  adapter: Address;
  adapterData: Hex;
}

export interface ExecutionPlan {
  intentHash: Hex;
  expiry: bigint;
  inputAmount: bigint;
  integratorFeeRecipient: Address;
  integratorFee: bigint;
  protocolFee: bigint;
  legs: Leg[];
}

export const SETTLEMENT_TYPES = {
  BasketIntent: [
    { name: 'payer', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'strategyId', type: 'bytes32' },
    { name: 'strategyVersion', type: 'uint32' },
    { name: 'definitionHash', type: 'bytes32' },
    { name: 'compositionHash', type: 'bytes32' },
    { name: 'inputToken', type: 'address' },
    { name: 'maxInput', type: 'uint256' },
    { name: 'priceLimitsHash', type: 'bytes32' },
    { name: 'maxIntegratorFeeBps', type: 'uint16' },
    { name: 'maxProtocolFeeBps', type: 'uint16' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  SellIntent: [
    { name: 'seller', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'strategyId', type: 'bytes32' },
    { name: 'strategyVersion', type: 'uint32' },
    { name: 'holdingsHash', type: 'bytes32' },
    { name: 'outputToken', type: 'address' },
    { name: 'minGrossOutput', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export function settlementDomain(chainId: number, router: Address): TypedDataDomain {
  return { name: SETTLEMENT_DOMAIN_NAME, version: SETTLEMENT_DOMAIN_VERSION, chainId, verifyingContract: router };
}

export const domainSeparator = (chainId: number, router: Address): Hex => eip712DomainSeparator({ domain: settlementDomain(chainId, router) });

/** EIP-712 struct hash, as `BasketTypes.hashIntent`. This is `plan.intentHash`. */
export const hashIntent = (intent: BasketIntent): Hex =>
  hashStruct({ data: intent, primaryType: 'BasketIntent', types: SETTLEMENT_TYPES });

export const hashSellIntent = (intent: SellIntent): Hex =>
  hashStruct({ data: intent, primaryType: 'SellIntent', types: SETTLEMENT_TYPES });

/** The digest the payer signs. */
export const intentDigest = (intent: BasketIntent, chainId: number, router: Address): Hex =>
  hashTypedData({ domain: settlementDomain(chainId, router), types: SETTLEMENT_TYPES, primaryType: 'BasketIntent', message: intent });

export const sellDigest = (intent: SellIntent, chainId: number, router: Address): Hex =>
  hashTypedData({ domain: settlementDomain(chainId, router), types: SETTLEMENT_TYPES, primaryType: 'SellIntent', message: intent });

export const priceLimitsHash = (maxPriceX18: readonly bigint[]): Hex => keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [maxPriceX18]));

export const holdingsHash = (tokens: readonly Address[], amounts: readonly bigint[]): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], [tokens, amounts]));

const PLAN_ABI = [{
  type: 'tuple',
  components: [
    { name: 'intentHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
    { name: 'inputAmount', type: 'uint256' },
    { name: 'integratorFeeRecipient', type: 'address' },
    { name: 'integratorFee', type: 'uint256' },
    { name: 'protocolFee', type: 'uint256' },
    { name: 'legs', type: 'tuple[]', components: [
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
      { name: 'adapter', type: 'address' },
      { name: 'adapterData', type: 'bytes' },
    ] },
  ],
}] as const;

/** keccak256(abi.encode(plan)), as emitted in BasketSettled. */
export const planHash = (plan: ExecutionPlan): Hex => keccak256(encodeAbiParameters(PLAN_ABI, [plan]));

/** minOut = floor(amountIn × 1e18 / maxPriceX18); a zero limit is invalid. */
export function minOutFromPriceLimit(amountIn: bigint, maxPriceX18: bigint): bigint {
  if (maxPriceX18 <= BigInt(0)) throw new Error('minOutFromPriceLimit: price limit must be positive.');
  return (amountIn * PRICE_SCALE) / maxPriceX18;
}

/**
 * Inverse for building an intent from a quote: the largest price limit whose minimum is still ≥ `minOut`,
 * floor(amountIn × 1e18 / minOut). Rounding the limit down keeps the derived minimum at or above `minOut`.
 * The payer's slippage belongs in `minOut`.
 */
export function priceLimitForMinOut(amountIn: bigint, minOut: bigint): bigint {
  if (minOut <= BigInt(0) || amountIn <= BigInt(0)) throw new Error('priceLimitForMinOut: amounts must be positive.');
  const limit = (amountIn * PRICE_SCALE) / minOut;
  if (limit === BigInt(0)) throw new Error('priceLimitForMinOut: minOut is above amountIn × 1e18; no positive limit reaches it.');
  return limit;
}

/**
 * The router's target split, as `BasketTypes.splitByWeight` and packages/bag-sdk/src/split.ts for one chain:
 * floor shares, then one unit each to the largest remainders, ties to the lower index (= lower token address in
 * composition order).
 */
export function splitByWeight(amount: bigint, weightsBps: readonly number[]): bigint[] {
  if (amount < BigInt(0)) throw new Error('splitByWeight: negative amount.');
  if (weightsBps.some((w) => !Number.isInteger(w) || w <= 0) || weightsBps.reduce((s, w) => s + w, 0) !== 10_000) {
    throw new Error('splitByWeight: weights must be positive and sum to 10000.');
  }
  const parts = weightsBps.map((w) => (amount * BigInt(w)) / TOTAL_BPS);
  const remainders = weightsBps.map((w) => (amount * BigInt(w)) % TOTAL_BPS);
  const order = weightsBps.map((_, i) => i).sort((a, b) => (remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1));
  let left = amount - parts.reduce((s, p) => s + p, BigInt(0));
  for (const i of order) {
    if (left <= BigInt(0)) break;
    parts[i] += BigInt(1);
    left -= BigInt(1);
  }
  return parts;
}
