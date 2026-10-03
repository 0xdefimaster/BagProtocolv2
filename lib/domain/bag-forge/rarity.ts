import { AccessorySlot, ACCESSORY_SLOTS } from '@/types/domain';
import { getForgeAssetById } from './manifest';
import { FORGE_RARITY_ORDER, FORGE_RARITY_SCORE, ForgeRarity } from './types';

/**
 * Final BAG rarity = simple weighted average of the 8 selected parts' rarity
 * scores, rounded to the nearest tier. Kept intentionally simple (per spec
 * section 9) and isolated in its own function so the scoring formula can be
 * swapped later without touching the compositor or UI.
 */
export function computeBagRarity(
  selection: Partial<Record<AccessorySlot, string>>
): ForgeRarity | 'UNEQUIPPED' {
  const scores = ACCESSORY_SLOTS.map((slot) => {
    const asset = getForgeAssetById(selection[slot]);
    return asset ? FORGE_RARITY_SCORE[asset.rarity] : null;
  });

  if (scores.some((s) => s === null)) return 'UNEQUIPPED';

  const avg = (scores as number[]).reduce((sum, s) => sum + s, 0) / scores.length;
  const idx = Math.min(FORGE_RARITY_ORDER.length - 1, Math.max(0, Math.round(avg) - 1));
  return FORGE_RARITY_ORDER[idx];
}
