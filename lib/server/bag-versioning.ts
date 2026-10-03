import { SupabaseClient } from '@supabase/supabase-js';
import type { Hex } from 'viem';
import { BagRecord, BagVersionRecord, BasketRecipe, ChainId, ValidationIssue } from '@/types/basket-protocol';
import { validateBasketRecipe } from '@/lib/domain/basket-protocol/validation';
import { computeCompositionHash, compositionsAreEqual } from '@/lib/domain/basket-protocol/version';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { getDeployment, BagDeployment } from '@/lib/server/bag-deployment-repo';
import {
  BagVersionAdapter,
  BagVersionPendingError,
  BagVersionVerificationError,
  createBagVersionAdapter,
} from '@/lib/blockchain/evm/version-adapter';

// -----------------------------------------------------------------------------
// USER-SIGNED VERSION UPDATE for a DEPLOYED, MUTABLE Bag:
//
//   prepareBagVersionUpdate()   POST /api/bags/[id]/versions/prepare
//        owner + session wallet (= the Bag's on-chain creator) + MUTABLE +
//        DEPLOYED + recipe validation + fee lock + chain version in sync;
//        returns unsigned `BagFactory.recordBagVersion` calldata. STATELESS.
//   [the creator's wallet signs and sends it]
//   confirmBagVersionUpdate()   POST /api/bags/[id]/versions/confirm
//        re-derives every expectation from the DATABASE + SESSION + the
//        re-submitted recipe (re-validated, re-hashed), verifies the receipt
//        and both events on-chain, and only then records the version in ONE
//        database transaction (record_onchain_bag_version, migration 0035).
//
// TRUST BOUNDARY — the client supplies the new recipe and a txHash. The recipe
// is re-validated and its composition re-hashed server-side; the version is
// accepted only if the chain recorded EXACTLY that hash for THIS Bag's
// on-chain id and address, from THIS creator's wallet. Nothing is written
// before a successful, verified receipt. The server holds no key.
// -----------------------------------------------------------------------------

export interface VersionSession {
  userId: string;
  walletAddress: string;
}
export type ResolveBagVersionAdapter = (chain: ChainId) => BagVersionAdapter;
export interface BagVersioningDeps {
  resolveAdapter?: ResolveBagVersionAdapter;
}

export type NewVersionRecipe = Omit<BasketRecipe, 'id' | 'bagId' | 'version' | 'createdAt'>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Display pointer committed on-chain with the version. Deterministic from (Bag, next DB version) so confirm can re-derive it. */
export function versionMetadataURI(bagId: string, dbVersion: number): string {
  return `bag:${bagId}:v${dbVersion}`;
}

type CommonFailure =
  | { ok: false; error: 'NO_WALLET_ON_SESSION' }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'FORBIDDEN' }
  | { ok: false; error: 'BAG_ARCHIVED' }
  | { ok: false; error: 'IMMUTABLE_BAG' }
  /** Not deployed on-chain: an undeployed DRAFT is versioned off-chain (createBagVersion), not here. */
  | { ok: false; error: 'NOT_DEPLOYED' }
  /** The session wallet is not the wallet that created the Bag on-chain — only that wallet can address it through the factory. */
  | { ok: false; error: 'WRONG_WALLET'; expected: string }
  | { ok: false; error: 'VALIDATION_FAILED'; issues: ValidationIssue[] }
  | { ok: false; error: 'NO_CHANGE' }
  | { ok: false; error: 'PERFORMANCE_FEE_LOCKED'; lockedBps: number }
  | { ok: false; error: 'CHAIN_UNAVAILABLE'; message: string };

interface Context {
  bag: BagRecord;
  deployment: BagDeployment & { contractAddress: string; onChainBagId: Hex; factoryAddress: string };
  wallet: Hex;
  recipe: BasketRecipe;
  nextDbVersion: number;
  compositionHash: string;
  onChainCompositionHash: Hex;
  metadataURI: string;
  expectedCurrentOnChainVersion: number;
  adapter: BagVersionAdapter;
}

