import { keccak256, stringToHex } from 'viem';
import { isBagChain, normalizeAddress } from './chains';
import { canonicalJson } from './json';
import { BAG_JSON_HASH_DOMAIN, type BagAssetDisplay, type BagDefinition, type BagDocument, type Hex } from './types';

// -----------------------------------------------------------------------------
// Canonical form and definitionHash of a bag.json v1 definition. Pure.
//
//   definitionHash = keccak256(utf8("bag.json/v1\n" + JCS(normalize(definition))))
//
// normalize: EVM addresses trimmed and lowercased; assets sorted by chain, then
// address, by UTF-16 code unit (never localeCompare); exactly the definition's
// keys, nothing added, no default filled in. Frozen with v1: any change to
// what is hashed or how it is normalized is bag.json/v2.
// -----------------------------------------------------------------------------

/**
 * The structural shape the hash covers. Wider than `BagDefinition` (chain and enum values are plain strings)
 * so a host application with its own chain type can hash with this exact code; `parseBag` is what narrows a
 * document to the v1 enums.
 */
export interface HashableDefinition {
  kind: string | null;
  chain: string;
  mutability: string | null;
  assets: { chain: string; address: string; decimals: number; weightBps: number }[];
  rules: {
    weightBounds: { minBps: number | null; maxBps: number | null };
    maxAssets: number | null;
    minInvestment: { amount: string; measuredAs: string } | null;
    swapSlippageBps: number | null;
    rebalance: { frequency: string | null; driftThresholdBps: number | null } | null;
    performanceFeeBps: number | null;
    noRouteAssetPolicy: string | null;
  };
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** v1 chains are EVM (lowercased); an address on any other chain is only trimmed (parseBag rejects such chains). */
const canonicalAddress = (chain: string, address: string) => (isBagChain(chain) ? normalizeAddress(address) : address.trim());

/** Canonical copy of a definition: normalized addresses, assets in (chain, address) order. Idempotent. */
export function normalizeDefinition<D extends HashableDefinition>(def: D): D;
export function normalizeDefinition(def: HashableDefinition): HashableDefinition {
  const assets = def.assets
    .map((a) => ({ chain: a.chain, address: canonicalAddress(a.chain, a.address), decimals: a.decimals, weightBps: a.weightBps }))
    .sort((a, b) => byCodeUnits(a.chain, b.chain) || byCodeUnits(a.address, b.address));
  const r = def.rules;
  return {
    kind: def.kind,
    chain: def.chain,
    mutability: def.mutability,
    assets,
    rules: {
      weightBounds: { minBps: r.weightBounds.minBps, maxBps: r.weightBounds.maxBps },
      maxAssets: r.maxAssets,
      minInvestment: r.minInvestment ? { amount: r.minInvestment.amount, measuredAs: r.minInvestment.measuredAs } : null,
      swapSlippageBps: r.swapSlippageBps,
      rebalance: r.rebalance ? { frequency: r.rebalance.frequency, driftThresholdBps: r.rebalance.driftThresholdBps } : null,
      performanceFeeBps: r.performanceFeeBps,
      noRouteAssetPolicy: r.noRouteAssetPolicy,
    },
  };
}

/** The exact string the hash covers: domain prefix + JCS of the normalized definition. */
export function definitionHashPreimage(def: HashableDefinition): string {
  return BAG_JSON_HASH_DOMAIN + canonicalJson(normalizeDefinition(def));
}

export function computeDefinitionHash(def: HashableDefinition): Hex {
  return keccak256(stringToHex(definitionHashPreimage(def)));
}

/** Display entries in definition order, with normalized addresses. Not hashed. */
export function normalizeAssetDisplay(assets: BagAssetDisplay[]): BagAssetDisplay[] {
  return assets
    .map((a) => ({ chain: a.chain, address: normalizeAddress(a.address), symbol: a.symbol }))
    .sort((a, b) => byCodeUnits(a.chain, b.chain) || byCodeUnits(a.address, b.address));
}

/**
 * Canonical copy of a parsed document: normalized definition and metadata asset list. Fields BAG adds when
 * serving a stored version are kept as they are (none of them is hashed). Idempotent.
 */
export function normalizeBag(bag: BagDocument): BagDocument {
  const out: BagDocument = { ...bag, definition: normalizeDefinition(bag.definition) };
  if (bag.metadata) out.metadata = { ...bag.metadata, assets: normalizeAssetDisplay(bag.metadata.assets) };
  return out;
}

/** definitionHash of a document (or of a bare definition). Never reads the document's stated hash. */
export function hashBag(bag: BagDocument | BagDefinition): Hex {
  return computeDefinitionHash('bagJson' in bag ? bag.definition : bag);
}
