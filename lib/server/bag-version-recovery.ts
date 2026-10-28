import { SupabaseClient } from '@supabase/supabase-js';
import type { Hex } from 'viem';
import { BasketRecipe, BagVersionRecord } from '@/types/basket-protocol';
import { computeCompositionHash } from '@/lib/domain/basket-protocol/version';
import { computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { getDeployment } from '@/lib/server/bag-deployment-repo';
import { BagVersioningDeps, VersionSession, deriveVersionBody, sameBody, versionMetadataURI } from '@/lib/server/bag-versioning';
import { BagVersionAdapter, BagVersionPendingError, BagVersionVerificationError, createBagVersionAdapter } from '@/lib/blockchain/evm/version-adapter';

// -----------------------------------------------------------------------------
// Bringing the database back in line with versions the chain already recorded (migration 0059).
//
// The chain is the authority for WHICH composition a Bag is at; the server's pending proposals (stored at prepare,
// before any signature) are the only source of the full recipe. For each version the chain is ahead by:
//
//   1. locate the transaction by RPC: the Bag's CompositionUpdated log for exactly that version (indexed topic,
//      emitted once per version), or a transaction hash the creator supplies;
//   2. pick the pending proposal built on the previous version whose on-chain composition hash and metadata URI match
//      that log; check the stored recipe still hashes to those values and belongs to this Bag's deployment;
//   3. verify the transaction's receipt in full (verifyRecordVersion: success, confirmations, factory event, Bag event,
//      bag id, address, creator, version, hash, URI), with expectations from the proposal and the database only;
//   4. record it with record_onchain_bag_version: idempotent per transaction hash and compare-and-swap on the version,
//      so repeated or concurrent recoveries write one version row, and an older proposal can never land on top.
//
// Any read or check that fails stops the recovery with nothing written; it never guesses. A database failure in step
// 4 rolls back with the proposal still PENDING, so the next attempt retries the same thing.
//
// Not covered: a version recorded on chain with no proposal on the server (sent before 0059, or by calling the
// factory directly). That is reported as NO_PROPOSAL with the transaction found; the creator can still record it
// through confirm by resubmitting the exact composition with that transaction hash (its hash is checked on chain).
// -----------------------------------------------------------------------------

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** Versions recovered per request: a Bag is normally at most one ahead; more means a call loop the caller repeats. */
const MAX_STEPS = 5;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ProposalRow {
  id: string;
  bag_id: string;
  creator_id: string;
  wallet: string;
  chain: string;
  chain_id: number;
  factory_address: string;
  contract_address: string;
  on_chain_bag_id: string;
  expected_onchain_version: number;
  new_onchain_version: number;
  composition_hash: string;
  onchain_composition_hash: string;
  metadata_uri: string;
  recipe: BasketRecipe;
  reason: string;
  prepared_block: string | number;
  status: string;
  created_at: string;
}

export interface VersionSyncView {
  /** The version this database recorded for the deployed Bag (bag_deployments.on_chain_version). */
  recordedVersion: number;
  /** `Bag.version()` read from the chain now. */
  chainVersion: number;
  inSync: boolean;
  /** Pending proposals built on the recorded version (prepared, not yet recorded). */
  pendingProposals: number;
}

type Failure =
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'FORBIDDEN' }
  | { ok: false; error: 'NOT_DEPLOYED' }
  | { ok: false; error: 'CHAIN_UNAVAILABLE'; message: string }
  /** The chain is behind what this database recorded: never written over, reported for investigation. */
  | { ok: false; error: 'CHAIN_BEHIND'; recordedVersion: number; chainVersion: number }
  /** The supplied transaction is not mined (or not deep enough) yet. */
  | { ok: false; error: 'PENDING'; message: string }
  | { ok: false; error: 'VERIFICATION_FAILED'; message: string }
  /** The chain is ahead but its log for the next version could not be found in the searched range. */
  | { ok: false; error: 'NOT_FOUND_ON_CHAIN'; version: number }
  /** The chain recorded a version no server-side proposal describes: the recipe is unknown here, nothing is written. */
  | { ok: false; error: 'NO_PROPOSAL'; version: number; txHash: string | null; onChainCompositionHash: string | null }
  | { ok: false; error: 'STALE_VERSION' | 'DEPLOYMENT_MISMATCH' | 'TX_ALREADY_USED' | 'IMMUTABLE_BAG' | 'BAG_ARCHIVED' }
  /** The database write failed; the proposal is still pending and the next attempt retries it. */
  | { ok: false; error: 'CHAIN_ERROR'; message: string };