async function buildContext(
  admin: SupabaseClient,
  session: VersionSession,
  bagId: string,
  input: NewVersionRecipe,
  deps: BagVersioningDeps | undefined,
  opts: { checkNoChange: boolean }
): Promise<{ ok: true; ctx: Context } | CommonFailure> {
  if (!ADDRESS_RE.test(session.walletAddress ?? '')) return { ok: false, error: 'NO_WALLET_ON_SESSION' };
  const wallet = session.walletAddress.toLowerCase() as Hex;

  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };
  if (bag.status === 'ARCHIVED') return { ok: false, error: 'BAG_ARCHIVED' };
  if (bag.mutability === 'IMMUTABLE') return { ok: false, error: 'IMMUTABLE_BAG' };

  const deployment = await getDeployment(admin, bag.id, bag.chain);
  if (!deployment || deployment.status !== 'DEPLOYED' || !deployment.contractAddress || !deployment.onChainBagId || !deployment.factoryAddress) {
    return { ok: false, error: 'NOT_DEPLOYED' };
  }
  // Legacy deployments (no recorded on-chain creator) cannot be addressed by recordBagVersion's creator-bound lookup.
  if (!deployment.onChainCreator || deployment.onChainCreator.toLowerCase() !== wallet) {
    return { ok: false, error: 'WRONG_WALLET', expected: deployment.onChainCreator ?? '(legacy deployment — no creator-bound on-chain id)' };
  }

  const nextDbVersion = bag.currentVersion + 1;
  const recipe: BasketRecipe = { ...input, id: `recipe_${bag.id}_v${nextDbVersion}`, bagId: bag.id, version: nextDbVersion, createdAt: new Date().toISOString() };
  const validation = validateBasketRecipe(recipe);
  if (validation.issues.some((i) => i.severity === 'ERROR')) return { ok: false, error: 'VALIDATION_FAILED', issues: validation.issues };
  if (recipe.chain !== bag.chain) {
    return { ok: false, error: 'VALIDATION_FAILED', issues: [{ severity: 'ERROR', code: 'CHAIN_MISMATCH', message: `A new version must stay on ${bag.chain}.`, field: 'chain' } as ValidationIssue] };
  }

  if (opts.checkNoChange) {
    const current = await getCurrentBagVersion(admin, bag.id);
    if (current && compositionsAreEqual(current.recipe.assets, recipe.assets) && (current.recipe.performanceFeeBps ?? 0) === (recipe.performanceFeeBps ?? 0)) {
      return { ok: false, error: 'NO_CHANGE' };
    }
    const lockedBps = bag.performanceFeeBpsLocked ?? null;
    if (lockedBps !== null && (recipe.performanceFeeBps ?? 0) !== lockedBps) return { ok: false, error: 'PERFORMANCE_FEE_LOCKED', lockedBps };
  }

  let adapter: BagVersionAdapter;
  try {
    adapter = (deps?.resolveAdapter ?? createBagVersionAdapter)(bag.chain);
  } catch (err) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }
  if (!adapter.factoryAddress || adapter.factoryAddress.toLowerCase() !== deployment.factoryAddress.toLowerCase()) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: `Configured factory ${adapter.factoryAddress} is not the Bag's factory ${deployment.factoryAddress}.` };
  }

  return {
    ok: true,
    ctx: {
      bag,
      deployment: deployment as Context['deployment'],
      wallet,
      recipe,
      nextDbVersion,
      compositionHash: computeCompositionHash(recipe.assets),
      onChainCompositionHash: computeOnChainCompositionHash(recipe.assets),
      metadataURI: versionMetadataURI(bag.id, nextDbVersion),
      expectedCurrentOnChainVersion: deployment.onChainVersion ?? 1,
      adapter,
    },
  };
}

// ------------------------------- prepare ------------------------------------

