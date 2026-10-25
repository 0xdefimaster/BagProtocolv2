// EIP-712 typed data the user signs: Delegation (DelegationManager domain) and PackedUserOperation
// (MultiSigDeleGator domain). Built here explicitly so the wallet signs exactly what is shown and what
// the contracts verify; the runner cross-checks digests against the on-chain contracts.
import { v, aa } from './fork-env.mjs';

export const ROOT_AUTHORITY = '0x' + 'f'.repeat(64);
export const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

export const DELEGATION_TYPES = {
  Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
  Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
};
export const USEROP_TYPES = {
  PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }, { name: 'entryPoint', type: 'address' }],
};
const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

/** Caveats for one plan delegation (Delegation Framework v1.3.0 term encodings). */
export function planCaveats(enforcers, spec) {
  return [
    { enforcer: enforcers.ERC20PeriodTransferEnforcer, terms: v.encodePacked(['address', 'uint256', 'uint256', 'uint256'], [spec.token, spec.periodAmount, spec.periodSeconds, spec.periodStart]), args: '0x' },
    { enforcer: enforcers.ERC20TransferAmountEnforcer, terms: v.encodePacked(['address', 'uint256'], [spec.token, spec.totalAmount]), args: '0x' },
    { enforcer: enforcers.LimitedCallsEnforcer, terms: v.encodePacked(['uint256'], [spec.maxCalls]), args: '0x' },
    { enforcer: enforcers.TimestampEnforcer, terms: v.encodePacked(['uint128', 'uint128'], [spec.notBefore, spec.notAfter]), args: '0x' },
    { enforcer: enforcers.RedeemerEnforcer, terms: v.getAddress(spec.redeemer), args: '0x' },
    { enforcer: enforcers.AllowedCalldataEnforcer, terms: v.concat([v.toHex(4n, { size: 32 }), v.pad(v.getAddress(spec.transferRecipient), { size: 32 })]), args: '0x' },
  ];
}

export function delegationTypedData({ delegationManager, delegate, delegator, caveats, salt }) {
  return { types: { EIP712Domain: EIP712_DOMAIN, ...DELEGATION_TYPES }, primaryType: 'Delegation',
    domain: { name: 'DelegationManager', version: '1', chainId: 4663, verifyingContract: delegationManager },
    message: { delegate, delegator, authority: ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt } }; // args are not signed
}
export const stripEip712Domain = td => { const { EIP712Domain, ...types } = td.types; return { ...td, types }; };
export const typedDigest = td => v.hashTypedData(stripEip712Domain(td));

/** The delegation struct the DelegationManager expects (caveats carry args; signature appended). */
export const delegationStruct = (td, signature) => ({ ...td.message, caveats: td.message.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' })), salt: BigInt(td.message.salt), signature });
export const DELEGATION_ABI_TYPE = { type: 'tuple[]', components: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
  { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] };
export const permissionContext = d => v.encodeAbiParameters([DELEGATION_ABI_TYPE], [[d]]);
export const asTuple = d => [d.delegate, d.delegator, d.authority, d.caveats.map(c => [c.enforcer, c.terms, c.args]), d.salt, d.signature];

/** Single-call ERC-7579 execute((target,value,data)) as encoded by Smart Accounts Kit for one call. */
export const executeCallData = (target, data, value = 0n) =>
  v.encodeFunctionData({ abi: v.parseAbi(['function execute((address target,uint256 value,bytes callData))']), functionName: 'execute', args: [{ target, value, callData: data }] });

/** A user operation bound to the fork-only paymaster and a validity window. */
export function userOperation({ sender, nonce, callData, paymaster, validUntil, validAfter = 0n, maxFeePerGas, maxPriorityFeePerGas = 1n }) {
  return { sender, nonce, callData, callGasLimit: 500_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n, maxFeePerGas, maxPriorityFeePerGas,
    paymaster, paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 0n, paymasterData: v.encodePacked(['uint48', 'uint48'], [validUntil, validAfter]), signature: '0x' };
}
export function userOpTypedData(op, account) {
  const packed = aa.toPackedUserOperation({ ...op, signature: '0x' });
  const { signature, ...message } = packed;
  return { types: { EIP712Domain: EIP712_DOMAIN, ...USEROP_TYPES }, primaryType: 'PackedUserOperation',
    domain: { name: 'MultiSigDeleGator', version: '1', chainId: 4663, verifyingContract: account }, message: { ...message, entryPoint: ENTRY_POINT } };
}

/** JSON-safe form for the browser and for eth_signTypedData_v4 (BigInt -> decimal string). */
export const toWire = td => JSON.parse(JSON.stringify(td, (_k, a) => (typeof a === 'bigint' ? a.toString() : a)));
