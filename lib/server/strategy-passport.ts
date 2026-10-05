import type { SupabaseClient } from '@supabase/supabase-js';
import { BagRecord, BagVersionRecord, CanonicalAsset } from '@/types/basket-protocol';
import type { BagPerformance, CreatorProfile } from '@/types';
import { PassportForkNode, PassportPerson, PassportVersionNode, STRATEGY_PASSPORT_SCHEMA_VERSION, SourceInfo, StrategyPassport } from '@/types/strategy-passport';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { FORK_ROYALTY_BPS } from '@/lib/config/rewards';
import { BAG_CHAINS, BagChain } from '@/lib/config/chains';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { BagDeployment, getDeployment } from '@/lib/server/bag-deployment-repo';
import { loadRecipeAssets } from '@/lib/server/bag-asset-context';
import { loadCreatorProfiles } from '@/lib/server/user-profile-repo';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { computeBagPerformance, getNavSnapshots } from '@/lib/server/bag-nav-snapshots';
import { getBagSocialCounts } from '@/lib/server/bag-social-counts';
import { deriveStrategyPolicy } from '@/lib/server/strategy-policy';
import { deployedCompositionHash, resolveDeployedVersionId } from '@/lib/server/deployed-version';

// -----------------------------------------------------------------------------
// Builds the Strategy Passport (types/strategy-passport.ts) from data BAG
// already stores — no new tables. `buildStrategyPassport` is pure (tested on
// its own); `loadStrategyPassport` gathers the inputs with the existing repos.
// The policy section is `deriveStrategyPolicy()`, the same object validate_bag
// returns.
// -----------------------------------------------------------------------------

/** How far up the fork chain the passport walks (guards against a corrupted parent cycle). */
const MAX_FORK_DEPTH = 16;

export interface VersionOnchainRow {
  id: string;
  version: number;
  created_at: string;
  reason: string;
  composition_hash: string;
  onchain_tx_hash: string | null;
  onchain_version: number | null;
  onchain_composition_hash: string | null;
  metadata_uri: string | null;
}

export interface StrategyPassportInput {
  bag: BagRecord;
  currentVersion: BagVersionRecord | null;
  versions: VersionOnchainRow[];
  deployment: BagDeployment | null;
  creators: Map<string, CreatorProfile>;
  assetsByKey: Map<string, CanonicalAsset>;
  nav: { tvlUsd: string | null; navPerShare: string | null; asOf: string | null };
  returns: BagPerformance | null;
  holders: number | null;
  /** Nearest first. */
  ancestors: BagRecord[];
  /** Bag ids in the parent chain that could not be loaded (deleted). */
  missingAncestorIds: string[];
  children: BagRecord[];
  childCount: number;
  viewerUserId: string | null;
  now: Date;
}

const db = (asOf: string | null): SourceInfo => ({ source: 'DATABASE', asOf, verifiableBy: 'NONE', readFromChainThisRequest: false });
const onchainRecord = (asOf: string | null): SourceInfo => ({ source: 'ONCHAIN', asOf, verifiableBy: 'TX_HASH', readFromChainThisRequest: false });
const derived = (asOf: string | null): SourceInfo => ({ source: 'BAG_DERIVED', asOf, verifiableBy: 'NONE', readFromChainThisRequest: false });

function personOf(userId: string, creators: Map<string, CreatorProfile>): PassportPerson {
  const p = creators.get(userId);
  return { name: p?.name ?? null, walletAddress: p?.address ?? null, avatarUrl: p?.avatarUrl ?? null };
}

function hiddenNode(bagId: string): PassportForkNode {
  return { bagId, visible: false, name: null, symbol: null, status: null, creator: null, createdAt: null };
}

function forkNode(bag: BagRecord, viewerUserId: string | null, creators: Map<string, CreatorProfile>): PassportForkNode {
  const visible = bag.status === 'ACTIVE' || (viewerUserId !== null && bag.creatorId === viewerUserId);
  if (!visible) return hiddenNode(bag.id);
  return { bagId: bag.id, visible: true, name: bag.name, symbol: bag.symbol, status: bag.status, creator: personOf(bag.creatorId, creators), createdAt: bag.createdAt };
}

