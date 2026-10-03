import type { SupabaseClient } from '@supabase/supabase-js';
import { BagRecord, BagVersionRecord, CanonicalAsset } from '@/types/basket-protocol';
import type { BagPerformance, CreatorProfile } from '@/types';
import {
  Enforcement,
  PassportCreator,
  PassportForkNode,
  PassportPolicyRule,
  PassportVersionNode,
  STRATEGY_PASSPORT_SCHEMA_VERSION,
  StrategyPassport,
} from '@/types/strategy-passport';
import { MAX_ACCEPTABLE_PRICE_IMPACT_BPS } from '@/types/purchase-intent';
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
import { bagSlippageBps } from '@/lib/server/purchase-execution';

// -----------------------------------------------------------------------------
// Builds the Strategy Passport (types/strategy-passport.ts) from data BAG
// already stores — no new tables. `buildStrategyPassport` is pure (tested on
// its own); `loadStrategyPassport` gathers the inputs with the existing repos.
// -----------------------------------------------------------------------------

/** Composer's own default whole-transaction price-impact limit (lifi-composer-adapter.ts). */
const COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS = 500;
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

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

function creatorOf(userId: string, creators: Map<string, CreatorProfile>): PassportCreator {
  const p = creators.get(userId);
  return { userId, name: p?.name ?? null, walletAddress: p?.address ?? null, avatarUrl: p?.avatarUrl ?? null };
}

function forkNode(bag: BagRecord, viewerUserId: string | null, creators: Map<string, CreatorProfile>): PassportForkNode {
  const visible = bag.status === 'ACTIVE' || (viewerUserId !== null && bag.creatorId === viewerUserId);
  if (!visible) return { bagId: bag.id, visible: false, name: null, symbol: null, status: null, creator: null, createdAt: null };
  return { bagId: bag.id, visible: true, name: bag.name, symbol: bag.symbol, status: bag.status, creator: creatorOf(bag.creatorId, creators), createdAt: bag.createdAt };
}

export function buildPolicyRules(bag: BagRecord, version: BagVersionRecord | null, deployment: BagDeployment | null): PassportPolicyRule[] {
  const recipe = version?.recipe;
  const deployed = deployment?.status === 'DEPLOYED';
  const rules: PassportPolicyRule[] = [];
  const push = (key: string, label: string, value: PassportPolicyRule['value'], display: string, enforcement: Enforcement, note?: string) =>
    rules.push({ key, label, value, display, enforcement, ...(note ? { note } : {}) });

  if (bag.mutability === 'IMMUTABLE') {
    push('composition_changes', 'Composition changes', 'NEVER', 'Never — immutable', 'DATABASE', 'The database rejects any new version of an immutable Bag.');
  } else if (deployed) {
    push(
      'composition_changes',
      'Composition changes',
      'ONCHAIN_VERSION_ONLY',
      'Only through an on-chain version',
      'DATABASE',
      "The database refuses off-chain edits of a deployed Bag; each new version's composition hash is recorded on-chain by the creator's own transaction."
    );
  } else {
    push('composition_changes', 'Composition changes', 'CREATOR_EDITS', 'Creator can edit (not deployed yet)', 'DATABASE');
  }

  if (recipe) {
    push('max_weight_per_asset', 'Max weight per asset', recipe.maxWeightBps, pct(recipe.maxWeightBps), 'BAG_SERVER', 'Checked when a version is created.');
    push('min_weight_per_asset', 'Min weight per asset', recipe.minWeightBps, pct(recipe.minWeightBps), 'BAG_SERVER', 'Checked when a version is created.');
    push('max_assets', 'Max assets', recipe.maxAssets, String(recipe.maxAssets), 'BAG_SERVER', 'Checked when a version is created.');
    push('min_investment', 'Min investment', recipe.minInvestment, `$${recipe.minInvestment}`, 'BAG_SERVER', 'Checked when a purchase is previewed and created.');
  }

  const locked = bag.performanceFeeBpsLocked ?? null;
  const fee = locked ?? recipe?.performanceFeeBps ?? 0;
  push(
    'performance_fee',
    'Performance fee (on realized profit)',
    fee,
    pct(fee),
    locked !== null ? 'DATABASE' : 'BAG_SERVER',
    locked !== null
      ? `Locked since ${bag.performanceFeeLockedAt ?? 'the first external investment'}; the database rejects any change.`
      : 'The creator can change it until the first external investor; it then locks permanently.'
  );

  if (version) {
    const slip = bagSlippageBps(version);
    push(
      'max_slippage_per_swap',
      'Max slippage per swap',
      slip,
      pct(slip),
      'ONCHAIN',
      'Each swap in the purchase transaction carries its minimum output and reverts below it. BAG sets the value from the recipe, clamped to 0.1%–3%.'
    );
  }

  push(
    'max_price_impact',
    'Max price impact per purchase',
    COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS,
    `${pct(COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS)} (up to ${pct(MAX_ACCEPTABLE_PRICE_IMPACT_BPS)} with buyer consent)`,
    'PROVIDER',
    'LI.FI Composer refuses to compile above the limit; BAG never lets a buyer accept more than the cap.'
  );

  if (recipe) {
    const unroutable = recipe.unroutablePolicy ?? 'BLOCK';
    push('unroutable_policy', 'If an asset has no route', unroutable, unroutable, 'BAG_SERVER', 'Applied when a purchase is created.');
    push(
      'rebalance',
      'Rebalance rule',
      recipe.rebalanceRule.frequency,
      `${recipe.rebalanceRule.frequency}, drift ${pct(recipe.rebalanceRule.driftThresholdBps)}`,
      'DECLARED',
      'No automatic rebalancing runs today.'
    );
  }
  return rules;
}

