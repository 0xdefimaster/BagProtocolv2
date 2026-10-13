import { SupabaseClient } from '@supabase/supabase-js';
import { decodeEventLog, encodeFunctionData, type Hex, type PublicClient } from 'viem';
import { BagRecord } from '@/types/basket-protocol';
import { getBagById } from '@/lib/server/bag-repo';
import { buildBagJson, loadStrategyVersionRows } from '@/lib/server/strategy-api';
import { loadCompositions, loadRegistrations, type CompositionRow, type RegistrationRow } from '@/lib/server/strategy-registration-repo';

export type { CompositionRow, RegistrationRow };
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { registryStrategyId, STRATEGY_REGISTRY_WRITE_ABI } from '@/lib/domain/basket-protocol/strategy-registry';
import {
  compareComposition,
  computeOnchainCompositionHash,
  definitionToAllocations,
  STRATEGY_COMPOSITIONS_ABI,
  toContractAllocations,
  type OnchainAllocation,
} from '@/lib/domain/basket-protocol/strategy-compositions';
import type { BagDefinition } from '@/types/strategy';
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
//
// Composition (docs/STRATEGY_COMPOSITIONS_DESIGN.md): once every version is
// registered, the next step publishes the latest registered version's
// allocations to StrategyCompositions, from the same wallet, so the weights
// themselves are readable on-chain. Recorded only when the event's allocations
// equal that version's bag.json definition.
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
  compositionsAddress?: string | null;
  confirmations?: number;
  timeoutMs?: number;
}

/** The registry for a chain from STRATEGY_REGISTRY_ADDRESS_<CHAIN>; null when not configured (or a placeholder). */
export function registryAddressFor(chain: string): Hex | null {
  const v = process.env[`STRATEGY_REGISTRY_ADDRESS_${chain.toUpperCase()}`];
  return v && ADDRESS_RE.test(v) ? (v.toLowerCase() as Hex) : null;
}

/** StrategyCompositions for a chain from STRATEGY_COMPOSITIONS_ADDRESS_<CHAIN>; null when not configured. */
export function compositionsAddressFor(chain: string): Hex | null {
  const v = process.env[`STRATEGY_COMPOSITIONS_ADDRESS_${chain.toUpperCase()}`];
  return v && ADDRESS_RE.test(v) ? (v.toLowerCase() as Hex) : null;
}

interface Context {
  bag: BagRecord;
  wallet: Hex;
  registry: Hex;
  /** Null when StrategyCompositions is not configured for this chain: the composition step is skipped. */
  compositions: Hex | null;
  chainId: number;
  registryId: Hex;
  /** Stored versions, oldest first, with the definitionHash bag.json reports for each. */
  versions: { version: number; definitionHash: Hex; definition: BagDefinition }[];
  registrations: RegistrationRow[];
  compositionRows: CompositionRow[];
}

const allocationsOf = (definition: BagDefinition) => definitionToAllocations(definition, (c) => getEvmChainIdFor(c as BagChain));

async function loadContext(admin: SupabaseClient, session: RegistrationSession, bagId: string, deps?: RegistrationDeps): Promise<{ ok: true; ctx: Context } | RegistrationFailure> {
  if (!ADDRESS_RE.test(session.walletAddress ?? '')) return { ok: false, error: 'NO_WALLET_ON_SESSION' };
  const wallet = session.walletAddress.toLowerCase() as Hex;
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== session.userId) return { ok: false, error: 'FORBIDDEN' };
  const pick = (key: 'registryAddress' | 'compositionsAddress', fallback: (chain: string) => Hex | null): Hex | null => {
    if (deps && key in deps) {
      const v = deps[key];
      return v && ADDRESS_RE.test(v) ? (v.toLowerCase() as Hex) : null;
    }
    return fallback(bag.chain);
  };
  const registry = pick('registryAddress', registryAddressFor);
  const compositions = pick('compositionsAddress', compositionsAddressFor);
  const chainId = getEvmChainIdFor(bag.chain);
  if (!registry || chainId === null) return { ok: false, error: 'REGISTRY_NOT_CONFIGURED' };
  const rows = await loadStrategyVersionRows(admin, bag.id);
  const versions = rows
    .map((r) => {
      const json = buildBagJson(bag, r);
      return { version: r.version, definitionHash: json.definitionHash.toLowerCase() as Hex, definition: json.definition };
    })
    .sort((a, b) => a.version - b.version);
  const [registrations, compositionRows] = await Promise.all([loadRegistrations(admin, bag.id), compositions ? loadCompositions(admin, bag.id) : Promise.resolve([])]);
  return { ok: true, ctx: { bag, wallet, registry, compositions, chainId, registryId: registryStrategyId(wallet, bag.id), versions, registrations, compositionRows } };
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
  kind: 'REGISTER' | 'REGISTER_FORK' | 'PUBLISH_VERSIONS' | 'PUBLISH_COMPOSITION';
  registryStrategyId: Hex;
  /** The versions this transaction commits, with their hashes. */
  covers: { version: number; definitionHash: Hex }[];
  fork: { parentRegistryStrategyId: Hex; parentVersion: number } | null;
}

