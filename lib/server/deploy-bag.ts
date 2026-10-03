import { SupabaseClient } from '@supabase/supabase-js';
import { ChainId } from '@/types/basket-protocol';
import {
  BagCreationPendingError,
  BagCreationVerificationError,
  BagDeploymentAdapter,
  PreparedBagCreationTx,
} from '@/lib/blockchain/adapter';
import { createBagDeploymentAdapter } from '@/lib/blockchain/evm/adapter';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { BagDeployment, BagFinalization, confirmUserSignedDeployment, getDeployment } from '@/lib/server/bag-deployment-repo';

// -----------------------------------------------------------------------------
// USER-SIGNED BAG DEPLOYMENT — the ONE production deployment path:
//
//   prepareBagDeployment()   POST /api/bags/[id]/deploy/prepare
//        ownership + session wallet + Bag-derived chain checked; returns
//        unsigned calldata. STATELESS: writes nothing, sends nothing, signs
//        nothing, holds no key. A rejected wallet prompt or a closed tab
//        leaves nothing to clean up (the Bag stays DRAFT, no row exists).
//   [the person's own wallet signs and broadcasts `createBag` in the browser]
//   confirmBagDeployment()   POST /api/bags/[id]/deploy/confirm
//        re-derives everything it expects from the DATABASE + SESSION,
//        independently verifies the transaction on-chain
//        (BagDeploymentAdapter.verifyBagCreation), then finalizes the
//        deployment row AND the Bag (ACTIVE) in ONE database transaction
//        (confirm_bag_deployment RPC, migration 0025).
//
// TRUST BOUNDARY. The client supplies exactly one thing: a `txHash`. Everything
// else — user, wallet, Bag ownership, chain, factory, offChainRef,
// compositionHash, on-chain id, block number, success — comes from the
// authenticated session, the current database state, or chain verification.
// There is NO client-supplied chain: it is `bag.chain`. There is NO mock
// fallback: an unconfigured/unsupported chain fails closed (`CHAIN_UNAVAILABLE`)
// in every environment. Ownership is re-checked here even though the routes
// call requireSession() first (never trust a caller's promise it already did).
// -----------------------------------------------------------------------------

/** What the API route hands in: BOTH fields come from the signed session cookie (lib/auth/session.ts), never from the request body. */
export interface DeploymentSession {
  userId: string;
  walletAddress: string;
}

/** Selects the chain adapter for a chain. Throws if the chain is unsupported/unconfigured. Injectable ONLY so tests can supply a fake chain; the default is the real read-only EVM adapter. */
export type ResolveBagDeploymentAdapter = (chain: ChainId) => BagDeploymentAdapter;
export interface DeployBagDeps {
  resolveAdapter?: ResolveBagDeploymentAdapter;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function adapterFor(deps: DeployBagDeps | undefined, chain: ChainId): BagDeploymentAdapter {
  return (deps?.resolveAdapter ?? createBagDeploymentAdapter)(chain);
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ------------------------------- prepare ------------------------------------

export type PrepareBagDeploymentResult =
  | {
      ok: true;
      transaction: PreparedBagCreationTx;
      /** The session wallet (lowercase) — the ONLY wallet whose transaction confirm will accept. The client must send from exactly this account. */
      wallet: `0x${string}`;
      chain: ChainId;
      factoryAddress: string;
      offChainRef: `0x${string}`;
      compositionHash: `0x${string}`;
    }
  | { ok: false; error: 'NO_WALLET_ON_SESSION' }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'FORBIDDEN' }
  | { ok: false; error: 'BAG_ARCHIVED' }
  | { ok: false; error: 'NO_VERSION' }
  | { ok: false; error: 'ALREADY_DEPLOYED'; deployment: BagDeployment }
  /** A Bag for (session wallet, this Bag) is already registered on-chain — a previous transaction succeeded but was never confirmed. Sending another would revert; confirm with the ORIGINAL transaction hash instead. */
  | { ok: false; error: 'ALREADY_CREATED_ON_CHAIN' }
  | { ok: false; error: 'CHAIN_UNAVAILABLE'; message: string };

/** Stateless (see module header): only READS the database and the chain; returns unsigned calldata for the person's own wallet. Safe to call repeatedly. */
export async function prepareBagDeployment(
  admin: SupabaseClient,
  session: DeploymentSession,
  bagId: string,
  deps?: DeployBagDeps
): Promise<PrepareBagDeploymentResult> {
  if (!ADDRESS_RE.test(session.walletAddress ?? '')) return { ok: false, error: 'NO_WALLET_ON_SESSION' };
  const wallet = session.walletAddress.toLowerCase() as `0x${string}`;

  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };
  if (bag.status === 'ARCHIVED') return { ok: false, error: 'BAG_ARCHIVED' };

