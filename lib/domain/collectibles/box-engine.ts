import { Accessory, AccessorySlot, BoxTypeId, Rarity } from '@/types/domain';
import { RarityWeights, RARITY_WEIGHTS_BY_BOX } from '@/lib/config/rarity';

/**
 * Rolls a rarity tier for the given box type. This is the one place random
 * numbers decide a reward — it must only ever run in the "server" service
 * layer (lib/services/box-service.ts), never be passed in from a component,
 * so the result can't be predicted or forced client-side.
 */
export function rollRarity(boxType: BoxTypeId, weights: RarityWeights = RARITY_WEIGHTS_BY_BOX[boxType]): Rarity {
  const entries = Object.entries(weights) as [Rarity, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;

  for (const [rarity, weight] of entries) {
    if (roll < weight) return rarity;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

export function pickRandomSlot(): AccessorySlot {
  const slots: AccessorySlot[] = ['HEAD', 'FACE', 'NECK', 'BODY', 'BACK', 'HANDS', 'FEET', 'SPECIAL'];
  return slots[Math.floor(Math.random() * slots.length)];
}

/**
 * Picks a random accessory of the given rarity from the pool. Falls back to
 * the closest available rarity if the pool has none at the exact tier, so a
 * thin pool never causes a dead roll.
 */
export function pickAccessory(pool: Accessory[], rarity: Rarity): Accessory {
  const exact = pool.filter((a) => a.rarity === rarity);
  const candidates = exact.length > 0 ? exact : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
