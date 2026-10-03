import { SupabaseClient } from '@supabase/supabase-js';
import { ChainId } from '@/types/basket-protocol';
import type { Hex } from 'viem';

// -----------------------------------------------------------------------------
// Persistence for a (bag, chain) deployment. Same security boundary as
// lib/server/bag-repo.ts: server-only, uses the service-role client, trusts the
// ids it is given — the caller (lib/server/deploy-bag.ts) is responsible for
// the ownership check and for on-chain verification BEFORE anything here runs.
//
// USER-SIGNED MODEL: there is exactly one write path,
// `confirmUserSignedDeployment()`, backed by the `confirm_bag_deployment`
// Postgres function (migration 0025). Prepare writes NOTHING, so there is no
// NOT_DEPLOYED -> DEPLOYING transition and no DEPLOYING state to get stuck in.
// The legacy backend-signed transitions (`startDeployment`, `confirmDeployment`,
// `failDeployment`) and the `start_bag_deployment` RPC were removed: nothing
// called them any more, and leaving them would have meant two competing
// deployment architectures.
// -----------------------------------------------------------------------------

/** 'DEPLOYING' is retained only because legacy rows may still carry it; the current flow never writes it. */
export type DeploymentStatus = 'NOT_DEPLOYED' | 'DEPLOYING' | 'DEPLOYED' | 'FAILED';

export interface BagDeployment {
  id: string;
  bagId: string;
  chain: ChainId;
  status: DeploymentStatus;
  factoryAddress: string | null;
  contractAddress: string | null;
  txHash: string | null;
  blockNumber: number | null;
  errorMessage: string | null;
  /**
   * The Bag's REAL on-chain identity (lowercase bytes32 hex), recorded from the confirmed `BagCreated` event —
   * `keccak256(abi.encode(creator, offChainRef))`. Execution reads THIS; it is never re-derived. Non-null for every
   * DEPLOYED row (DB check `bag_deployments_deployed_has_on_chain_id`). For deployments that predate creator-bound
   * ids this is the legacy UUID-as-bytes32 value (backfilled by migration 0024) and `onChainCreator` is null.
   */
  onChainBagId: Hex | null;
  /** The address `onChainBagId` is bound to (`BagCreated.creator`), lowercase. Null for legacy deployments. */
  onChainCreator: Hex | null;
  /** Mirrors the deployed Bag's `version()`: 1 at deployment, +1 per confirmed on-chain version (migration 0035). */
  onChainVersion?: number;
  createdAt: string;
  updatedAt: string;
}

