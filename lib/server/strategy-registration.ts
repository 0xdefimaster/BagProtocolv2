import { SupabaseClient } from '@supabase/supabase-js';
import { decodeEventLog, encodeFunctionData, type Hex, type PublicClient } from 'viem';
import { BagRecord } from '@/types/basket-protocol';
import { getBagById } from '@/lib/server/bag-repo';
import { buildBagJson, loadStrategyVersionRows } from '@/lib/server/strategy-api';
import { loadRegistrations, type RegistrationRow } from '@/lib/server/strategy-registration-repo';

export type { RegistrationRow };
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { registryStrategyId, STRATEGY_REGISTRY_WRITE_ABI } from '@/lib/domain/basket-protocol/strategy-registry';
import { getEvmChainIdFor } from '@/lib/blockchain/evm/config';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { waitForConfirmedReceipt } from '@/lib/blockchain/evm/receipt-confirmation';
import { TX_HASH_RE } from '@/lib/server/intent-tx-claims';
import type { BagChain } from '@/lib/config/chains';

// -----------------------------------------------------------------------------
// StrategyRegistry app wiring (docs/STRATEGY_REGISTRY_DESIGN.md §8).
//
// USER-SIGNED, like deployment and versioning: the server builds the exact
// transaction for the creator's wallet to sign (prepare), then verifies the
// mined receipt and records what it shows (confirm). It never signs, never
// holds a key, and never records a commitment that differs from the stored
// version's bag.json definitionHash.
//
// Fork provenance: a fork is registered with registerFork, naming the exact
// parent version recorded when the fork was made (bags.parent_bag_version,
// 0052) and the parent's verified registration. A fork whose parent version
// is unknown, or whose parent version is not registered yet, cannot be
// registered — registering it as a non-fork would lose its provenance.
// -----------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO32 = `0x${'0'.repeat(64)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type RegistrationError =
  | 'NO_WALLET_ON_SESSION'
  | 'BAG_NOT_FOUND'
  | 'FORBIDDEN'
  | 'REGISTRY_NOT_CONFIGURED'
  | 'NOTHING_TO_REGISTER'
  | 'FORK_PARENT_VERSION_UNKNOWN'
  | 'PARENT_NOT_REGISTERED'
  | 'INVALID_TX_HASH'
  | 'TX_ALREADY_USED'
  | 'PENDING'
  | 'VERIFICATION_FAILED'
  | 'CHAIN_ERROR';

export type RegistrationFailure = { ok: false; error: RegistrationError; message?: string };

export interface RegistrationSession {
  userId: string;
  walletAddress: string;
}

export interface RegistrationDeps {
  client?: Pick<PublicClient, 'getTransaction' | 'getTransactionReceipt' | 'getBlockNumber'>;
  registryAddress?: string | null;
  confirmations?: number;
  timeoutMs?: number;
}

/** The registry for a chain from STRATEGY_REGISTRY_ADDRESS_<CHAIN>; null when not configured (or a placeholder). */
export function registryAddressFor(chain: string): Hex | null {
  const v = process.env[`STRATEGY_REGISTRY_ADDRESS_${chain.toUpperCase()}`];
  return v && ADDRESS_RE.test(v) ? (v.toLowerCase() as Hex) : null;
}

interface Context {
  bag: BagRecord;
  wallet: Hex;
  registry: Hex;
  chainId: number;
  registryId: Hex;
  /** Stored versions, oldest first, with the definitionHash bag.json reports for each. */
  versions: { version: number; definitionHash: Hex }[];
  registrations: RegistrationRow[];
}

async function loadContext(admin: SupabaseClient, session: RegistrationSession, bagId: string, deps?: RegistrationDeps): Promise<{ ok: true; ctx: Context } | RegistrationFailure> {
  if (!ADDRESS_RE.test(session.walletAddress ?? '')) return { ok: false, error: 'NO_WALLET_ON_SESSION' };
  const wallet = session.walletAddress.toLowerCase() as Hex;
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };
  const registry = deps && 'registryAddress' in deps ? (deps.registryAddress && ADDRESS_RE.test(deps.registryAddress) ? (deps.registryAddress.toLowerCase() as Hex) : null) : registryAddressFor(bag.chain);
  const chainId = getEvmChainIdFor(bag.chain);
  if (!registry || chainId === null) return { ok: false, error: 'REGISTRY_NOT_CONFIGURED' };
  const rows = await loadStrategyVersionRows(admin, bag.id);
  const versions = rows
    .map((r) => ({ version: r.version, definitionHash: buildBagJson(bag, r).definitionHash.toLowerCase() as Hex }))
    .sort((a, b) => a.version - b.version);
  return { ok: true, ctx: { bag, wallet, registry, chainId, registryId: registryStrategyId(wallet, bag.id), versions, registrations: await loadRegistrations(admin, bag.id) } };
}