export type VersionStatusResult = ({ ok: true } & VersionSyncView) | Failure;
export type RecoverVersionsResult = ({ ok: true; recovered: BagVersionRecord[] } & VersionSyncView) | Failure;

interface Loaded {
  bagId: string;
  creatorId: string;
  chain: string;
  currentVersion: number;
  /** The current version's recipe: the only source of every non-asset field of a new version. */
  currentRecipe: BasketRecipe | null;
  deployment: { contractAddress: Hex; onChainBagId: Hex; factoryAddress: Hex; onChainCreator: Hex | null; recordedVersion: number; blockNumber: number | null };
  adapter: BagVersionAdapter;
}

async function load(admin: SupabaseClient, session: VersionSession, bagId: string, deps?: BagVersioningDeps): Promise<{ ok: true; ctx: Loaded } | Failure> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  // Only the creator may look at or act on their Bag's pending versions (the server holds no key; nothing is signed).
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };
  const d = await getDeployment(admin, bag.id, bag.chain);
  if (!d || d.status !== 'DEPLOYED' || !d.contractAddress || !d.onChainBagId || !d.factoryAddress) return { ok: false, error: 'NOT_DEPLOYED' };
  let adapter: BagVersionAdapter;
  try {
    adapter = (deps?.resolveAdapter ?? createBagVersionAdapter)(bag.chain);
  } catch (err) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }
  if (!adapter.factoryAddress || adapter.factoryAddress.toLowerCase() !== d.factoryAddress.toLowerCase()) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: `Configured factory ${adapter.factoryAddress} is not the Bag's factory ${d.factoryAddress}.` };
  }
  return {
    ok: true,
    ctx: {
      bagId: bag.id,
      creatorId: bag.creatorId,
      chain: bag.chain,
      currentVersion: bag.currentVersion,
      currentRecipe: (await getCurrentBagVersion(admin, bag.id))?.recipe ?? null,
      deployment: {
        contractAddress: d.contractAddress.toLowerCase() as Hex,
        onChainBagId: d.onChainBagId.toLowerCase() as Hex,
        factoryAddress: d.factoryAddress.toLowerCase() as Hex,
        onChainCreator: d.onChainCreator ? (d.onChainCreator.toLowerCase() as Hex) : null,
        recordedVersion: d.onChainVersion ?? 1,
        blockNumber: d.blockNumber,
      },
      adapter,
    },
  };
}

async function pendingProposals(admin: SupabaseClient, bagId: string, expectedVersion: number): Promise<ProposalRow[]> {
  const { data, error } = await admin
    .from('bag_version_proposals')
    .select()
    .eq('bag_id', bagId)
    .eq('status', 'PENDING')
    .eq('expected_onchain_version', expectedVersion);
  if (error) throw new Error(error.message);
  return (data ?? []) as ProposalRow[];
}

async function syncView(admin: SupabaseClient, ctx: Loaded): Promise<VersionSyncView | Failure> {
  let chainVersion: number;
  try {
    chainVersion = await ctx.adapter.readBagVersion(ctx.deployment.contractAddress);
  } catch (err) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }
  const recordedVersion = ctx.deployment.recordedVersion;
  const pending = await pendingProposals(admin, ctx.bagId, recordedVersion);
  return { recordedVersion, chainVersion, inSync: chainVersion === recordedVersion, pendingProposals: pending.length };
}

/** Where the database and the chain stand for this Bag. Read-only. */
export async function getBagVersionStatus(admin: SupabaseClient, session: VersionSession, bagId: string, deps?: BagVersioningDeps): Promise<VersionStatusResult> {
  const loaded = await load(admin, session, bagId, deps);
  if (!loaded.ok) return loaded;
  const view = await syncView(admin, loaded.ctx);
  return 'ok' in view ? view : { ok: true, ...view };
}

/**
 * The proposal's stored content still describes this Bag's deployment, still hashes to what it committed to, and its
 * body is exactly what the server derives from the current version for those assets (so nothing but the assets can
 * differ from the version it replaces, whatever was written to the row).
 */