function onchainSection(bag: BagRecord, deployment: BagDeployment | null): StrategyPassport['onchain'] {
  if (!deployment || deployment.status !== 'DEPLOYED') return null;
  const cfg = (BAG_CHAINS as Partial<Record<string, (typeof BAG_CHAINS)[BagChain]>>)[deployment.chain];
  return {
    sourceInfo: onchainRecord(deployment.updatedAt || null),
    chain: deployment.chain,
    chainId: cfg?.chainId ?? null,
    onChainBagId: deployment.onChainBagId,
    onChainCreator: deployment.onChainCreator,
    contractAddress: deployment.contractAddress ?? bag.contractAddress,
    factoryAddress: deployment.factoryAddress,
    deploymentTxHash: deployment.txHash,
    deploymentBlock: deployment.blockNumber,
    onChainVersion: deployment.onChainVersion ?? 1,
    explorerUrl: cfg && deployment.txHash ? `${cfg.explorerUrl.replace(/\/$/, '')}/tx/${deployment.txHash}` : null,
  };
}

export function buildStrategyPassport(input: StrategyPassportInput): StrategyPassport {
  const { bag, currentVersion, creators } = input;
  const ascending = [...input.versions].sort((a, b) => a.version - b.version);
  const currentRow = currentVersion ? ascending.find((v) => v.id === currentVersion.id) : undefined;
  const latestVersionAt = ascending.length ? ascending[ascending.length - 1].created_at : null;

  const versionNodes: PassportVersionNode[] = ascending.map((v) => ({
    version: v.version,
    parentVersion: v.version > 1 ? v.version - 1 : null,
    createdAt: v.created_at,
    reason: v.reason,
    isCurrent: currentVersion ? v.id === currentVersion.id : false,
    onchain:
      v.onchain_tx_hash && v.onchain_version !== null && v.onchain_composition_hash
        ? { txHash: v.onchain_tx_hash, onchainVersion: v.onchain_version, compositionHash: v.onchain_composition_hash, metadataUri: v.metadata_uri, sourceInfo: onchainRecord(v.created_at) }
        : null,
  }));

  const assets = (currentVersion?.recipe.assets ?? []).map((a) => {
    const reg = input.assetsByKey.get(assetIdentityKey(a));
    return {
      chain: a.chain,
      address: a.address,
      symbol: a.symbol,
      name: reg?.name ?? null,
      assetType: reg?.assetType ?? null,
      decimals: a.decimals,
      weightBps: a.weightBps,
      routeStatus: reg?.routeStatus ?? null,
      routeCheckedAt: reg?.routeCheckedAt ?? null,
    };
  });

  const deployed = input.deployment?.status === 'DEPLOYED';
  const policy = currentVersion
    ? deriveStrategyPolicy(currentVersion.recipe, { mutability: bag.mutability, deployed, performanceFeeBpsLocked: bag.performanceFeeBpsLocked ?? null })
    : null;

  return {
    schemaVersion: STRATEGY_PASSPORT_SCHEMA_VERSION,
    generatedAt: input.now.toISOString(),
    identity: {
      sourceInfo: db(bag.updatedAt),
      bagId: bag.id,
      slug: bag.slug,
      name: bag.name,
      symbol: bag.symbol,
      description: bag.description,
      chain: bag.chain,
      strategyType: bag.strategyType,
      mutability: bag.mutability,
      status: bag.status,
      createdAt: bag.createdAt,
    },
    onchain: onchainSection(bag, input.deployment),
    creator: { sourceInfo: db(null), ...personOf(bag.creatorId, creators) },
    currentVersion: currentVersion
      ? {
          sourceInfo: db(currentVersion.createdAt),
          version: currentVersion.version,
          createdAt: currentVersion.createdAt,
          reason: currentVersion.reason,
          onchainCompositionHash: currentRow?.onchain_composition_hash ?? null,
        }
      : null,
    composition: { sourceInfo: db(currentVersion?.createdAt ?? null), assets, totalWeightBps: assets.reduce((s, a) => s + a.weightBps, 0) },
    performance: {
      sourceInfo: derived(input.nav.asOf),
      tvlUsd: input.nav.tvlUsd,
      navPerShare: input.nav.navPerShare,
      returns: input.returns,
      holders: input.holders,
    },
    policy,
    lineage: {
      versions: { sourceInfo: db(latestVersionAt), nodes: versionNodes },
      forks: {
        sourceInfo: db(null),
        ancestors: [...input.ancestors.map((b) => forkNode(b, input.viewerUserId, creators)), ...input.missingAncestorIds.map(hiddenNode)],
        rootBagId: bag.rootBagId ?? bag.id,
        isOriginal: bag.parentBagId === null,
        children: input.children.map((b) => forkNode(b, input.viewerUserId, creators)).filter((n) => n.visible),
        childCount: input.childCount,
        forkRoyaltyBps: FORK_ROYALTY_BPS,
        forkedFromVersion: null,
      },
    },
  };
}

// ----------------------------- Loading ----------------------------------------

/** Columns read from bag_versions (checked against the real schema by an integration test). */
export const VERSION_ROW_COLUMNS = 'id,version,created_at,reason,composition_hash,onchain_tx_hash,onchain_version,onchain_composition_hash,metadata_uri';

