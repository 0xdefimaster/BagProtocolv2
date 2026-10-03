// -----------------------------------------------------------------------------
// Mirrors the subset of contracts/Bag.sol public getters used for verification — read surface only,
// used by lib/blockchain/evm/adapter.ts's verifyBagCreation() to confirm
// `Bag.creator()` on-chain matches the authenticated wallet (spec section
// 13, item 11). No write functions here: nothing in this codebase ever
// calls a Bag directly — Bags are only ever created via BagFactory
// (lib/blockchain/evm/factory-abi.ts) and read via BagExecutionRouter.
// -----------------------------------------------------------------------------
export const bagAbi = [
  {
    type: 'function',
    name: 'creator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'bagId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'offChainRef',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  { type: 'function', name: 'isMutable', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'compositionHash', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'metadataURI', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  {
    type: 'event',
    name: 'CompositionUpdated',
    anonymous: false,
    inputs: [
      { name: 'version', type: 'uint256', indexed: true },
      { name: 'compositionHash', type: 'bytes32', indexed: false },
      { name: 'metadataURI', type: 'string', indexed: false },
    ],
  },
] as const;
