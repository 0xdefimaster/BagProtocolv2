// -----------------------------------------------------------------------------
// Mirrors contracts/BagFactory.sol EXACTLY — deployment/orchestration
// surface only (user-signed model: `createBag` takes NO creator argument; the
// creator is `msg.sender`). If this ever needs a new entry, BagFactory.sol
// needs the matching function/event first; this file must never grow ahead
// of the actual contract.
// -----------------------------------------------------------------------------
export const bagFactoryAbi = [
  {
    type: 'function',
    name: 'createBag',
    stateMutability: 'payable',
    inputs: [
      { name: 'offChainRef', type: 'bytes32' },
      { name: 'compositionHash', type: 'bytes32' },
      { name: 'metadataURI', type: 'string' },
      { name: 'isMutable', type: 'bool' },
    ],
    outputs: [{ name: 'bag', type: 'address' }],
  },
  { type: 'function', name: 'creationFee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'event',
    name: 'CreationFeePaid',
    anonymous: false,
    inputs: [
      { name: 'bagId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'treasury', type: 'address', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'recordBagVersion',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'offChainRef', type: 'bytes32' },
      { name: 'expectedCurrentVersion', type: 'uint256' },
      { name: 'compositionHash', type: 'bytes32' },
      { name: 'metadataURI', type: 'string' },
    ],
    outputs: [{ name: 'newVersion', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'BagVersionRecorded',
    anonymous: false,
    inputs: [
      { name: 'bagId', type: 'bytes32', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'bag', type: 'address', indexed: true },
      { name: 'version', type: 'uint256', indexed: false },
      { name: 'compositionHash', type: 'bytes32', indexed: false },
      { name: 'metadataURI', type: 'string', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'deriveBagId',
    stateMutability: 'pure',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'offChainRef', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'bagOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'bagCountOf',
    stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'BagCreated',
    inputs: [
      { name: 'bagId', type: 'bytes32', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'offChainRef', type: 'bytes32', indexed: true },
      { name: 'bag', type: 'address', indexed: false },
      { name: 'compositionHash', type: 'bytes32', indexed: false },
      { name: 'version', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'error',
    name: 'AlreadyDeployed',
    inputs: [
      { name: 'bagId', type: 'bytes32' },
      { name: 'existing', type: 'address' },
    ],
  },
  { type: 'error', name: 'ZeroOffChainRef', inputs: [] },
  {
    type: 'error',
    name: 'WrongCreationFee',
    inputs: [
      { name: 'sent', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'FeeTransferFailed', inputs: [] },
] as const;
