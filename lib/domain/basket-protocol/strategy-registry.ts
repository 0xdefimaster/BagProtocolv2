import type { Hex } from 'viem';
import type { BagJson } from '@/types/strategy';
import { computeDefinitionHash } from './bag-json';
import { computeOnChainBagId, deriveOnChainBagId } from './onchain';

// -----------------------------------------------------------------------------
// StrategyRegistry — the off-chain half of identity verification
// (contracts/StrategyRegistry.sol, docs/STRATEGY_REGISTRY_DESIGN.md). Pure.
//
// A third party holding only a bag.json, the creator's address and read access
// to the registry can check that the bag.json IS the definition the creator
// committed to on-chain. The bag.json's own `definitionHash` field is never
// trusted: the hash is recomputed from `definition`.
// -----------------------------------------------------------------------------

/** Registry id of a BAG strategy: keccak256(abi.encode(creator, offChainRef(uuid))) — the same id BagFactory gives the Bag. */
export function registryStrategyId(creator: string, strategyUuid: string): Hex {
  return deriveOnChainBagId(creator, computeOnChainBagId(strategyUuid));
}

/** What the verifier read from the chain for one (strategyId, version). */
export interface RegistryRecord {
  registryStrategyId: Hex;
  creator: string;
  version: number;
  /** The committed hash, or null when that version is not registered. */
  definitionHash: Hex | null;
  fork: { parentStrategyId: Hex; parentVersion: number } | null;
}

export type CommitmentCheckName =
  | 'DEFINITION_HASH_RECOMPUTED'
  | 'STRATEGY_ID_BOUND_TO_CREATOR'
  | 'VERSION_REGISTERED'
  | 'DEFINITION_MATCHES_REGISTRY';

export interface CommitmentVerification {
  verified: boolean;
  /** The hash recomputed from `bagJson.definition` (what was compared). */
  recomputedDefinitionHash: string;
  checks: { name: CommitmentCheckName; ok: boolean; detail: string }[];
}

/**
 * Checks a bag.json against a registry record:
 *  1. the definitionHash recomputed from `definition` equals the bag.json's stated hash (the file is self-consistent);
 *  2. the registry id is the one derived from the record's creator and the bag.json's strategyId (no other creator's entry);
 *  3. the bag.json's version is registered;
 *  4. the registry's committed hash for that version equals the recomputed hash.
 * `verified` only when all four hold.
 */
export function verifyBagJsonCommitment(bagJson: Pick<BagJson, 'definition' | 'definitionHash' | 'ref'>, record: RegistryRecord): CommitmentVerification {
  const recomputed = computeDefinitionHash(bagJson.definition).toLowerCase();
  let derivedId: string | null = null;
  try {
    derivedId = registryStrategyId(record.creator, bagJson.ref.strategyId).toLowerCase();
  } catch {
    derivedId = null;
  }
  const committed = record.definitionHash?.toLowerCase() ?? null;

  const checks: CommitmentVerification['checks'] = [
    {
      name: 'DEFINITION_HASH_RECOMPUTED',
      ok: recomputed === bagJson.definitionHash.toLowerCase(),
      detail: `recomputed ${recomputed}, bag.json states ${bagJson.definitionHash}`,
    },
    {
      name: 'STRATEGY_ID_BOUND_TO_CREATOR',
      ok: derivedId !== null && derivedId === record.registryStrategyId.toLowerCase(),
      detail:
        record.creator.toLowerCase() === `0x${'0'.repeat(40)}`
          ? `no strategy is registered under ${record.registryStrategyId} (wrong creator or not registered)`
          : `derived ${derivedId ?? 'n/a'} from creator ${record.creator} and strategy ${bagJson.ref.strategyId}; registry entry ${record.registryStrategyId}`,
    },
    {
      name: 'VERSION_REGISTERED',
      ok: committed !== null && record.version === bagJson.ref.version,
      detail: committed === null ? `version ${bagJson.ref.version} is not registered` : `version ${record.version} registered`,
    },
    {
      name: 'DEFINITION_MATCHES_REGISTRY',
      ok: committed !== null && committed === recomputed,
      detail: `registry ${committed ?? 'none'}, recomputed ${recomputed}`,
    },
  ];
  return { verified: checks.every((c) => c.ok), recomputedDefinitionHash: recomputed, checks };
}

/** View functions of StrategyRegistry.sol the verifier needs (kept in sync with the artifact by a contract test). */
export const STRATEGY_REGISTRY_READ_ABI = [
  {
    type: 'function',
    name: 'strategyOf',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'latestVersion', type: 'uint32' },
          { name: 'forkOfStrategyId', type: 'bytes32' },
          { name: 'forkOfVersion', type: 'uint32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'definitionHashOf',
    stateMutability: 'view',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'version', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'matches',
    stateMutability: 'view',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'version', type: 'uint32' },
      { name: 'definitionHash', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'deriveStrategyId',
    stateMutability: 'pure',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'offChainRef', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

const ZERO32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

interface RegistryReader {
  readContract(args: { address: Hex; abi: typeof STRATEGY_REGISTRY_READ_ABI; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

/** Reads one (strategyId, version) from a deployed registry. An unregistered version is `definitionHash: null`, never a guess. */
export async function readRegistryRecord(client: RegistryReader, registry: Hex, registryId: Hex, version: number): Promise<RegistryRecord> {
  const s = (await client.readContract({ address: registry, abi: STRATEGY_REGISTRY_READ_ABI, functionName: 'strategyOf', args: [registryId] })) as {
    creator: string;
    latestVersion: number;
    forkOfStrategyId: Hex;
    forkOfVersion: number;
  };
  const registered = s.creator.toLowerCase() !== ZERO_ADDRESS && Number.isInteger(version) && version >= 1 && version <= Number(s.latestVersion);
  const definitionHash = registered
    ? ((await client.readContract({ address: registry, abi: STRATEGY_REGISTRY_READ_ABI, functionName: 'definitionHashOf', args: [registryId, version] })) as Hex)
    : null;
  return {
    registryStrategyId: registryId,
    creator: s.creator,
    version,
    definitionHash,
    fork: s.forkOfStrategyId.toLowerCase() === ZERO32 ? null : { parentStrategyId: s.forkOfStrategyId, parentVersion: Number(s.forkOfVersion) },
  };
}
