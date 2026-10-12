import { BagVersionRecord, RecipeAsset } from '@/types/basket-protocol';
import type { CreatorProfile, NavSnapshotPoint } from '@/types';
import { diffRecipes, StrategyDiff } from '@/lib/domain/basket-protocol/strategy-diff';

// -----------------------------------------------------------------------------
// Version Timeline: every version of a Bag, newest first, each with who made
// it, why (`bag_versions.reason`), its composition, the Strategy Diff from the
// version before, and how the price index moved while it was the live version —
// measured only from recorded, indexed NAV snapshots (bag_nav_snapshots, 0055), so
// a version that predates the indexed history shows no figure rather than an estimate.
// -----------------------------------------------------------------------------

export interface VersionPerformance {
  fromAt: string;
  toAt: string;
  fromIndex: string;
  toIndex: string;
  /** Percent change of the price index over [fromAt, toAt]: holdings' prices only, never purchases or sales. */
  returnPct: number;
}

export const VERSION_TIMELINE_SCHEMA_VERSION = 1;

export interface VersionTimelineEntry {
  version: number;
  createdAt: string;
  reason: string;
  /** Identified by wallet, never by internal user id. */
  createdBy: { name: string | null; address: string | null };
  isCurrent: boolean;
  assets: RecipeAsset[];
  /** Against the previous version; the first version lists every asset as ADDED. */
  diff: StrategyDiff;
  /** Null when no recorded snapshot covers this version's live period. */
  performance: VersionPerformance | null;
}

/** First snapshot at or after `iso`, if any. Snapshots must be oldest-first. */
function firstAtOrAfter(snapshots: NavSnapshotPoint[], iso: string): NavSnapshotPoint | undefined {
  const t = Date.parse(iso);
  return snapshots.find((s) => Date.parse(s.capturedAt) >= t);
}

/** Last snapshot strictly before `iso`, if any. */
function lastBefore(snapshots: NavSnapshotPoint[], iso: string): NavSnapshotPoint | undefined {
  const t = Date.parse(iso);
  let found: NavSnapshotPoint | undefined;
  for (const s of snapshots) {
    if (Date.parse(s.capturedAt) < t) found = s;
    else break;
  }
  return found;
}

export function versionPerformance(all: NavSnapshotPoint[], liveFrom: string, liveUntil: string | null): VersionPerformance | null {
  const snapshots = all.filter((s) => s.priceIndex !== null);
  const start = firstAtOrAfter(snapshots, liveFrom);
  if (!start) return null;
  const end = liveUntil === null ? snapshots[snapshots.length - 1] : lastBefore(snapshots, liveUntil);
  if (!end || Date.parse(end.capturedAt) <= Date.parse(start.capturedAt)) return null;
  const from = Number(start.priceIndex);
  const to = Number(end.priceIndex);
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return { fromAt: start.capturedAt, toAt: end.capturedAt, fromIndex: start.priceIndex!, toIndex: end.priceIndex!, returnPct: (to / from - 1) * 100 };
}

/**
 * Builds the timeline. `versions` may come in any order; `snapshots` must be
 * oldest-first (as getNavSnapshots returns them).
 */
export function buildVersionTimeline(
  versions: BagVersionRecord[],
  currentVersionId: string | null,
  snapshots: NavSnapshotPoint[],
  creators: Map<string, CreatorProfile>
): VersionTimelineEntry[] {
  const ascending = [...versions].sort((a, b) => a.version - b.version);
  const entries = ascending.map((v, i): VersionTimelineEntry => {
    const previous = i > 0 ? ascending[i - 1] : null;
    const next = i < ascending.length - 1 ? ascending[i + 1] : null;
    const creator = creators.get(v.createdBy);
    const isCurrent = currentVersionId ? v.id === currentVersionId : next === null;
    return {
      version: v.version,
      createdAt: v.createdAt,
      reason: v.reason,
      createdBy: { name: creator?.name ?? null, address: creator?.address ?? null },
      isCurrent,
      assets: v.recipe.assets,
      diff: diffRecipes(previous?.recipe ?? null, v.recipe),
      performance: versionPerformance(snapshots, v.createdAt, next?.createdAt ?? null),
    };
  });
  return entries.reverse();
}