  const chain = bag.chain; // server-derived — never a client value
  const version = await getCurrentBagVersion(admin, bag.id);
  if (!version) return { ok: false, error: 'NO_VERSION' };

  const existing = await getDeployment(admin, bag.id, chain);
  if (existing?.status === 'DEPLOYED') return { ok: false, error: 'ALREADY_DEPLOYED', deployment: existing };

  let adapter: BagDeploymentAdapter;
  try {
    adapter = adapterFor(deps, chain);
  } catch (err) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }

  const offChainRef = computeOnChainBagId(bag.id);
  const compositionHash = computeOnChainCompositionHash(version.recipe.assets);
  // Placeholder scheme pending a real metadata endpoint; resolvable later without touching the contract.
  const metadataURI = `bag:${bag.id}`;

  try {
    if (await adapter.hasBagOnChain(wallet, offChainRef)) return { ok: false, error: 'ALREADY_CREATED_ON_CHAIN' };
    const transaction = await adapter.prepareBagCreation({ offChainRef, compositionHash, metadataURI, isMutable: bag.mutability === 'MUTABLE' });
    return { ok: true, transaction, wallet, chain, factoryAddress: adapter.factoryAddress, offChainRef, compositionHash };
  } catch (err) {
    // Fail closed: if the chain can't be read we cannot promise the transaction is viable.
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }
}

// ------------------------------- confirm ------------------------------------

export type ConfirmBagDeploymentResult =
  | { ok: true; deployment: BagDeployment; bag: BagFinalization; alreadyConfirmed: boolean }
  | { ok: false; error: 'NO_WALLET_ON_SESSION' }
  | { ok: false; error: 'INVALID_TX_HASH' }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'FORBIDDEN' }
  | { ok: false; error: 'NO_VERSION' }
  | { ok: false; error: 'CHAIN_UNAVAILABLE'; message: string }
  /** Not verifiable YET (not propagated / not mined / below confirmation depth). Not a failure — retry the same request. */
  | { ok: false; error: 'PENDING'; message: string }
  /** The transaction is definitively not a valid deployment for this Bag + session wallet. */
  | { ok: false; error: 'VERIFICATION_FAILED'; message: string }
  /** The chain/RPC misbehaved while verifying (outage, malformed response). Nothing was written; retry later. */
  | { ok: false; error: 'CHAIN_ERROR'; message: string }
  /** A DIFFERENT deployment already exists for this Bag on this chain; it was not overwritten. */
  | { ok: false; error: 'CONFLICTING_DEPLOYMENT'; deployment: BagDeployment }
  /** The recipe changed after the verified transaction was prepared; the on-chain composition no longer matches. */
  | { ok: false; error: 'STALE_VERSION' }
  | { ok: false; error: 'IDENTITY_TAKEN' };

/**
 * Verifies `txHash` against the chain and only then finalizes. `session.walletAddress` MUST come from the signed
 * session cookie — the expected creator, checked against `tx.from`, `BagCreated.creator` and `Bag.creator()`.
 * Idempotent: re-confirming the same transaction returns success without writing (and without needing the RPC).
 */
