import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { BagDefinition } from '@/types/strategy';

// -----------------------------------------------------------------------------
// StrategyCompositions — the off-chain half (contracts/StrategyCompositions.sol,
// docs/STRATEGY_COMPOSITIONS_DESIGN.md). Pure.
//
// A bag.json definition lists assets as (chain slug, address, weightBps). The
// contract stores (EIP-155 chainId, token, weightBps), strictly ascending by
// (chainId, token). This module turns one into the other the same way the
// contract checks it, hashes it the same way, and compares what a chain read
// returned with a bag.json — so "the weights on-chain are this version's
// weights" can be checked by anyone holding the bag.json.
// -----------------------------------------------------------------------------

export interface OnchainAllocation {
  chainId: bigint;
  /** Lowercase. */
  token: Hex;
  weightBps: number;
}

export const TOTAL_BPS = 10000;
export const MAX_ALLOCATIONS = 64;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ALLOCATION_TUPLE = { type: 'tuple[]', components: [{ name: 'chainId', type: 'uint64' }, { name: 'token', type: 'address' }, { name: 'weightBps', type: 'uint16' }] } as const;

export type CompositionUnsupported = { ok: false; reason: string };

/** Contract order: ascending chainId, then ascending token as a number. */
export function sortAllocations(a: OnchainAllocation[]): OnchainAllocation[] {
  return [...a].sort((x, y) => (x.chainId !== y.chainId ? (x.chainId < y.chainId ? -1 : 1) : BigInt(x.token) < BigInt(y.token) ? -1 : BigInt(x.token) > BigInt(y.token) ? 1 : 0));
}

/**
 * The allocations StrategyCompositions would accept for this definition, or why it cannot be expressed on-chain
 * (a non-EVM asset, a weight that is not a positive integer, weights not summing to 10000, a duplicate, too many).
 * `chainIdOf` maps a chain slug to its EIP-155 id (lib/blockchain/evm/config.ts getEvmChainIdFor), null for non-EVM.
 */
export function definitionToAllocations(
  definition: Pick<BagDefinition, 'assets'>,
  chainIdOf: (chain: string) => number | null
): { ok: true; allocations: OnchainAllocation[] } | CompositionUnsupported {
  if (definition.assets.length === 0 || definition.assets.length > MAX_ALLOCATIONS) return { ok: false, reason: `${definition.assets.length} assets (1–${MAX_ALLOCATIONS} allowed)` };
  const out: OnchainAllocation[] = [];
  let total = 0;
  for (const a of definition.assets) {
    const chainId = chainIdOf(a.chain);
    if (chainId === null || !Number.isInteger(chainId) || chainId <= 0) return { ok: false, reason: `asset ${a.address} is on ${a.chain}, which has no EVM chain id` };
    if (!ADDRESS_RE.test(a.address) || /^0x0{40}$/i.test(a.address)) return { ok: false, reason: `asset address ${a.address} is not an EVM token address` };
    if (!Number.isInteger(a.weightBps) || a.weightBps <= 0 || a.weightBps > TOTAL_BPS) return { ok: false, reason: `weight ${a.weightBps} of ${a.address} is not a positive integer number of bps` };
    total += a.weightBps;
    out.push({ chainId: BigInt(chainId), token: a.address.toLowerCase() as Hex, weightBps: a.weightBps });
  }
  if (total !== TOTAL_BPS) return { ok: false, reason: `weights sum to ${total} bps, not ${TOTAL_BPS}` };
  const sorted = sortAllocations(out);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].chainId === sorted[i - 1].chainId && sorted[i].token === sorted[i - 1].token) return { ok: false, reason: `asset ${sorted[i].token} is listed twice` };
  }
  return { ok: true, allocations: sorted };
}

/** StrategyCompositions.computeCompositionHash: keccak256(abi.encode(allocations)), allocations in contract order. */
export function computeOnchainCompositionHash(allocations: OnchainAllocation[]): Hex {
  return keccak256(encodeAbiParameters([ALLOCATION_TUPLE], [allocations.map((a) => ({ chainId: a.chainId, token: a.token, weightBps: a.weightBps }))]));
}

/** Contract-call form of the allocations (what publishComposition takes). */
export function toContractAllocations(allocations: OnchainAllocation[]) {
  return allocations.map((a) => ({ chainId: a.chainId, token: a.token, weightBps: a.weightBps }));
}

export interface CompositionComparison {
  matches: boolean;
  detail: string;
}

/** True when what the chain holds is exactly the allocation list derived from the definition. */
export function compareComposition(expected: OnchainAllocation[], onchain: readonly { chainId: bigint | number; token: string; weightBps: number | bigint }[]): CompositionComparison {
  if (expected.length !== onchain.length) return { matches: false, detail: `${onchain.length} allocations on-chain, ${expected.length} in the definition` };
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const o = onchain[i];
    if (BigInt(o.chainId) !== e.chainId || o.token.toLowerCase() !== e.token || Number(o.weightBps) !== e.weightBps) {
      return { matches: false, detail: `allocation ${i}: on-chain ${o.token} ${Number(o.weightBps)} bps on chain ${o.chainId}, definition ${e.token} ${e.weightBps} bps on chain ${e.chainId}` };
    }
  }
  return { matches: true, detail: `${expected.length} allocations match` };
}

const ALLOCATION_COMPONENTS = [
  { name: 'chainId', type: 'uint64' },
  { name: 'token', type: 'address' },
  { name: 'weightBps', type: 'uint16' },
] as const;

/** Functions and the event of StrategyCompositions.sol used by BAG (kept in sync with the artifact by a contract test). */
export const STRATEGY_COMPOSITIONS_ABI = [
  {
    type: 'function',
    name: 'publishComposition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'version', type: 'uint32' },
      { name: 'allocations', type: 'tuple[]', components: ALLOCATION_COMPONENTS },
    ],
    outputs: [{ name: 'compositionHash', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isPublished',
    stateMutability: 'view',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'version', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'compositionOf',
    stateMutability: 'view',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'version', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'tuple[]', components: ALLOCATION_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'compositionHashOf',
    stateMutability: 'view',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'version', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'event',
    name: 'CompositionPublished',
    anonymous: false,
    inputs: [
      { name: 'strategyId', type: 'bytes32', indexed: true },
      { name: 'version', type: 'uint32', indexed: true },
      { name: 'compositionHash', type: 'bytes32', indexed: false },
      { name: 'allocations', type: 'tuple[]', indexed: false, components: ALLOCATION_COMPONENTS },
    ],
  },
] as const;

interface CompositionReader {
  readContract(args: { address: Hex; abi: typeof STRATEGY_COMPOSITIONS_ABI; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

/** Reads one version's published allocations, or null when none were published. */
export async function readOnchainComposition(client: CompositionReader, contract: Hex, strategyId: Hex, version: number): Promise<OnchainAllocation[] | null> {
  const published = (await client.readContract({ address: contract, abi: STRATEGY_COMPOSITIONS_ABI, functionName: 'isPublished', args: [strategyId, version] })) as boolean;
  if (!published) return null;
  const rows = (await client.readContract({ address: contract, abi: STRATEGY_COMPOSITIONS_ABI, functionName: 'compositionOf', args: [strategyId, version] })) as {
    chainId: bigint;
    token: string;
    weightBps: number;
  }[];
  return rows.map((r) => ({ chainId: BigInt(r.chainId), token: r.token.toLowerCase() as Hex, weightBps: Number(r.weightBps) }));
}
