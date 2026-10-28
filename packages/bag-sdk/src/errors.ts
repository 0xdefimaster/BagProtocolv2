/** Stable diagnostic summaries. Never interpolate URLs, credentials, upstream messages, stacks or causes. */
export const SDK_ERROR_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Check the operation arguments.',
  CLIENT_CAPABILITY_MISSING: 'The chain reader is missing a required method.',
  PURCHASE_PLAN_INVALID: 'The purchase does not satisfy the strategy or execution policy. Inspect its structured issues.',
  TRUST_POLICY_INVALID: 'Supply a valid chain-scoped execution trust policy.',
  CHAIN_MISMATCH: 'The operation and chain reader must use the same chain.',
  PROVIDER_RESPONSE_INVALID: 'The provider response could not be accepted.',
  UNTRUSTED_TARGET: 'The returned transaction target is outside the reviewed trust policy.',
  UNTRUSTED_SPENDER: 'The returned approval spender is outside the reviewed trust policy.',
  APPROVAL_INVALID: 'The returned approval does not match the planned input or amount.',
  OUTPUT_INVALID: 'The returned output does not match the planned token or positive output bounds.',
  SLIPPAGE_EXCEEDED: 'The returned minimum output exceeds the permitted slippage.',
  PRICE_IMPACT_INVALID: 'The provider did not report a valid price impact.',
  PRICE_IMPACT_EXCEEDED: 'The reported price impact exceeds the configured limit.',
  QUOTE_EXPIRED: 'Obtain a fresh quote before signing.',
  QUOTE_TIMING_INVALID: 'Quote timing is unavailable or malformed. Recompile before applying an age policy.',
  FEE_METADATA_INVALID: 'The provider fee metadata is malformed.',
  WARNING_METADATA_INVALID: 'The provider warning metadata is malformed.',
  COMPOSER_CONFIGURATION_INVALID: 'Check Composer credentials, endpoint and timeout configuration.',
  COMPOSER_PARTIAL_RESULT: 'Composer did not produce a complete successful purchase.',
  ACCOUNT_DEPLOYMENT_INVALID: 'Supply an independently reviewed deployment pin and signer.',
  ACCOUNT_DEPLOYMENT_MISMATCH: 'The observed deployment differs from the reviewed pin.',
  ACCOUNT_PROXY_MISMATCH: 'The observed or returned proxy does not match the planned wallet.',
  ACCOUNT_OBSERVATION_INVALID: 'The chain reader returned an invalid account observation.',
  ACCOUNT_OBSERVATION_CHANGED: 'Canonical inclusion changed. Repeat account verification.',
  RPC_READ_FAILED: 'The caller-provided chain reader is unavailable or could not complete the required reads.',
  HTTP_TIMEOUT: 'Strategy retrieval exceeded its deadline.',
  HTTP_ABORTED: 'Strategy retrieval was cancelled.',
  HTTP_NETWORK_ERROR: 'The strategy could not be retrieved.',
  HTTP_STATUS_ERROR: 'The strategy endpoint returned an unsuccessful HTTP status.',
  HTTP_RESPONSE_TOO_LARGE: 'The strategy response exceeds the byte limit.',
  HTTP_INVALID_UTF8: 'The strategy response is not valid UTF-8.',
  HTTP_BODY_READ_ERROR: 'The strategy response body could not be read.',
  UNKNOWN_ERROR: 'The operation failed. Inspect the failure privately without logging credentials.',
} as const);

export type BagSdkErrorCode = keyof typeof SDK_ERROR_MESSAGES;
export interface SdkErrorInfo { code: BagSdkErrorCode; message: string }

export class BagSdkError extends Error {
  readonly code: BagSdkErrorCode;
  constructor(code: BagSdkErrorCode, message: string = SDK_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'BagSdkError';
    this.code = code;
  }
}

/** Safe for a diagnostic display. Detailed errors/issues remain available separately. */
export function getSdkErrorInfo(error: unknown): SdkErrorInfo {
  try {
    if (error instanceof BagSdkError && Object.prototype.hasOwnProperty.call(SDK_ERROR_MESSAGES, error.code)) {
      return { code: error.code, message: SDK_ERROR_MESSAGES[error.code] };
    }
  } catch { /* Foreign objects can throw from getters. */ }
  return { code: 'UNKNOWN_ERROR', message: SDK_ERROR_MESSAGES.UNKNOWN_ERROR };
}