/**
 * The composition step, once every version is registered: the latest registered version's allocations, if
 * StrategyCompositions is configured, they are not recorded yet, and the definition can be expressed on-chain.
 */
function compositionStep(ctx: Context): PrepareRegistrationResult | null {
  if (!ctx.compositions || ctx.registrations.length === 0) return null;
  const latest = ctx.registrations.reduce((m, r) => (r.version > m.version ? r : m));
  if (ctx.compositionRows.some((r) => r.version === latest.version)) return null;
  const v = ctx.versions.find((x) => x.version === latest.version);
  if (!v || !same(v.definitionHash, latest.definition_hash)) return null;
  const converted = allocationsOf(v.definition);
  if (!converted.ok) return null;
  const id = latest.registry_strategy_id as Hex;
  return {
    ok: true,
    kind: 'PUBLISH_COMPOSITION',
    registryStrategyId: id,
    covers: [{ version: v.version, definitionHash: v.definitionHash }],
    fork: null,
    transaction: {
      to: ctx.compositions,
      chainId: ctx.chainId,
      data: encodeFunctionData({ abi: STRATEGY_COMPOSITIONS_ABI, functionName: 'publishComposition', args: [id, v.version, toContractAllocations(converted.allocations)] }),
    },
  };
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
        covers: [{ version: v1.version, definitionHash: v1.definitionHash }],
        fork: { parentRegistryStrategyId: parent.parentRegistryId, parentVersion: parent.parentVersion },
        transaction: tx(encodeFunctionData({ abi: STRATEGY_REGISTRY_WRITE_ABI, functionName: 'registerFork', args: [offChainRef, parent.parentRegistryId, parent.parentVersion, v1.definitionHash, ''] })),
      };
    }
    return {
      ok: true,
      kind: 'REGISTER',
      registryStrategyId: ctx.registryId,
      covers: [{ version: v1.version, definitionHash: v1.definitionHash }],
      fork: null,
      transaction: tx(encodeFunctionData({ abi: STRATEGY_REGISTRY_WRITE_ABI, functionName: 'registerStrategy', args: [offChainRef, v1.definitionHash, ''] })),
    };
  }

  const pending = ctx.versions.filter((v) => v.version > lastRegistered);
  if (pending.length === 0) return compositionStep(ctx) ?? { ok: false, error: 'NOTHING_TO_REGISTER' };
  // Contiguity: the registry only accepts lastRegistered + 1, + 2, … (stored versions have no gaps).
  const contiguous = pending.filter((v, i) => v.version === lastRegistered + 1 + i);
  return {
    ok: true,
    kind: 'PUBLISH_VERSIONS',
    registryStrategyId: ctx.registrations[0].registry_strategy_id as Hex,
    covers: contiguous.map(({ version, definitionHash }) => ({ version, definitionHash })),
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
  /** Set when the transaction published a composition. */
  compositions?: CompositionRow[];
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
    if (rows.length > 0) {
      if (rows.some((r) => r.bag_id !== bagId)) return { ok: false, error: 'TX_ALREADY_USED' };
      return { ok: true, alreadyRecorded: true, registrations: rows };
    }
    const comp = await admin.from('strategy_compositions').select('*').eq('tx_hash', hash);
    // A database without 0057 has no compositions recorded.
    if (comp.error) return comp.error.code === '42P01' || /strategy_compositions/.test(comp.error.message ?? '') ? null : { ok: false, error: 'CHAIN_ERROR', message: comp.error.message };
    const crows = (comp.data ?? []) as CompositionRow[];
    if (crows.length === 0) return null;
    if (crows.some((r) => r.bag_id !== bagId)) return { ok: false, error: 'TX_ALREADY_USED' };
    return { ok: true, alreadyRecorded: true, registrations: [], compositions: crows };
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
  const toCompositions = !!tx.to && !!ctx.compositions && same(tx.to, ctx.compositions);
  if (!tx.to || (!same(tx.to, ctx.registry) && !toCompositions)) return fail(`Transaction was sent to ${tx.to ?? '(contract creation)'}, not the StrategyRegistry ${ctx.registry}.`);
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
  if (toCompositions) return recordComposition(admin, ctx, hash, receipt, fail, recordedFor);

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

type ReceiptLike = { blockNumber: bigint; logs: { address: string; data: Hex; topics: readonly Hex[]; logIndex: number | null }[] };

/**
 * Verifies a StrategyCompositions.publishComposition receipt and records it: exactly one CompositionPublished from
 * the configured contract, for this Bag's registered id and a registered version, whose allocations and hash equal
 * that version's bag.json definition. Anything else records nothing.
 */
async function recordComposition(
  admin: SupabaseClient,
  ctx: Context,
  hash: Hex,
  receipt: ReceiptLike,
  fail: (message: string) => RegistrationFailure,
  recordedFor: () => Promise<ConfirmRegistrationResult | RegistrationFailure | null>
): Promise<ConfirmRegistrationResult | RegistrationFailure> {
  if (ctx.registrations.length === 0) return fail('This Bag is not registered yet: its versions are registered before their composition.');
  const events = receipt.logs
    .filter((l) => same(l.address, ctx.compositions!))
    .map((l) => {
      try {
        const ev = decodeEventLog({ abi: STRATEGY_COMPOSITIONS_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return ev.eventName === 'CompositionPublished' ? { log: l, args: ev.args as { strategyId: Hex; version: number; compositionHash: Hex; allocations: readonly { chainId: bigint; token: string; weightBps: number }[] } } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (events.length !== 1) return fail(`Expected one CompositionPublished event, found ${events.length}.`);
  const { log, args } = events[0];
  const registeredId = ctx.registrations[0].registry_strategy_id;
  if (!same(args.strategyId, registeredId)) return fail(`CompositionPublished is for ${args.strategyId}, not this Bag (${registeredId}).`);
  const version = Number(args.version);
  const reg = ctx.registrations.find((r) => r.version === version);
  if (!reg) return fail(`Version ${version} is not registered for this Bag.`);
  const v = ctx.versions.find((x) => x.version === version);
  if (!v || !same(v.definitionHash, reg.definition_hash)) return fail(`Version ${version} in BAG no longer matches its registration.`);
  const expected = allocationsOf(v.definition);
  if (!expected.ok) return fail(`Version ${version} cannot be expressed on-chain: ${expected.reason}.`);
  const cmp = compareComposition(expected.allocations, args.allocations);
  if (!cmp.matches) return fail(`On-chain allocations for version ${version} are not its bag.json definition (${cmp.detail}); not recorded.`);
  const expectedHash = computeOnchainCompositionHash(expected.allocations);
  if (!same(args.compositionHash, expectedHash)) return fail(`compositionHash ${args.compositionHash} is not ${expectedHash}.`);

  const row: CompositionRow = {
    bag_id: ctx.bag.id,
    version,
    chain: ctx.bag.chain,
    compositions_address: ctx.compositions!,
    registry_strategy_id: registeredId.toLowerCase(),
    composition_hash: expectedHash.toLowerCase(),
    allocations: expected.allocations.map((a: OnchainAllocation) => ({ chainId: a.chainId.toString(), token: a.token, weightBps: a.weightBps })),
    creator_wallet: ctx.wallet,
    tx_hash: hash,
    block_number: Number(receipt.blockNumber),
    log_index: Number(log.logIndex),
  };
  const { error } = await admin.from('strategy_compositions').insert([row]);
  if (error) {
    const raced = await recordedFor();
    if (raced) return raced;
    return { ok: false, error: 'CHAIN_ERROR', message: error.message };
  }
  return { ok: true, alreadyRecorded: false, registrations: [], compositions: [row] };
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
  versions: {
    version: number;
    definitionHash: string;
    registered: boolean;
    txHash: string | null;
    /** The version's allocations are on-chain in StrategyCompositions, as BAG verified them. */
    compositionPublished: boolean;
    compositionTxHash: string | null;
  }[];
  fork: { parentStrategyId: string; parentVersion: number | null } | null;
  /** StrategyCompositions for this chain, null when not configured. */
  compositionsAddress: Hex | null;
  /** The latest registered version's allocations can be published and are not yet: the creator has a step left. */
  compositionPending: boolean;
}

/** Public registration status of a Bag (what BAG verified), plus whether the viewer may register it. */
export async function getRegistrationStatus(admin: SupabaseClient, bagId: string, viewerUserId: string | null): Promise<RegistrationStatus | null> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return null;
  const registry = registryAddressFor(bag.chain);
  const compositionsAddress = compositionsAddressFor(bag.chain);
  const [rows, registrations, compositionRows] = await Promise.all([loadStrategyVersionRows(admin, bag.id), loadRegistrations(admin, bag.id), loadCompositions(admin, bag.id)]);
  const byVersion = new Map(registrations.map((r) => [r.version, r]));
  const compByVersion = new Map(compositionRows.map((r) => [r.version, r]));
  const latestReg = registrations.reduce<RegistrationRow | null>((m, r) => (!m || r.version > m.version ? r : m), null);
  const latestRow = latestReg ? rows.find((r) => r.version === latestReg.version) : undefined;
  const latestJson = latestRow ? buildBagJson(bag, latestRow) : null;
  const compositionPending =
    !!compositionsAddress &&
    !!latestReg &&
    !!latestJson &&
    same(latestJson.definitionHash, latestReg.definition_hash) &&
    !compByVersion.has(latestReg.version) &&
    allocationsOf(latestJson.definition).ok;
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
        const comp = registered ? compByVersion.get(r.version) : undefined;
        return { version: r.version, definitionHash, registered, txHash: registered ? reg!.tx_hash : null, compositionPublished: !!comp, compositionTxHash: comp?.tx_hash ?? null };
      })
      .sort((a, b) => a.version - b.version),
    fork: bag.parentBagId ? { parentStrategyId: bag.parentBagId, parentVersion: bag.parentBagVersion ?? null } : null,
    compositionsAddress,
    compositionPending,
  };
}