function proposalIsSound(p: ProposalRow, ctx: Loaded): boolean {
  const assets = p.recipe?.assets;
  if (!Array.isArray(assets) || assets.length === 0 || !ctx.currentRecipe) return false;
  if (!sameBody(p.recipe, { ...deriveVersionBody(ctx.currentRecipe, assets), bagId: ctx.bagId })) return false;
  return (
    p.bag_id === ctx.bagId &&
    p.creator_id === ctx.creatorId &&
    p.chain === ctx.chain &&
    p.chain_id === ctx.adapter.chainId &&
    p.factory_address === ctx.deployment.factoryAddress &&
    p.contract_address === ctx.deployment.contractAddress &&
    p.on_chain_bag_id === ctx.deployment.onChainBagId &&
    (ctx.deployment.onChainCreator === null || p.wallet === ctx.deployment.onChainCreator) &&
    computeOnChainCompositionHash(assets).toLowerCase() === p.onchain_composition_hash &&
    computeCompositionHash(assets) === p.composition_hash &&
    // The URI commits to the next database version; it must still be the next one.
    p.metadata_uri === versionMetadataURI(ctx.bagId, ctx.currentVersion + 1)
  );
}

/**
 * Records, one by one, the versions the chain is ahead by, each only after its transaction is verified on chain.
 * `txHash`, when given, is tried for the first missing version (it is verified like any other, never trusted).
 */
export async function recoverBagVersions(
  admin: SupabaseClient,
  session: VersionSession,
  bagId: string,
  opts: { txHash?: string } = {},
  deps?: BagVersioningDeps
): Promise<RecoverVersionsResult> {
  if (opts.txHash !== undefined && !TX_HASH_RE.test(opts.txHash)) return { ok: false, error: 'VERIFICATION_FAILED', message: `"${opts.txHash}" is not a valid transaction hash.` };
  let suppliedTx = opts.txHash?.toLowerCase() as Hex | undefined;
  const recovered: BagVersionRecord[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const loaded = await load(admin, session, bagId, deps);
    if (!loaded.ok) return loaded;
    const { ctx } = loaded;
    const view = await syncView(admin, ctx);
    if ('ok' in view) return view;
    if (view.chainVersion < view.recordedVersion) return { ok: false, error: 'CHAIN_BEHIND', recordedVersion: view.recordedVersion, chainVersion: view.chainVersion };

    if (view.inSync) {
      // A supplied transaction that is not on chain yet is reported as pending, not as "nothing to do".
      if (suppliedTx && recovered.length === 0) {
        const pending = await pendingProposals(admin, ctx.bagId, view.recordedVersion);
        for (const p of pending) {
          try {
            await verifyAgainst(ctx, p, suppliedTx);
          } catch (err) {
            if (err instanceof BagVersionPendingError) return { ok: false, error: 'PENDING', message: err.message };
          }
        }
      }
      return { ok: true, recovered, ...view };
    }

    const target = view.recordedVersion + 1;
    const candidates = (await pendingProposals(admin, ctx.bagId, view.recordedVersion)).filter((p) => proposalIsSound(p, ctx));

    let chosen: ProposalRow | null = null;
    let txHash: Hex | null = null;
    let locatedHash: string | null = null;

    if (suppliedTx) {
      // Exactly one sound proposal must verify against the supplied transaction.
      const verified: ProposalRow[] = [];
      for (const p of candidates) {
        try {
          await verifyAgainst(ctx, p, suppliedTx);
          verified.push(p);
        } catch (err) {
          if (err instanceof BagVersionPendingError) return { ok: false, error: 'PENDING', message: err.message };
          if (!(err instanceof BagVersionVerificationError)) return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
        }
      }
      if (verified.length !== 1) {
        if (await alreadyRecorded(admin, ctx.bagId, suppliedTx)) {
          suppliedTx = undefined;
          continue;
        }
        if (candidates.length === 0) return { ok: false, error: 'NO_PROPOSAL', version: target, txHash: suppliedTx, onChainCompositionHash: null };
        return { ok: false, error: 'VERIFICATION_FAILED', message: `Transaction ${suppliedTx} does not record any pending proposal as version ${target} of this Bag.` };
      }
      chosen = verified[0];
      txHash = suppliedTx;
    } else {
      // Every pending proposal on version R was prepared while the chain was at R (prepare refuses OUT_OF_SYNC), so
      // the transaction that took the chain to R+1 was mined after the earliest prepared_block: search from there.
      const all = await pendingProposals(admin, ctx.bagId, view.recordedVersion);
      const fromBlock = all.length > 0 ? all.reduce((min, p) => (BigInt(p.prepared_block) < min ? BigInt(p.prepared_block) : min), BigInt(all[0].prepared_block)) : BigInt(ctx.deployment.blockNumber ?? 0);
      let located;
      try {
        located = await ctx.adapter.findVersionTransaction(ctx.deployment.contractAddress, target, fromBlock);
      } catch (err) {
        if (err instanceof BagVersionVerificationError) return { ok: false, error: 'VERIFICATION_FAILED', message: err.message };
        return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
      }
      if (!located) return all.length === 0 ? { ok: false, error: 'NO_PROPOSAL', version: target, txHash: null, onChainCompositionHash: null } : { ok: false, error: 'NOT_FOUND_ON_CHAIN', version: target };
      locatedHash = located.compositionHash.toLowerCase();
      const matching = candidates.filter((p) => p.onchain_composition_hash === locatedHash && p.metadata_uri === located.metadataURI);
      // Recorded meanwhile by a concurrent recovery or confirm: re-read and go on (never NO_PROPOSAL for that).
      if (matching.length !== 1 && (await alreadyRecorded(admin, ctx.bagId, located.txHash))) continue;
      if (matching.length !== 1) return { ok: false, error: 'NO_PROPOSAL', version: target, txHash: located.txHash.toLowerCase(), onChainCompositionHash: locatedHash };
      chosen = matching[0];
      txHash = located.txHash.toLowerCase() as Hex;
      try {
        await verifyAgainst(ctx, chosen, txHash);
      } catch (err) {
        if (err instanceof BagVersionPendingError) return { ok: false, error: 'PENDING', message: err.message };
        if (err instanceof BagVersionVerificationError) return { ok: false, error: 'VERIFICATION_FAILED', message: err.message };
        return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
      }
    }
    suppliedTx = undefined;

    const { data, error } = await admin.rpc('record_onchain_bag_version', {
      p_bag_id: ctx.bagId,
      p_creator_id: chosen.creator_id,
      p_factory_address: ctx.deployment.factoryAddress,
      p_contract_address: ctx.deployment.contractAddress,
      p_on_chain_bag_id: ctx.deployment.onChainBagId,
      p_expected_onchain_version: chosen.expected_onchain_version,
      p_new_onchain_version: chosen.new_onchain_version,
      p_composition_hash: chosen.composition_hash,
      p_onchain_composition_hash: chosen.onchain_composition_hash,
      p_metadata_uri: chosen.metadata_uri,
      p_recipe: { ...chosen.recipe, createdAt: chosen.created_at },
      p_tx_hash: txHash,
      p_reason: chosen.reason,
    });
    if (error) return { ok: false, error: 'CHAIN_ERROR', message: error.message };
    const r = data as { outcome: string; version?: Record<string, unknown> };
    if (r.outcome !== 'CONFIRMED' && r.outcome !== 'ALREADY_CONFIRMED') {
      const known = ['STALE_VERSION', 'DEPLOYMENT_MISMATCH', 'TX_ALREADY_USED', 'IMMUTABLE_BAG', 'BAG_ARCHIVED', 'FORBIDDEN', 'NOT_DEPLOYED', 'BAG_NOT_FOUND'];
      return { ok: false, error: (known.includes(r.outcome) ? r.outcome : 'CHAIN_ERROR') as 'STALE_VERSION' } as Failure;
    }
    if (r.version) recovered.push(versionFromJson(r.version));
  }

  // Still behind after MAX_STEPS: report where things stand; the caller asks again.
  const loaded = await load(admin, session, bagId, deps);
  if (!loaded.ok) return loaded;
  const view = await syncView(admin, loaded.ctx);
  return 'ok' in view ? view : { ok: true, recovered, ...view };
}