/** The parent's verified registration of the exact version this fork was made from. */
async function forkParent(admin: SupabaseClient, bag: BagRecord): Promise<{ ok: true; parentRegistryId: Hex; parentVersion: number } | RegistrationFailure | null> {
  if (!bag.parentBagId) return null;
  if (!bag.parentBagVersion) {
    return { ok: false, error: 'FORK_PARENT_VERSION_UNKNOWN', message: 'This fork was created before BAG recorded which parent version it came from, so its provenance cannot be registered.' };
  }
  const parentRow = (await loadRegistrations(admin, bag.parentBagId)).find((r) => r.version === bag.parentBagVersion);
  if (!parentRow) {
    return { ok: false, error: 'PARENT_NOT_REGISTERED', message: `The parent strategy's version ${bag.parentBagVersion} is not registered yet; its creator registers it first.` };
  }
  return { ok: true, parentRegistryId: parentRow.registry_strategy_id as Hex, parentVersion: bag.parentBagVersion };
}

// ------------------------------- prepare ------------------------------------

export interface PrepareRegistrationResult {
  ok: true;
  /** What the creator's wallet signs; send exactly this. */
  transaction: { to: Hex; data: Hex; chainId: number };
  kind: 'REGISTER' | 'REGISTER_FORK' | 'PUBLISH_VERSIONS';
  registryStrategyId: Hex;
  /** The versions this transaction commits, with their hashes. */
  covers: { version: number; definitionHash: Hex }[];
  fork: { parentRegistryStrategyId: Hex; parentVersion: number } | null;
}

/**
 * The next transaction to sign: version 1 (register or registerFork) if nothing is registered, otherwise every
 * stored version after the last registered one (publishVersions). Call again after each confirm until
 * NOTHING_TO_REGISTER.
 */
export async function prepareStrategyRegistration(
  admin: SupabaseClient,
  session: RegistrationSession,
  bagId: string,
  deps?: RegistrationDeps
): Promise<PrepareRegistrationResult | RegistrationFailure> {
  const loaded = await loadContext(admin, session, bagId, deps);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (ctx.versions.length === 0) return { ok: false, error: 'NOTHING_TO_REGISTER' };
  const tx = (data: Hex) => ({ to: ctx.registry, data, chainId: ctx.chainId });

  const lastRegistered = ctx.registrations.reduce((m, r) => Math.max(m, r.version), 0);
  if (lastRegistered === 0) {
    const v1 = ctx.versions.find((v) => v.version === 1);
    if (!v1) return { ok: false, error: 'NOTHING_TO_REGISTER' };
    const offChainRef = computeOnChainBagId(ctx.bag.id);
    const parent = await forkParent(admin, ctx.bag);
    if (parent && !parent.ok) return parent;
    if (parent) {
      return {
        ok: true,
        kind: 'REGISTER_FORK',
        registryStrategyId: ctx.registryId,
        covers: [v1],
        fork: { parentRegistryStrategyId: parent.parentRegistryId, parentVersion: parent.parentVersion },
        transaction: tx(encodeFunctionData({ abi: STRATEGY_REGISTRY_WRITE_ABI, functionName: 'registerFork', args: [offChainRef, parent.parentRegistryId, parent.parentVersion, v1.definitionHash, ''] })),
      };
    }
    return {
      ok: true,
      kind: 'REGISTER',
      registryStrategyId: ctx.registryId,
      covers: [v1],
      fork: null,
      transaction: tx(encodeFunctionData({ abi: STRATEGY_REGISTRY_WRITE_ABI, functionName: 'registerStrategy', args: [offChainRef, v1.definitionHash, ''] })),
    };
  }

  const pending = ctx.versions.filter((v) => v.version > lastRegistered);
  if (pending.length === 0) return { ok: false, error: 'NOTHING_TO_REGISTER' };
  // Contiguity: the registry only accepts lastRegistered + 1, + 2, … (stored versions have no gaps).
  const contiguous = pending.filter((v, i) => v.version === lastRegistered + 1 + i);
  return {
    ok: true,
    kind: 'PUBLISH_VERSIONS',
    registryStrategyId: ctx.registrations[0].registry_strategy_id as Hex,
    covers: contiguous,
    fork: null,
    transaction: tx(
      encodeFunctionData({
        abi: STRATEGY_REGISTRY_WRITE_ABI,
        functionName: 'publishVersions',
        args: [ctx.registrations[0].registry_strategy_id as Hex, lastRegistered + 1, contiguous.map((v) => v.definitionHash)],
      })
    ),
  };
}