export type PrepareBagVersionResult =
  | {
      ok: true;
      transaction: { to: Hex; data: Hex; chainId: number };
      wallet: Hex;
      expectedCurrentOnChainVersion: number;
      newOnChainVersion: number;
      newDbVersion: number;
      onChainCompositionHash: Hex;
      metadataURI: string;
    }
  | CommonFailure
  /** The chain's `Bag.version()` differs from what this database recorded — a version was recorded on-chain but never confirmed here. */
  | { ok: false; error: 'OUT_OF_SYNC'; onChainVersion: number; recordedVersion: number };

export async function prepareBagVersionUpdate(
  admin: SupabaseClient,
  session: VersionSession,
  bagId: string,
  input: NewVersionRecipe,
  deps?: BagVersioningDeps
): Promise<PrepareBagVersionResult> {
  const built = await buildContext(admin, session, bagId, input, deps, { checkNoChange: true });
  if (!built.ok) return built;
  const { ctx } = built;
  let onChainVersion: number;
  try {
    onChainVersion = await ctx.adapter.readBagVersion(ctx.deployment.contractAddress as Hex);
  } catch (err) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }
  if (onChainVersion !== ctx.expectedCurrentOnChainVersion) {
    return { ok: false, error: 'OUT_OF_SYNC', onChainVersion, recordedVersion: ctx.expectedCurrentOnChainVersion };
  }
  return {
    ok: true,
    transaction: ctx.adapter.prepareRecordVersion({
      offChainRef: computeOnChainBagId(ctx.bag.id),
      expectedCurrentVersion: ctx.expectedCurrentOnChainVersion,
      compositionHash: ctx.onChainCompositionHash,
      metadataURI: ctx.metadataURI,
    }),
    wallet: ctx.wallet,
    expectedCurrentOnChainVersion: ctx.expectedCurrentOnChainVersion,
    newOnChainVersion: ctx.expectedCurrentOnChainVersion + 1,
    newDbVersion: ctx.nextDbVersion,
    onChainCompositionHash: ctx.onChainCompositionHash,
    metadataURI: ctx.metadataURI,
  };
}

// ------------------------------- confirm ------------------------------------

export type ConfirmBagVersionResult =
  | { ok: true; bag: BagRecord | null; version: BagVersionRecord | null; alreadyConfirmed: boolean; feeLockedOverride: boolean }
  | CommonFailure
  | { ok: false; error: 'INVALID_TX_HASH' }
  | { ok: false; error: 'PENDING'; message: string }
  | { ok: false; error: 'VERIFICATION_FAILED'; message: string }
  | { ok: false; error: 'CHAIN_ERROR'; message: string }
  /** Another version was confirmed first (the database compare-and-swap lost). */
  | { ok: false; error: 'STALE_VERSION' }
  | { ok: false; error: 'DEPLOYMENT_MISMATCH' }
  | { ok: false; error: 'TX_ALREADY_USED' };

interface VersionRow {
  id: string;
  bag_id: string;
  version: number;
  composition_hash: string;
  recipe: BasketRecipe;
  created_by: string;
  reason: string;
  created_at: string;
}
const versionFromRow = (r: VersionRow): BagVersionRecord => ({
  id: r.id,
  bagId: r.bag_id,
  version: r.version,
  compositionHash: r.composition_hash,
  recipe: r.recipe,
  createdBy: r.created_by,
  reason: r.reason,
  createdAt: r.created_at,
});

