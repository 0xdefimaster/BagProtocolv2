import { encodeAbiParameters, keccak256 } from 'viem';
import { BAG_V1_CHAINS, type BagChain } from './chains';
import { computeDefinitionHash } from './definition';
import type { BagDocument, Hex } from './types';

// -----------------------------------------------------------------------------
// Independent verification of a bag.json against StrategyRegistry
// (contracts/StrategyRegistry.sol, docs/STRATEGY_REGISTRY_DESIGN.md).
//
// The creator is a VERIFICATION INPUT, never a field read from the JSON. The
// creator is not in definitionHash, so a bag.json alone cannot say who wrote
// it; the caller states which creator they expect, and the check is:
//
//   expected creator + ref.strategyId → strategyId (creator-bound)
//   → registry record for (strategyId, ref.version)
//   → committed definitionHash == hash recomputed from the definition
//
// `commitments.registry` (creator, registry id, tx) in a served bag.json is
// BAG's own claim and is ignored here, as is the stated `definitionHash`.
// -----------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO32 = `0x${'0'.repeat(64)}`;

/** A StrategyRegistry deployment: the full address on one chain. */
export interface StrategyRegistryDeployment {
  chainId: number;
  address: Hex;
  /** Block of the deployment transaction; reads before it see no code. */
  deployedAtBlock: number;
}

/**
 * Known StrategyRegistry deployments, by v1 chain. A chain without an entry has no registry: verification there
 * needs an address the caller trusts. Robinhood Chain: deployed by BAG at block 85332074.
 */
export const STRATEGY_REGISTRY_DEPLOYMENTS: Readonly<Partial<Record<BagChain, StrategyRegistryDeployment>>> = Object.freeze({
  robinhood: Object.freeze({ chainId: BAG_V1_CHAINS.robinhood, address: '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8' as Hex, deployedAtBlock: 85332074 }),
});

/** offChainRef of a BAG strategy UUID: the 16 UUID bytes, left-padded to bytes32. */
export function offChainRefOf(strategyUuid: string): Hex {
  if (!UUID_RE.test(strategyUuid)) throw new Error(`"${strategyUuid}" is not a lowercase UUID.`);
  return `0x${strategyUuid.replace(/-/g, '').padStart(64, '0')}`;
}

/** keccak256(abi.encode(creator, offChainRef)): StrategyRegistry.deriveStrategyId and BagFactory.deriveBagId. */
export function registryStrategyId(creator: string, strategyUuid: string): Hex {
  if (!ADDRESS_RE.test(creator)) throw new Error(`creator "${creator}" is not an address.`);
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator.toLowerCase() as Hex, offChainRefOf(strategyUuid)]));
}

/** What the registry holds for one (strategyId, version). */
export interface RegistryRecord {
  registryStrategyId: Hex;
  /** Creator stored on-chain; the zero address when nothing is registered under the id. */
  creator: string;
  latestVersion: number;
  version: number;
  /** The committed hash, or null when that version is not registered. */
  definitionHash: Hex | null;
  fork: { parentStrategyId: Hex; parentVersion: number } | null;
}

export type RegistryCheckName = 'REF_PRESENT' | 'STRATEGY_REGISTERED_BY_EXPECTED_CREATOR' | 'VERSION_REGISTERED' | 'DEFINITION_MATCHES_REGISTRY';

export interface RegistryVerification {
  verified: boolean;
  expectedCreator: string;
  registryStrategyId: Hex | null;
  recomputedDefinitionHash: Hex;
  fork: RegistryRecord['fork'];
  checks: { name: RegistryCheckName; ok: boolean; detail: string }[];
}