function onchainSection(bag: BagRecord, deployment: BagDeployment | null): StrategyPassport['onchain'] {
  if (!deployment || deployment.status !== 'DEPLOYED') return null;
  const cfg = (BAG_CHAINS as Partial<Record<string, (typeof BAG_CHAINS)[BagChain]>>)[deployment.chain];
  const contract = deployment.contractAddress ?? bag.contractAddress;
  return {
    provenance: 'ONCHAIN_RECORDED',
    chain: deployment.chain,
    chainId: cfg?.chainId ?? null,
    onChainBagId: deployment.onChainBagId,
    onChainCreator: deployment.onChainCreator,
    contractAddress: contract,
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

  const versionNodes: PassportVersionNode[] = ascending.map((v) => ({
    versionId: v.id,
    version: v.version,
    parentVersion: v.version > 1 ? v.version - 1 : null,
    createdAt: v.created_at,
    reason: v.reason,
    compositionHash: v.composition_hash,
    isCurrent: currentVersion ? v.id === currentVersion.id : false,
    onchain:
      v.onchain_tx_hash && v.onchain_version !== null && v.onchain_composition_hash
        ? { txHash: v.onchain_tx_hash, onchainVersion: v.onchain_version, compositionHash: v.onchain_composition_hash, metadataUri: v.metadata_uri }
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

  const ancestors: PassportForkNode[] = [
    ...input.ancestors.map((b) => forkNode(b, input.viewerUserId, creators)),
    ...input.missingAncestorIds.map((id) => ({ bagId: id, visible: false, name: null, symbol: null, status: null, creator: null, createdAt: null })),
  ];

  return {
    schemaVersion: STRATEGY_PASSPORT_SCHEMA_VERSION,
    generatedAt: input.now.toISOString(),
    identity: {
      provenance: 'DATABASE',
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
    creator: { provenance: 'DATABASE', ...creatorOf(bag.creatorId, creators) },
    currentVersion: currentVersion
      ? {
          provenance: 'DATABASE',
          versionId: currentVersion.id,
          version: currentVersion.version,
          createdAt: currentVersion.createdAt,
          reason: currentVersion.reason,
          compositionHash: currentVersion.compositionHash,
          onchainCompositionHash: currentRow?.onchain_composition_hash ?? null,
        }
      : null,
    composition: { provenance: 'DATABASE', assets, totalWeightBps: assets.reduce((s, a) => s + a.weightBps, 0) },
    performance: {
      provenance: 'BAG_COMPUTED',
      tvlUsd: input.nav.tvlUsd,
      navPerShare: input.nav.navPerShare,
      navAsOf: input.nav.asOf,
      returns: input.returns,
      holders: input.holders,
    },
    policy: { rules: buildPolicyRules(bag, currentVersion, input.deployment) },
    lineage: {
      versions: { provenance: 'DATABASE', nodes: versionNodes },
      forks: {
        provenance: 'DATABASE',
        ancestors,
        rootBagId: bag.rootBagId ?? bag.id,
        isOriginal: bag.parentBagId === null,
        children: input.children.map((b) => forkNode(b, input.viewerUserId, creators)).filter((n) => n.visible),
        childCount: input.childCount,
        forkRoyaltyBps: FORK_ROYALTY_BPS,
        forkedFromVersion: null,
      },
    },
    provenance: {
      identity: 'DATABASE',
      onchain: 'ONCHAIN_RECORDED',
      creator: 'DATABASE',
      currentVersion: 'DATABASE',
      composition: 'DATABASE',
      performance: 'BAG_COMPUTED',
      'lineage.versions': 'DATABASE',
      'lineage.forks': 'DATABASE',
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
  const [currentVersion, versions, deployment, lineageUp, lineageDown] = await Promise.all([
    getCurrentBagVersion(admin, bag.id),
    loadVersionRows(admin, bag.id),
    getDeployment(admin, bag.id, bag.chain).catch(() => null),
    loadAncestors(admin, bag),
    loadChildren(admin, bag.id),
  ]);

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
