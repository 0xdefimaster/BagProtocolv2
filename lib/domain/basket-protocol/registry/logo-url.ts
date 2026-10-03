import { CanonicalAsset } from '@/types/basket-protocol';

// Token logo URLs as the importers receive them from their source
// (Robinhood `logoUrl`, LI.FI `logoURI`). Same rule as the
// `assets_logo_url_https` check in supabase/migrations/0037_asset_logo_url.sql:
// https only, bounded length — anything else is dropped, never rewritten.

const MAX_LOGO_URL_LENGTH = 2048;

export function sanitizeLogoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGO_URL_LENGTH) return undefined;
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export interface LogoUpdate {
  asset: CanonicalAsset;
  logoUrl: string;
}

/** Already-registered assets whose source now has a (different) logo. Pure. */
export function planLogoUpdates(
  existing: CanonicalAsset[],
  remoteLogoByKey: Map<string, string | undefined>,
  keyOf: (a: CanonicalAsset) => string
): LogoUpdate[] {
  const updates: LogoUpdate[] = [];
  for (const asset of existing) {
    const logoUrl = remoteLogoByKey.get(keyOf(asset));
    if (logoUrl && logoUrl !== asset.logoUrl) updates.push({ asset, logoUrl });
  }
  return updates;
}

export interface ApplyLogoUpdatesResult {
  updated: CanonicalAsset[];
  failed: { update: LogoUpdate; error: string }[];
}

/** Continues past individual failures; every outcome is reported back. */
export async function applyLogoUpdates(
  updateFn: (id: string, logoUrl: string) => Promise<CanonicalAsset>,
  updates: LogoUpdate[]
): Promise<ApplyLogoUpdatesResult> {
  const updated: CanonicalAsset[] = [];
  const failed: { update: LogoUpdate; error: string }[] = [];
  for (const update of updates) {
    try {
      updated.push(await updateFn(update.asset.id, update.logoUrl));
    } catch (err) {
      failed.push({ update, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { updated, failed };
}