export async function confirmBagDeployment(
  admin: SupabaseClient,
  session: DeploymentSession,
  bagId: string,
  txHash: string,
  deps?: DeployBagDeps
): Promise<ConfirmBagDeploymentResult> {
  if (!ADDRESS_RE.test(session.walletAddress ?? '')) return { ok: false, error: 'NO_WALLET_ON_SESSION' };
  if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) return { ok: false, error: 'INVALID_TX_HASH' };
  const canonicalTxHash = txHash.toLowerCase() as `0x${string}`;
  const wallet = session.walletAddress.toLowerCase() as `0x${string}`;

  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };

  const chain = bag.chain; // server-derived — never a client value

  // Idempotency / conflict fast-path, decided from OUR OWN record (the RPC re-decides it under lock for races).
  const existing = await getDeployment(admin, bag.id, chain);
  if (existing?.status === 'DEPLOYED') {
    if (existing.txHash === canonicalTxHash) {
      // `bag` was read BEFORE `existing`: a concurrent confirm can commit in between, leaving that snapshot
      // DRAFT while the deployment row is already DEPLOYED. The RPC writes both in ONE transaction, so a read
      // issued after observing the deployment sees its Bag update too — report that, never the stale snapshot.
      const current = (await getBagById(admin, bag.id)) ?? bag;
      return {
        ok: true,
        alreadyConfirmed: true,
        deployment: existing,
        bag: { status: current.status, contractAddress: current.contractAddress, registryId: current.registryId },
      };
    }
    return { ok: false, error: 'CONFLICTING_DEPLOYMENT', deployment: existing };
  }

  const version = await getCurrentBagVersion(admin, bag.id);
  if (!version) return { ok: false, error: 'NO_VERSION' };

  let adapter: BagDeploymentAdapter;
  try {
    adapter = adapterFor(deps, chain);
  } catch (err) {
    return { ok: false, error: 'CHAIN_UNAVAILABLE', message: errMessage(err) };
  }

  // Re-derived FRESH from the database, never taken from prepare or from the client — a recipe edited between
  // prepare and confirm is caught by the compositionHash check (and again atomically inside the RPC).
  const offChainRef = computeOnChainBagId(bag.id);
  const compositionHash = computeOnChainCompositionHash(version.recipe.assets);

  let verified;
  try {
    verified = await adapter.verifyBagCreation({
      txHash: canonicalTxHash,
      expectedFactoryAddress: adapter.factoryAddress,
      expectedOffChainRef: offChainRef,
      expectedCompositionHash: compositionHash,
      expectedCreator: wallet,
      expectedIsMutable: bag.mutability === 'MUTABLE',
    });
  } catch (err) {
    if (err instanceof BagCreationPendingError) return { ok: false, error: 'PENDING', message: err.message };
    if (err instanceof BagCreationVerificationError) return { ok: false, error: 'VERIFICATION_FAILED', message: err.message };
    return { ok: false, error: 'CHAIN_ERROR', message: errMessage(err) };
  }

  const result = await confirmUserSignedDeployment(admin, {
    bagId: bag.id,
    creatorId: session.userId,
    bagVersionId: version.id,
    chain,
    factoryAddress: adapter.factoryAddress,
    contractAddress: verified.contractAddress,
    txHash: verified.txHash,
    blockNumber: verified.blockNumber,
    onChainBagId: verified.onChainBagId,
    onChainCreator: verified.creatorAddress,
  });

  switch (result.outcome) {
    case 'CONFIRMED':
    case 'ALREADY_CONFIRMED':
      return { ok: true, deployment: result.deployment, bag: result.bag, alreadyConfirmed: result.outcome === 'ALREADY_CONFIRMED' };
    case 'CONFLICT':
      return { ok: false, error: 'CONFLICTING_DEPLOYMENT', deployment: result.deployment };
    case 'STALE_VERSION':
      return { ok: false, error: 'STALE_VERSION' };
    case 'IDENTITY_TAKEN':
      return { ok: false, error: 'IDENTITY_TAKEN' };
    case 'BAG_NOT_FOUND':
      return { ok: false, error: 'BAG_NOT_FOUND' };
    case 'FORBIDDEN':
      return { ok: false, error: 'FORBIDDEN' };
  }
}

// ------------------------------- read state ---------------------------------

export type GetBagDeploymentStateResult =
  | { ok: true; bagStatus: string; chain: ChainId; deployment: BagDeployment | null }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'FORBIDDEN' };

/** Owner-only read of the authoritative deployment state — what the UI polls/reads after confirm, or on page load after a refresh. */
export async function getBagDeploymentState(admin: SupabaseClient, session: DeploymentSession, bagId: string): Promise<GetBagDeploymentStateResult> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };
  return { ok: true, bagStatus: bag.status, chain: bag.chain, deployment: await getDeployment(admin, bag.id, bag.chain) };
}