/** Whether this transaction is already recorded for this Bag (a concurrent recovery or confirm won the race). */
async function alreadyRecorded(admin: SupabaseClient, bagId: string, txHash: string): Promise<boolean> {
  const { data, error } = await admin.from('bag_versions').select('id').eq('bag_id', bagId).eq('onchain_tx_hash', txHash.toLowerCase()).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

function verifyAgainst(ctx: Loaded, p: ProposalRow, txHash: Hex) {
  return ctx.adapter.verifyRecordVersion({
    txHash,
    expectedCreator: (ctx.deployment.onChainCreator ?? p.wallet) as Hex,
    expectedOnChainBagId: ctx.deployment.onChainBagId,
    expectedBagAddress: ctx.deployment.contractAddress,
    expectedNewVersion: p.new_onchain_version,
    expectedCompositionHash: p.onchain_composition_hash as Hex,
    expectedMetadataURI: p.metadata_uri,
  });
}

function versionFromJson(r: Record<string, unknown>): BagVersionRecord {
  return {
    id: r.id as string,
    bagId: r.bag_id as string,
    version: r.version as number,
    compositionHash: r.composition_hash as string,
    recipe: r.recipe as BasketRecipe,
    createdBy: r.created_by as string,
    reason: r.reason as string,
    createdAt: r.created_at as string,
  };
}