/** Pure half of the check: compares a document with a record already read for `registryStrategyId(expectedCreator, ref.strategyId)`. */
export function checkRegistryCommitment(bag: BagDocument, expectedCreator: string, record: RegistryRecord | null): RegistryVerification {
  const recomputed = computeDefinitionHash(bag.definition);
  const checks: RegistryVerification['checks'] = [];
  const done = (id: Hex | null): RegistryVerification => ({
    verified: checks.length === 4 && checks.every((c) => c.ok),
    expectedCreator,
    registryStrategyId: id,
    recomputedDefinitionHash: recomputed,
    fork: record?.fork ?? null,
    checks,
  });

  if (!bag.ref) {
    checks.push({ name: 'REF_PRESENT', ok: false, detail: 'The document has no ref (strategyId + version): there is nothing to look up. A draft bag.json can be hashed but not registry-verified.' });
    return done(null);
  }
  checks.push({ name: 'REF_PRESENT', ok: true, detail: `strategy ${bag.ref.strategyId} v${bag.ref.version}` });

  const id = registryStrategyId(expectedCreator, bag.ref.strategyId);
  const sameId = record !== null && record.registryStrategyId.toLowerCase() === id.toLowerCase();
  const byCreator = sameId && record.creator.toLowerCase() === expectedCreator.toLowerCase() && record.creator.toLowerCase() !== ZERO_ADDRESS;
  checks.push({
    name: 'STRATEGY_REGISTERED_BY_EXPECTED_CREATOR',
    ok: byCreator,
    detail: byCreator ? `${id} registered by ${record!.creator}` : `nothing registered under ${id} (derived from expected creator ${expectedCreator})`,
  });

  const committed = byCreator && record!.version === bag.ref.version ? record!.definitionHash : null;
  checks.push({ name: 'VERSION_REGISTERED', ok: committed !== null, detail: committed === null ? `version ${bag.ref.version} is not registered` : `version ${bag.ref.version} registered` });
  checks.push({
    name: 'DEFINITION_MATCHES_REGISTRY',
    ok: committed !== null && committed.toLowerCase() === recomputed,
    detail: `registry ${committed ?? 'none'}, recomputed ${recomputed}`,
  });
  return done(id);
}

/** The StrategyRegistry view functions the verifier reads. */
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
] as const;

/** Anything with viem's `readContract` (a viem PublicClient). The caller owns the RPC; the SDK has none. */
export interface ContractReader {
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

/** Reads one (strategyId, version). An unregistered version is `definitionHash: null`, never a guess. */
export async function readRegistryRecord(client: ContractReader, registry: Hex, strategyId: Hex, version: number): Promise<RegistryRecord> {
  const s = (await client.readContract({ address: registry, abi: STRATEGY_REGISTRY_READ_ABI, functionName: 'strategyOf', args: [strategyId] })) as {
    creator: string;
    latestVersion: number;
    forkOfStrategyId: Hex;
    forkOfVersion: number;
  };
  const latestVersion = Number(s.latestVersion);
  const registered = s.creator.toLowerCase() !== ZERO_ADDRESS && Number.isInteger(version) && version >= 1 && version <= latestVersion;
  const definitionHash = registered
    ? ((await client.readContract({ address: registry, abi: STRATEGY_REGISTRY_READ_ABI, functionName: 'definitionHashOf', args: [strategyId, version] })) as Hex)
    : null;
  return {
    registryStrategyId: strategyId,
    creator: s.creator,
    latestVersion,
    version,
    definitionHash,
    fork: s.forkOfStrategyId.toLowerCase() === ZERO32 ? null : { parentStrategyId: s.forkOfStrategyId, parentVersion: Number(s.forkOfVersion) },
  };
}

/**
 * Verifies a bag.json against a deployed StrategyRegistry with no BAG server involved: the caller supplies
 * the expected creator, the registry address and a client for the registry's chain. Read-only.
 */
export async function verifyRegistryCommitment(params: { bag: BagDocument; expectedCreator: string; registry: Hex; client: ContractReader }): Promise<RegistryVerification> {
  const { bag, expectedCreator, registry, client } = params;
  if (!bag.ref) return checkRegistryCommitment(bag, expectedCreator, null);
  const id = registryStrategyId(expectedCreator, bag.ref.strategyId);
  return checkRegistryCommitment(bag, expectedCreator, await readRegistryRecord(client, registry, id, bag.ref.version));
}
