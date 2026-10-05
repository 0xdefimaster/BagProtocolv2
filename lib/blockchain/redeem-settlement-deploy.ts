import { getAddress, isAddress, zeroAddress, type Hex, type PublicClient } from 'viem';
import { REDEEM_SETTLEMENT_EIP712_DOMAIN_NAME, REDEEM_SETTLEMENT_EIP712_DOMAIN_VERSION } from './redeem-settlement-eip712';

// -----------------------------------------------------------------------------
// Pre- and post-deployment checks for contracts/RedeemSettlement.sol, used by
// scripts/deploy-redeem-settlement.ts and tested against a real deployment on
// Hardhat (contracts/test/RedeemSettlementDeploy.test.ts).
//
// Two kinds of rule live here, and they are not the same thing:
//  - CONTRACT invariants: what RedeemSettlement itself enforces or fixes at
//    deployment (non-zero addresses, the USDG token, the EIP-712 domain). A
//    deployment that breaks one is wrong, whoever deployed it.
//  - OPERATIONAL guards: BAG's own deployment discipline. The contract does
//    not care whether owner == deployer or owner == attestor; we refuse those
//    because they merge separate trust boundaries (contract administration,
//    settlement authorization, a one-off deploy key).
// docs/REDEEM_SETTLEMENT_DEPLOYMENT.md.
// -----------------------------------------------------------------------------

export interface SettlementDeployConfig {
  chainId: number;
  expectedChainId: number;
  usdg: string;
  deployer: string;
  owner: string;
  attestor: string;
}

/** Problems with a planned deployment, before anything is sent. Empty = go. */
export function validateSettlementDeployConfig(c: SettlementDeployConfig): string[] {
  const problems: string[] = [];
  if (c.chainId !== c.expectedChainId) problems.push(`chain ${c.chainId} is not the expected ${c.expectedChainId}`);
  const named = { usdg: c.usdg, deployer: c.deployer, owner: c.owner, attestor: c.attestor } as const;
  for (const [name, value] of Object.entries(named)) {
    if (!isAddress(value, { strict: false })) problems.push(`${name} is not an address`);
    else if (getAddress(value) === zeroAddress) problems.push(`${name} is the zero address`);
  }
  if (problems.length > 0) return problems;
  const [deployer, owner, attestor] = [c.deployer, c.owner, c.attestor].map((a) => getAddress(a));
  // Operational guards (not contract rules): three separate keys.
  if (owner === deployer) problems.push('owner must not be the deployer (operational guard)');
  if (attestor === deployer) problems.push('attestor must not be the deployer (operational guard)');
  if (owner === attestor) problems.push('owner must not be the attestor (operational guard)');
  return problems;
}

const SETTLEMENT_READ_ABI = [
  { type: 'function', name: 'usdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'attestor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'MAX_FEE_RATE_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'extensions', type: 'uint256[]' },
    ],
  },
] as const;

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface SettlementExpectation {
  chainId: number;
  usdg: string;
  owner: string;
  attestor: string;
  /** The owner is meant to be a contract (e.g. a Safe). Otherwise an owner with contract code fails the check. */
  allowContractOwner?: boolean;
}

/**
 * What an address is, from its code:
 *  - EOA: no code.
 *  - EOA_7702: an EOA with an EIP-7702 delegation (code = 0xef0100 ‖ 20-byte delegate, 23 bytes), e.g. a MetaMask
 *    smart account. Its own key still produces ECDSA signatures that recover to it, so it can be the attestor.
 *  - CONTRACT: anything else. It cannot produce an ECDSA signature (the contract does not use ERC-1271), so it can
 *    never be the attestor; as owner it can only act through its own code — fine for a Safe, fatal for anything else
 *    (the first live deployment got a probe contract as owner this way and is unmanageable).
 */
export type AccountKind = 'EOA' | 'EOA_7702' | 'CONTRACT';

export function classifyAccountCode(code: Hex | undefined | null): AccountKind {
  if (!code || code === '0x') return 'EOA';
  if (/^0xef0100[0-9a-fA-F]{40}$/.test(code)) return 'EOA_7702';
  return 'CONTRACT';
}

export async function accountKind(client: PublicClient, address: `0x${string}`): Promise<AccountKind> {
  return classifyAccountCode(await client.getCode({ address }));
}

/** Problems with the owner/attestor accounts themselves (an attestor must be able to sign; an owner must be able to act). */
export function accountKindProblems(kinds: { owner: AccountKind; attestor: AccountKind }, allowContractOwner = false): string[] {
  const problems: string[] = [];
  if (kinds.attestor === 'CONTRACT') problems.push('attestor is a contract and can never sign a settlement');
  if (kinds.owner === 'CONTRACT' && !allowContractOwner) problems.push('owner is a contract (set the explicit contract-owner confirmation only for a Safe/multisig)');
  return problems;
}

export interface DeploymentCheck {
  name: string;
  ok: boolean;
  actual: string;
  expected: string;
}

/**
 * Reads a deployed RedeemSettlement back and compares every value that matters with what was intended. All checks
 * run (no early exit) so a report shows everything that is wrong at once.
 */
export async function verifySettlementDeployment(client: PublicClient, address: `0x${string}`, expected: SettlementExpectation): Promise<DeploymentCheck[]> {
  const read = <F extends 'usdg' | 'owner' | 'attestor' | 'MAX_FEE_RATE_BPS' | 'eip712Domain'>(functionName: F) =>
    client.readContract({ address, abi: SETTLEMENT_READ_ABI, functionName });
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const check = (name: string, actual: string, want: string, same = eq): DeploymentCheck => ({ name, ok: same(actual, want), actual, expected: want });

  const code = await client.getCode({ address });
  if (!code || code === '0x') return [check('contract code', 'none', 'deployed bytecode', () => false)];

  const [chainId, usdg, owner, attestor, maxFee, domain] = await Promise.all([
    client.getChainId(),
    read('usdg'),
    read('owner'),
    read('attestor'),
    read('MAX_FEE_RATE_BPS'),
    read('eip712Domain'),
  ]);
  const [, name, version, domainChainId, verifyingContract] = domain;
  const balance = await client.readContract({ address: usdg, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address] });
  const [ownerKind, attestorKind] = await Promise.all([accountKind(client, owner), accountKind(client, attestor)]);
  const signable = (k: string) => k === 'EOA' || k === 'EOA_7702';

  return [
    check('chain', String(chainId), String(expected.chainId)),
    check('usdg', usdg, expected.usdg),
    check('owner', owner, expected.owner),
    check('attestor', attestor, expected.attestor),
    check('MAX_FEE_RATE_BPS', String(maxFee), '3000'),
    check('EIP-712 name', name, REDEEM_SETTLEMENT_EIP712_DOMAIN_NAME, (a, b) => a === b),
    check('EIP-712 version', version, REDEEM_SETTLEMENT_EIP712_DOMAIN_VERSION, (a, b) => a === b),
    check('EIP-712 chainId', String(domainChainId), String(expected.chainId)),
    check('EIP-712 verifyingContract', verifyingContract, address),
    check('USDG balance held', String(balance), '0'),
    check('owner account', ownerKind, expected.allowContractOwner ? 'EOA, EOA_7702 or CONTRACT' : 'EOA or EOA_7702', (a) => signable(a) || (expected.allowContractOwner === true && a === 'CONTRACT')),
    check('attestor account', attestorKind, 'EOA or EOA_7702', (a) => signable(a)),
  ];
}
