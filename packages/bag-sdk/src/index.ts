export { BagSdkError, getSdkErrorInfo, SDK_ERROR_MESSAGES, type BagSdkErrorCode, type SdkErrorInfo } from './errors';
// @bagprotocol/sdk — the bag.json v1 strategy core.
// parse → validate → normalize → hash → verify (StrategyRegistry). No transport: getting the bytes is an
// adapter's job (@bagprotocol/sdk/http, @bagprotocol/sdk/evm); routing is a ComposerProvider
// (@bagprotocol/sdk/lifi). The core depends on viem only. Spec: ../README.md.

export { BAG_V1_CHAINS, BAG_V1_CHAIN_SLUGS, chainIdOf, isBagChain, isNativeToken, NATIVE_TOKEN, normalizeAddress, type BagChain } from './chains';
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
export { validateBag, V1_LIMITS, type BagValidation, type TokenInfo, type ValidateBagOptions } from './validate';
export { resolveV1Rules, V1_DEFAULTS, type Resolved, type ResolvedV1Rules, type RuleSource } from './rules';
export { splitByWeight, V1_EXECUTION_TOLERANCE_BPS } from './split';
export { computeDefinitionHash, definitionHashPreimage, hashBag, normalizeAssetDisplay, normalizeBag, normalizeDefinition, type HashableDefinition } from './definition';
export {
  checkRegistryCommitment,
  offChainRefOf,
  readRegistryRecord,
  registryStrategyId,
  STRATEGY_REGISTRY_DEPLOYMENTS,
  STRATEGY_REGISTRY_READ_ABI,
  verifyRegistryCommitment,
  type ContractReader,
  type RegistryClient,
  type RegistryRecord,
  type RegistryVerification,
  type StrategyRegistryDeployment,
} from './registry';
export {
  largestRemainderBps,
  PARTITION_MAX_PARTS,
  PartitionError,
  partitionAmounts,
  planPartition,
  planPartitionLegs,
  simulatePartition,
  type LegTarget,
  type PartitionedLegs,
  type PartitionPlan,
} from './partition';
export { planPurchase, PurchasePlanError, SDK_EXECUTION_ACCOUNTING, V1_EXECUTION_POLICY, type PlannedLeg, type PurchasePlan, type PurchaseRequest } from './purchase';
export {
  compileBag,
  ProviderResponseError,
  quoteBag,
  simulateBag,
  type CompiledPurchase,
  type ComposerCompileRequest,
  type ComposerCompileResult,
  type ComposerProvider,
  type ExecutionTrustPolicy,
  type ProviderFee,
  type ProviderWarning,
  type PurchaseQuote,
  type QuotedFee,
  type QuotedLeg,
  type SimulateBagOptions,
  type SimulationClient,
  type SimulationResult,
} from './execution';

export {
  bagFactoryCompositionHash,
  buildRecurringAuthorization,
  compareRecurringAuthorization,
  decodeRecurringAuthorizationTypedData,
  FUNDING_KINDS,
  RECURRING_ALLOWED_FEE_TIERS,
  RECURRING_AUTHORIZATION_TYPES,
  RECURRING_EXECUTOR_ABI,
  RECURRING_MAX_ASSETS,
  RECURRING_PURCHASE_DOMAIN,
  RECURRING_REVOCATION_TYPES,
  recurringAuthorizationId,
  recurringAuthorizationTypedData,
  recurringChainIdOf,
  recurringLegAmounts,
  recurringMinimumOutputs,
  recurringRevocationTypedData,
  recurringWindowAt,
  summarizeRecurringAuthorization,
  verifyRecurringPurchaseReceipt,
  type RecurringAssetLimit,
  type RecurringAuthorization,
  type RecurringDeployment,
  type RecurringReceiptClient,
  type RecurringReceiptVerification,
  type RecurringSummary,
  type RecurringTermsInput,
} from './recurring';

export {
  verifyPurchaseReceipt,
  type PurchaseReceiptClient,
  type PurchaseReceiptLog,
  type PurchaseReceiptTransaction,
  type PurchaseTransactionReceipt,
  type PurchaseReceiptIssueCode,
  type PurchaseReceiptVerification,
  type VerifyPurchaseReceiptOptions,
  type PurchaseEvidenceContext,
  type PurchaseBalanceEvidence,
  type PurchaseCallEvidence,
} from './receipt';
