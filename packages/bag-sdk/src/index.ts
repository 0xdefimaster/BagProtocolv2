// @bag-protocol/sdk — the bag.json v1 artifact layer.
// parse → validate → normalize → hash, plus independent StrategyRegistry verification.
// Depends on viem and standard Web APIs only. Spec: ../README.md.

export { BAG_V1_CHAINS, BAG_V1_CHAIN_SLUGS, chainIdOf, isBagChain, normalizeAddress, type BagChain } from './chains';
export {
  BAG_JSON_FORMAT_VERSION,
  BAG_JSON_HASH_DOMAIN,
  MUTABILITIES,
  NO_ROUTE_ASSET_POLICIES,
  REBALANCE_FREQUENCIES,
  STRATEGY_KINDS,
  type BagAssetDisplay,
  type BagDefinition,
  type BagDefinitionAsset,
  type BagDocument,
  type BagIssue,
  type BagMetadata,
  type Hex,
  type IssueSeverity,
  type Mutability,
  type NoRouteAssetPolicy,
  type RebalanceFrequency,
  type StrategyKind,
} from './types';
export { canonicalJson, parseJsonStrict, JsonSyntaxError } from './json';
export { parseBag, type ParseResult } from './parse';
export { validateBag, V1_LIMITS, V1_RULE_DEFAULTS, type BagValidation, type TokenInfo, type ValidateBagOptions } from './validate';
export { computeDefinitionHash, definitionHashPreimage, hashBag, normalizeAssetDisplay, normalizeBag, normalizeDefinition, type HashableDefinition } from './definition';
export {
  checkRegistryCommitment,
  offChainRefOf,
  readRegistryRecord,
  registryStrategyId,
  STRATEGY_REGISTRY_READ_ABI,
  verifyRegistryCommitment,
  type ContractReader,
  type RegistryRecord,
  type RegistryVerification,
} from './registry';
export { fetchBag, MAX_BAG_JSON_BYTES, readTokenDecimals } from './load';