interface BagDeploymentRow {
  id: string;
  bag_id: string;
  chain: string;
  status: string;
  factory_address: string | null;
  contract_address: string | null;
  tx_hash: string | null;
  block_number: number | null;
  error_message: string | null;
  on_chain_bag_id: string | null;
  on_chain_creator: string | null;
  on_chain_version?: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: BagDeploymentRow): BagDeployment {
  return {
    id: row.id,
    bagId: row.bag_id,
    chain: row.chain as ChainId,
    status: row.status as DeploymentStatus,
    factoryAddress: row.factory_address,
    contractAddress: row.contract_address,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    errorMessage: row.error_message,
    onChainBagId: (row.on_chain_bag_id ?? null) as Hex | null,
    onChainCreator: (row.on_chain_creator ?? null) as Hex | null,
    onChainVersion: row.on_chain_version ?? 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDeployment(admin: SupabaseClient, bagId: string, chain: ChainId): Promise<BagDeployment | null> {
  const { data, error } = await admin
    .from('bag_deployments')
    .select()
    .eq('bag_id', bagId)
    .eq('chain', chain)
    .maybeSingle<BagDeploymentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ConfirmUserSignedDeploymentInput {
  bagId: string;
  /** `bags.creator_id` of the authenticated session user — re-checked INSIDE the transaction. */
  creatorId: string;
  /** `bag_versions.id` whose composition hash was verified on-chain; the RPC refuses if the Bag's current version moved since. */
  bagVersionId: string;
  chain: ChainId;
  factoryAddress: string;
  contractAddress: string;
  txHash: string;
  blockNumber: number;
  /** `BagCreated.bagId` from the verified receipt — taken from the event, not recomputed. */
  onChainBagId: Hex;
  /** `BagCreated.creator` from the same event. */
  onChainCreator: Hex;
}

export interface BagFinalization {
  status: string;
  contractAddress: string | null;
  registryId: string | null;
}

export type ConfirmUserSignedDeploymentResult =
  | { outcome: 'CONFIRMED' | 'ALREADY_CONFIRMED'; deployment: BagDeployment; bag: BagFinalization }
  /** A DIFFERENT deployment already exists for this (bag, chain); it was NOT overwritten. */
  | { outcome: 'CONFLICT'; deployment: BagDeployment }
  /** The Bag's composition changed since the verified transaction was prepared; nothing was written. */
  | { outcome: 'STALE_VERSION' }
  /** Another Bag/chain already holds this tx hash or on-chain id; nothing was written. */
  | { outcome: 'IDENTITY_TAKEN' }
  | { outcome: 'BAG_NOT_FOUND' }
  | { outcome: 'FORBIDDEN' };

interface ConfirmRpcPayload {
  outcome: string;
  deployment?: BagDeploymentRow;
  bag?: { status: string; contract_address: string | null; registry_id: string | null };
}

/**
 * The user-signed flow's ONLY write: ONE database transaction that records the DEPLOYED row AND finalizes the Bag
 * (registry pointer + DRAFT -> ACTIVE), via the `confirm_bag_deployment` Postgres function. Idempotent for the same
 * (txHash, onChainBagId); a different deployment for an already-deployed (bag, chain) is a CONFLICT, never an
 * overwrite. All hex inputs are canonicalised to lowercase here (and again inside the function).
 */
export async function confirmUserSignedDeployment(
  admin: SupabaseClient,
  input: ConfirmUserSignedDeploymentInput
): Promise<ConfirmUserSignedDeploymentResult> {
  const fn = 'confirmUserSignedDeployment';
  if (!UUID_RE.test(input.bagId) || !UUID_RE.test(input.creatorId) || !UUID_RE.test(input.bagVersionId)) {
    throw new Error(`${fn}: bagId/creatorId/bagVersionId must be UUIDs.`);
  }
  if (!BYTES32_RE.test(input.txHash)) throw new Error(`${fn}: txHash "${input.txHash}" is not a 0x-prefixed bytes32.`);
  if (!BYTES32_RE.test(input.onChainBagId)) throw new Error(`${fn}: onChainBagId "${input.onChainBagId}" is not a 0x-prefixed bytes32.`);
  if (!ADDRESS_RE.test(input.onChainCreator)) throw new Error(`${fn}: onChainCreator "${input.onChainCreator}" is not a 0x-prefixed address.`);
  if (!ADDRESS_RE.test(input.contractAddress) || !ADDRESS_RE.test(input.factoryAddress)) {
    throw new Error(`${fn}: contractAddress/factoryAddress must be 0x-prefixed addresses.`);
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) throw new Error(`${fn}: invalid blockNumber.`);

  const { data, error } = await admin.rpc('confirm_bag_deployment', {
    p_bag_id: input.bagId,
    p_creator_id: input.creatorId,
    p_bag_version_id: input.bagVersionId,
    p_chain: input.chain,
    p_factory_address: input.factoryAddress.toLowerCase(),
    p_contract_address: input.contractAddress.toLowerCase(),
    p_tx_hash: input.txHash.toLowerCase(),
    p_block_number: input.blockNumber,
    p_on_chain_bag_id: input.onChainBagId.toLowerCase(),
    p_on_chain_creator: input.onChainCreator.toLowerCase(),
  });
  if (error) throw new Error(error.message);

  const result = data as ConfirmRpcPayload;
  switch (result.outcome) {
    case 'CONFIRMED':
    case 'ALREADY_CONFIRMED':
      return {
        outcome: result.outcome,
        deployment: fromRow(result.deployment as BagDeploymentRow),
        bag: {
          status: result.bag?.status ?? 'ACTIVE',
          contractAddress: result.bag?.contract_address ?? null,
          registryId: result.bag?.registry_id ?? null,
        },
      };
    case 'CONFLICT':
      return { outcome: 'CONFLICT', deployment: fromRow(result.deployment as BagDeploymentRow) };
    case 'STALE_VERSION':
    case 'IDENTITY_TAKEN':
    case 'BAG_NOT_FOUND':
    case 'FORBIDDEN':
      return { outcome: result.outcome };
    default:
      throw new Error(`${fn}: unexpected confirm_bag_deployment outcome "${String(result.outcome)}".`);
  }
}

/**
 * The persisted on-chain Bag id for `(bagId, chain)`, or `null` if that Bag has no CONFIRMED, CREATOR-BOUND
 * deployment on `chain`. This is the ONLY place execution (the Bag Router path) should get an on-chain id from —
 * it returns exactly what the chain emitted at deploy time. A `null` means "not routable through the Bag Router",
 * never "derive one".
 *
 * DELIBERATELY excludes legacy rows: migration 0024 backfilled every pre-existing DEPLOYED row's `on_chain_bag_id`
 * with a legacy UUID-as-bytes32 value (`0x` || the Bag's own UUID, zero-padded) and left `on_chain_creator` NULL,
 * because the old backend-signed flow had no creator-bound on-chain identity at all. That legacy value was NEVER
 * verified against `BagFactory.bagOf()` / a real `BagCreated` event the way `lib/blockchain/evm/adapter.ts`'s
 * `verifyBagCreation()` verifies every id this function DOES return — `bagFactory.bagOf(legacyId)` resolves to
 * `address(0)` on the CURRENT (creator-bound) factory, so handing it to `BagExecutionRouter.execute()` would
 * always revert with `UnknownBag`. Requiring `on_chain_creator is not null` is exactly "was this id produced and
 * verified by the user-signed flow", so a legacy Bag simply falls back to the non-Bag-Router execution providers
 * (LI.FI) instead of being handed a plan the router can never accept.
 */
export async function getDeployedOnChainBagId(admin: SupabaseClient, bagId: string, chain: ChainId): Promise<Hex | null> {
  const { data, error } = await admin
    .from('bag_deployments')
    .select('on_chain_bag_id, on_chain_creator')
    .eq('bag_id', bagId)
    .eq('chain', chain)
    .eq('status', 'DEPLOYED')
    .maybeSingle<{ on_chain_bag_id: string | null; on_chain_creator: string | null }>();
  if (error) throw new Error(error.message);
  // `on_chain_creator` is null ONLY for legacy (pre-user-signed-flow) rows migration 0024 backfilled — see this
  // function's own doc above. Filtering in application code (rather than a `.not(...is...)` query builder clause)
  // keeps this readable across both the real Supabase client and the lightweight query shim the integration
  // tests use (pg-harness.ts's `ShimQuery`), and the extra round-trip cost of fetching one already-null-checked
  // column is negligible for a single-row, indexed lookup.
  if (!data || data.on_chain_creator === null) return null;
  return data.on_chain_bag_id as Hex | null;
}