async function loadVersionRows(admin: SupabaseClient, bagId: string): Promise<VersionOnchainRow[]> {
  const { data, error } = await admin
    .from('bag_versions')
    .select(VERSION_ROW_COLUMNS)
    .eq('bag_id', bagId)
    .order('version', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as VersionOnchainRow[];
}

/** Marks the version the Bag was deployed with as on-chain version 1 (lib/server/deployed-version.ts). */
async function withDeployedVersion(
  admin: SupabaseClient,
  rows: VersionOnchainRow[],
  deployment: BagDeployment | null,
  currentVersion: BagVersionRecord | null
): Promise<VersionOnchainRow[]> {
  const deployedId = resolveDeployedVersionId(rows, deployment);
  if (!deployedId || !deployment?.txHash) return rows;
  let recipe = currentVersion?.id === deployedId ? currentVersion.recipe : null;
  if (!recipe) {
    const { data, error } = await admin.from('bag_versions').select('recipe').eq('id', deployedId).maybeSingle<{ recipe: BagVersionRecord['recipe'] }>();
    if (error || !data) return rows;
    recipe = data.recipe;
  }
  const hash = deployedCompositionHash(recipe);
  if (!hash) return rows;
  return rows.map((r) => (r.id === deployedId ? { ...r, onchain_tx_hash: deployment.txHash, onchain_version: 1, onchain_composition_hash: hash } : r));
}

async function loadAncestors(admin: SupabaseClient, bag: BagRecord): Promise<{ ancestors: BagRecord[]; missing: string[] }> {
  const ancestors: BagRecord[] = [];
  const missing: string[] = [];
  const seen = new Set([bag.id]);
  let parentId = bag.parentBagId;
  while (parentId && !seen.has(parentId) && ancestors.length + missing.length < MAX_FORK_DEPTH) {
    seen.add(parentId);
    const parent = await getBagById(admin, parentId);
    if (!parent) {
      missing.push(parentId);
      break;
    }
    ancestors.push(parent);
    parentId = parent.parentBagId;
  }
  return { ancestors, missing };
}

async function loadChildren(admin: SupabaseClient, bagId: string): Promise<{ children: BagRecord[]; count: number }> {
  const { data, error, count } = await admin.from('bags').select('id', { count: 'exact' }).eq('parent_bag_id', bagId).order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  const children = (await Promise.all(ids.map((id) => getBagById(admin, id)))).filter((b): b is BagRecord => b !== null);
  return { children, count: count ?? children.length };
}

/** Gathers everything for `bag` with the existing repos and builds its passport. Display data that fails to load is left null, never guessed. */
export async function loadStrategyPassport(admin: SupabaseClient, bag: BagRecord, viewerUserId: string | null): Promise<StrategyPassport> {
  const [currentVersion, loadedVersions, deployment, lineageUp, lineageDown] = await Promise.all([
    getCurrentBagVersion(admin, bag.id),
    loadVersionRows(admin, bag.id),
    getDeployment(admin, bag.id, bag.chain).catch(() => null),
    loadAncestors(admin, bag),
    loadChildren(admin, bag.id),
  ]);
  const versions = await withDeployedVersion(admin, loadedVersions, deployment, currentVersion);

  const people = [bag.creatorId, ...lineageUp.ancestors.map((b) => b.creatorId), ...lineageDown.children.map((b) => b.creatorId)];
  const [creators, assetsByKey, navOutcome, snapshots, social] = await Promise.all([
    loadCreatorProfiles(admin, people),
    loadRecipeAssets(admin, [currentVersion]),
    getBagNavSafe(admin, bag.id, getDisplayPriceProvider()).catch(() => null),
    getNavSnapshots(admin, bag.id).catch(() => []),
    getBagSocialCounts(admin, [bag.id]).catch(() => null),
  ]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  return buildStrategyPassport({
    bag,
    currentVersion,
    versions,
    deployment,
    creators,
    assetsByKey,
    nav: {
      tvlUsd: navOutcome && navOutcome.ok ? navOutcome.nav.grossNav : null,
      navPerShare: latest?.navPerShare ?? null,
      asOf: navOutcome && navOutcome.ok ? navOutcome.nav.asOf : (latest?.capturedAt ?? null),
    },
    returns: snapshots.length > 0 ? computeBagPerformance(snapshots) : null,
    holders: social?.get(bag.id)?.holders ?? null,
    ancestors: lineageUp.ancestors,
    missingAncestorIds: lineageUp.missing,
    children: lineageDown.children,
    childCount: lineageDown.count,
    viewerUserId,
    now: new Date(),
  });
}