export async function confirmBagVersionUpdate(
  admin: SupabaseClient,
  session: VersionSession,
  bagId: string,
  input: NewVersionRecipe,
  txHash: string,
  reason: string,
  deps?: BagVersioningDeps
): Promise<ConfirmBagVersionResult> {
  if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) return { ok: false, error: 'INVALID_TX_HASH' };
  const canonicalTx = txHash.toLowerCase() as Hex;

  // Idempotency fast path from OUR record (the RPC re-decides it under lock).
  const alreadyRecorded = async (): Promise<ConfirmBagVersionResult | null> => {
    const { data: existing, error: existingErr } = await admin.from('bag_versions').select().eq('onchain_tx_hash', canonicalTx).maybeSingle<VersionRow>();
    if (existingErr) return { ok: false, error: 'CHAIN_ERROR', message: existingErr.message };
    if (!existing) return null;
    const bag = await getBagById(admin, existing.bag_id);
    if (existing.bag_id !== bagId || bag?.creatorId !== session.userId) return { ok: false, error: 'TX_ALREADY_USED' };
    return { ok: true, bag, version: versionFromRow(existing), alreadyConfirmed: true, feeLockedOverride: false };
  };
  const recorded = await alreadyRecorded();
  if (recorded) return recorded;

  // No NO_CHANGE / fee-lock rejection here: the version may already be on-chain; the RPC reconciles the fee.
  const built = await buildContext(admin, session, bagId, input, deps, { checkNoChange: false });
  if (!built.ok) return built;
  const { ctx } = built;

  try {
    await ctx.adapter.verifyRecordVersion({
      txHash: canonicalTx,
      expectedCreator: ctx.wallet,
      expectedOnChainBagId: ctx.deployment.onChainBagId,
      expectedBagAddress: ctx.deployment.contractAddress as Hex,
      expectedNewVersion: ctx.expectedCurrentOnChainVersion + 1,
      expectedCompositionHash: ctx.onChainCompositionHash,
      expectedMetadataURI: ctx.metadataURI,
    });
  } catch (err) {
    if (err instanceof BagVersionPendingError) return { ok: false, error: 'PENDING', message: err.message };
    if (err instanceof BagVersionVerificationError) {
      // A concurrent confirm of this same transaction may have recorded it
      // between our first check and reading the (now advanced) version —
      // that is an idempotent success, not a verification failure.
      const recordedMeanwhile = await alreadyRecorded();
      if (recordedMeanwhile) return recordedMeanwhile;
      return { ok: false, error: 'VERIFICATION_FAILED', message: err.message };
    }
    return { ok: false, error: 'CHAIN_ERROR', message: errMessage(err) };
  }

  const { data, error } = await admin.rpc('record_onchain_bag_version', {
    p_bag_id: ctx.bag.id,
    p_creator_id: session.userId,
    p_factory_address: ctx.deployment.factoryAddress,
    p_contract_address: ctx.deployment.contractAddress,
    p_on_chain_bag_id: ctx.deployment.onChainBagId,
    p_expected_onchain_version: ctx.expectedCurrentOnChainVersion,
    p_new_onchain_version: ctx.expectedCurrentOnChainVersion + 1,
    p_composition_hash: ctx.compositionHash,
    p_onchain_composition_hash: ctx.onChainCompositionHash,
    p_metadata_uri: ctx.metadataURI,
    p_recipe: ctx.recipe,
    p_tx_hash: canonicalTx,
    p_reason: reason,
  });
  if (error) return { ok: false, error: 'CHAIN_ERROR', message: error.message };

  const r = data as { outcome: string; version?: VersionRow; feeLockedOverride?: boolean };
  switch (r.outcome) {
    case 'CONFIRMED':
    case 'ALREADY_CONFIRMED':
      return {
        ok: true,
        bag: await getBagById(admin, ctx.bag.id),
        version: r.version ? versionFromRow(r.version) : null,
        alreadyConfirmed: r.outcome === 'ALREADY_CONFIRMED',
        feeLockedOverride: r.feeLockedOverride === true,
      };
    case 'STALE_VERSION':
      return { ok: false, error: 'STALE_VERSION' };
    case 'DEPLOYMENT_MISMATCH':
      return { ok: false, error: 'DEPLOYMENT_MISMATCH' };
    case 'TX_ALREADY_USED':
      return { ok: false, error: 'TX_ALREADY_USED' };
    case 'IMMUTABLE_BAG':
      return { ok: false, error: 'IMMUTABLE_BAG' };
    case 'BAG_ARCHIVED':
      return { ok: false, error: 'BAG_ARCHIVED' };
    case 'NOT_DEPLOYED':
      return { ok: false, error: 'NOT_DEPLOYED' };
    case 'FORBIDDEN':
      return { ok: false, error: 'FORBIDDEN' };
    default:
      return { ok: false, error: 'BAG_NOT_FOUND' };
  }
}
