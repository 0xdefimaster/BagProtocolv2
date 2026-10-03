import { Accessory, AccessorySlot, Rarity } from '@/types/domain';
import { RARITY_ORDER, RARITY_SCORE } from '@/lib/config/rarity';

/**
 * Combines 8 accessories into one overall NFT rarity. Average score maps to
 * a tier, then gets bumped a notch if any single Legendary/Epic piece is
 * present — so a stacked-legendary bag always reads as at least Epic, even
 * if the rest of the set is common.
 */
export function computeNftRarity(accessories: Record<AccessorySlot, Accessory>): Rarity {
  const list = Object.values(accessories);
  const avgScore = list.reduce((sum, a) => sum + RARITY_SCORE[a.rarity], 0) / list.length;

  let tierIndex = Math.min(RARITY_ORDER.length - 1, Math.round(avgScore) - 1);
  tierIndex = Math.max(0, tierIndex);

  const hasLegendary = list.some((a) => a.rarity === 'LEGENDARY');
  const epicCount = list.filter((a) => a.rarity === 'EPIC' || a.rarity === 'LEGENDARY').length;

  if (hasLegendary) {
    tierIndex = Math.max(tierIndex, RARITY_ORDER.indexOf('EPIC'));
  } else if (epicCount >= 2) {
    tierIndex = Math.max(tierIndex, RARITY_ORDER.indexOf('RARE'));
  }

  return RARITY_ORDER[tierIndex];
}
