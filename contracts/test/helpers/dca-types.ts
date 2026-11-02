// EIP-712 types of BagDcaExecutor.DcaAuthorization, shared by the local and fork tests.
export const DCA_TYPES = {
  DcaAuthorization: [
    { name: 'owner', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'bag', type: 'BagRef' },
    { name: 'assets', type: 'AssetLimit[]' },
    { name: 'schedule', type: 'Schedule' },
    { name: 'route', type: 'Route' },
    { name: 'nonce', type: 'uint256' },
  ],
  AssetLimit: [
    { name: 'asset', type: 'address' },
    { name: 'symbol', type: 'string' },
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
    { name: 'adapter', type: 'address' },
    { name: 'swapRouter', type: 'address' },
    { name: 'allowedFees', type: 'uint24[]' },
  ],
  Schedule: [
    { name: 'amountPerRun', type: 'uint256' },
    { name: 'totalBudget', type: 'uint256' },
    { name: 'maxRuns', type: 'uint32' },
    { name: 'startsAt', type: 'uint64' },
    { name: 'periodSeconds', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;
