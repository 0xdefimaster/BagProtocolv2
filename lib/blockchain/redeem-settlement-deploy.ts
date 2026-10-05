import { getAddress, isAddress, zeroAddress, type PublicClient } from 'viem';
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
  ];
}
