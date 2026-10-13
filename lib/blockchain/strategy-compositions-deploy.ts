import type { Hex, PublicClient } from 'viem';

// -----------------------------------------------------------------------------
// Read-back checks for a StrategyCompositions deployment
// (scripts/deploy-strategy-compositions.ts, docs/STRATEGY_COMPOSITIONS_DESIGN.md).
// All checks run, so one report shows everything that is wrong.
// -----------------------------------------------------------------------------

const READ_ABI = [
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'TOTAL_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MAX_ALLOCATIONS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/** StrategyRegistry.strategyOf, to check the registry address really is a StrategyRegistry. */
const REGISTRY_PROBE_ABI = [
  {
    type: 'function',
    name: 'strategyOf',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [{ name: 'creator', type: 'address' }, { name: 'latestVersion', type: 'uint32' }, { name: 'forkOfStrategyId', type: 'bytes32' }, { name: 'forkOfVersion', type: 'uint32' }] }],
  },
] as const;

export interface CompositionsCheck {
  name: string;
  ok: boolean;
  actual: string;
  expected: string;
}

/** True when `registry` has code and answers StrategyRegistry.strategyOf. */
export async function isStrategyRegistry(client: Pick<PublicClient, 'getCode' | 'readContract'>, registry: Hex): Promise<boolean> {
  const code = await client.getCode({ address: registry });
  if (!code || code === '0x') return false;
  try {
    await client.readContract({ address: registry, abi: REGISTRY_PROBE_ABI, functionName: 'strategyOf', args: [`0x${'0'.repeat(64)}`] });
    return true;
  } catch {
    return false;
  }
}

export async function verifyCompositionsDeployment(
  client: Pick<PublicClient, 'getCode' | 'readContract' | 'getBalance' | 'getChainId'>,
  address: Hex,
  expected: { chainId: number; registry: Hex }
): Promise<CompositionsCheck[]> {
  const check = (name: string, actual: string, want: string, ok = actual.toLowerCase() === want.toLowerCase()): CompositionsCheck => ({ name, ok, actual, expected: want });
  const code = await client.getCode({ address });
  if (!code || code === '0x') return [check('contract code', 'none', 'deployed bytecode', false)];
  const read = (functionName: 'registry' | 'TOTAL_BPS' | 'MAX_ALLOCATIONS') => client.readContract({ address, abi: READ_ABI, functionName });
  const [chainId, registry, total, max, balance] = await Promise.all([client.getChainId(), read('registry'), read('TOTAL_BPS'), read('MAX_ALLOCATIONS'), client.getBalance({ address })]);
  return [
    check('chain', String(chainId), String(expected.chainId)),
    check('registry', String(registry), expected.registry),
    check('registry is a StrategyRegistry', String(await isStrategyRegistry(client, registry as Hex)), 'true'),
    check('TOTAL_BPS', String(total), '10000'),
    check('MAX_ALLOCATIONS', String(max), '64'),
    check('ETH balance held', String(balance), '0'),
  ];
}