// ------------------------------- confirm ------------------------------------

export interface ConfirmRegistrationResult {
  ok: true;
  alreadyRecorded: boolean;
  registrations: RegistrationRow[];
}

/**
 * Verifies a creator-signed StrategyRegistry transaction and records what it shows. Every check must hold or
 * nothing is recorded: sent by the creator's wallet to the configured registry, succeeded, the strategy id is
 * the creator-bound id of THIS Bag, a fork names exactly its recorded parent registration and version, and every
 * published definitionHash equals the stored version's bag.json hash.
 */
export async function confirmStrategyRegistration(
  admin: SupabaseClient,
  session: RegistrationSession,
  bagId: string,
  txHash: string,
  deps?: RegistrationDeps
): Promise<ConfirmRegistrationResult | RegistrationFailure> {
  if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) return { ok: false, error: 'INVALID_TX_HASH' };
  const hash = txHash.toLowerCase() as Hex;

  const recordedFor = async (): Promise<ConfirmRegistrationResult | RegistrationFailure | null> => {
    const { data, error } = await admin.from('strategy_registrations').select('*').eq('tx_hash', hash);
    if (error) return { ok: false, error: 'CHAIN_ERROR', message: error.message };
    const rows = (data ?? []) as RegistrationRow[];
    if (rows.length === 0) return null;
    if (rows.some((r) => r.bag_id !== bagId)) return { ok: false, error: 'TX_ALREADY_USED' };
    return { ok: true, alreadyRecorded: true, registrations: rows };
  };
  const already = await recordedFor();
  if (already) return already;

  const loaded = await loadContext(admin, session, bagId, deps);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  const client = deps?.client ?? getChainPublicClient(ctx.bag.chain as BagChain);
  const fail = (message: string): RegistrationFailure => ({ ok: false, error: 'VERIFICATION_FAILED', message });

  let tx;
  try {
    tx = await client.getTransaction({ hash });
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
    if (name === 'TransactionNotFoundError') return { ok: false, error: 'PENDING', message: `No transaction found for ${hash} yet.` };
    return { ok: false, error: 'CHAIN_ERROR', message: err instanceof Error ? err.message : String(err) };
  }
  // `tx.to` may be a smart-account router (MetaMask's EIP-7702 account sends through its DelegationManager)
  // rather than the registry itself; what binds the registration is checked below from the receipt: events
  // emitted BY the configured registry, for this Bag's creator-bound strategy id, in the creator's own transaction.
  if (!tx.to) return fail(`Transaction is a contract creation, not a call that reaches the StrategyRegistry ${ctx.registry}.`);
  if (!same(tx.from, ctx.wallet)) return fail(`Transaction was sent from ${tx.from}, not the creator's wallet ${ctx.wallet}.`);

  let confirmation;
  try {
    confirmation = await waitForConfirmedReceipt(client, { hash, confirmations: deps?.confirmations ?? 1, timeoutMs: deps?.timeoutMs ?? 20_000 });
  } catch (err) {
    return { ok: false, error: 'CHAIN_ERROR', message: err instanceof Error ? err.message : String(err) };
  }
  if (confirmation.status !== 'CONFIRMED') return { ok: false, error: 'PENDING', message: `Transaction ${hash} is not confirmed yet.` };
  const { receipt } = confirmation;
  if (receipt.status !== 'success') return fail(`Transaction ${hash} reverted — nothing was registered.`);

  const events = receipt.logs
    .filter((l) => same(l.address, ctx.registry))
    .map((l) => {
      try {
        return { log: l, ev: decodeEventLog({ abi: STRATEGY_REGISTRY_WRITE_ABI, data: l.data, topics: l.topics }) };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const registered = events.filter((e) => e.ev.eventName === 'StrategyRegistered');
  const published = events.filter((e) => e.ev.eventName === 'VersionPublished');
  if (registered.length > 1) return fail('More than one StrategyRegistered event in one transaction.');
  if (published.length === 0) return fail('The transaction published no version.');

  let forkOf: { id: string; version: number } | null = null;
  if (registered.length === 1) {
    const a = registered[0].ev.args as { strategyId: Hex; creator: Hex; offChainRef: Hex; forkOfStrategyId: Hex; forkOfVersion: number };
    if (!same(a.strategyId, ctx.registryId)) return fail(`StrategyRegistered is for ${a.strategyId}, not this Bag's creator-bound id ${ctx.registryId}.`);
    if (!same(a.creator, ctx.wallet)) return fail(`StrategyRegistered.creator ${a.creator} is not the creator's wallet.`);
    if (!same(a.offChainRef, computeOnChainBagId(ctx.bag.id))) return fail('StrategyRegistered.offChainRef is not this Bag.');
    const parent = await forkParent(admin, ctx.bag);
    if (parent && !parent.ok) return parent;
    if (parent) {
      if (!same(a.forkOfStrategyId, parent.parentRegistryId) || Number(a.forkOfVersion) !== parent.parentVersion) {
        return fail(`Registered as a fork of ${a.forkOfStrategyId} v${a.forkOfVersion}, but this Bag was forked from ${parent.parentRegistryId} v${parent.parentVersion}.`);
      }
      forkOf = { id: parent.parentRegistryId.toLowerCase(), version: parent.parentVersion };
    } else if (!same(a.forkOfStrategyId, ZERO32)) {
      return fail('Registered as a fork, but this Bag is not a fork.');
    }
  } else if (ctx.registrations.length === 0) {
    return fail('This Bag is not registered yet: the first transaction must register it.');
  }

  const expectedId = (registered.length === 1 ? ctx.registryId : (ctx.registrations[0].registry_strategy_id as Hex)).toLowerCase();
  const byVersion = new Map(ctx.versions.map((v) => [v.version, v.definitionHash]));
  const rows: RegistrationRow[] = [];
  for (const { log, ev } of published) {
    const a = ev.args as { strategyId: Hex; version: number; definitionHash: Hex };
    if (!same(a.strategyId, expectedId)) return fail(`VersionPublished is for ${a.strategyId}, not this Bag (${expectedId}).`);
    const stored = byVersion.get(Number(a.version));
    if (!stored) return fail(`Version ${a.version} does not exist in BAG for this strategy.`);
    if (!same(stored, a.definitionHash)) {
      return fail(`On-chain commitment for version ${a.version} (${a.definitionHash}) is not the bag.json definitionHash ${stored}; not recorded.`);
    }
    rows.push({
      bag_id: ctx.bag.id,
      version: Number(a.version),
      chain: ctx.bag.chain,
      registry_address: ctx.registry,
      registry_strategy_id: expectedId,
      definition_hash: stored,
      creator_wallet: ctx.wallet,
      fork_of_registry_strategy_id: Number(a.version) === 1 && forkOf ? forkOf.id : null,
      fork_of_version: Number(a.version) === 1 && forkOf ? forkOf.version : null,
      tx_hash: hash,
      block_number: Number(receipt.blockNumber),
      log_index: Number(log.logIndex),
    });
  }

  const { error } = await admin.from('strategy_registrations').insert(rows);
  if (error) {
    const raced = await recordedFor();
    if (raced) return raced;
    return { ok: false, error: 'CHAIN_ERROR', message: error.message };
  }
  return { ok: true, alreadyRecorded: false, registrations: rows };
}

// ------------------------------- status -------------------------------------

export interface RegistrationStatus {
  configured: boolean;
  viewerIsCreator: boolean;
  registryAddress: Hex | null;
  chainId: number | null;
  /** The Bag's chain slug, so a client can look the registry up in the SDK rather than trust `registryAddress`. */
  chain: string;
  registryStrategyId: string | null;
  /** The wallet that signed the registration (the strategy's creator on-chain); null until something is registered. */
  creatorWallet: string | null;
  versions: { version: number; definitionHash: string; registered: boolean; txHash: string | null }[];
  fork: { parentStrategyId: string; parentVersion: number | null } | null;
}

/** Public registration status of a Bag (what BAG verified), plus whether the viewer may register it. */
export async function getRegistrationStatus(admin: SupabaseClient, bagId: string, viewerUserId: string | null): Promise<RegistrationStatus | null> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return null;
  const registry = registryAddressFor(bag.chain);
  const [rows, registrations] = await Promise.all([loadStrategyVersionRows(admin, bag.id), loadRegistrations(admin, bag.id)]);
  const byVersion = new Map(registrations.map((r) => [r.version, r]));
  return {
    configured: registry !== null,
    viewerIsCreator: viewerUserId !== null && viewerUserId === bag.creatorId,
    registryAddress: registry,
    chainId: getEvmChainIdFor(bag.chain),
    chain: bag.chain,
    registryStrategyId: registrations[0]?.registry_strategy_id ?? null,
    creatorWallet: registrations[0]?.creator_wallet ?? null,
    versions: rows
      .map((r) => {
        const definitionHash = buildBagJson(bag, r).definitionHash;
        const reg = byVersion.get(r.version);
        const registered = !!reg && same(reg.definition_hash, definitionHash);
        return { version: r.version, definitionHash, registered, txHash: registered ? reg!.tx_hash : null };
      })
      .sort((a, b) => a.version - b.version),
    fork: bag.parentBagId ? { parentStrategyId: bag.parentBagId, parentVersion: bag.parentBagVersion ?? null } : null,
  };
}
