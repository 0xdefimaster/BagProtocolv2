import { Accessory } from '@/types/domain';

// Lightweight MVP art: an emoji stands in for real illustration. The `image`
// field is where a real asset URL goes once art is produced — nothing else
// in the collectible pipeline needs to change.
export const ACCESSORY_POOL: Accessory[] = [
  // HEAD
  { id: 'head-cyber-cap', name: 'Cyber Cap', slot: 'HEAD', rarity: 'RARE', image: '🧢', metadata: {} },
  { id: 'head-beanie', name: 'BAG Beanie', slot: 'HEAD', rarity: 'COMMON', image: '🎩', metadata: {} },
  { id: 'head-halo', name: 'Golden Halo', slot: 'HEAD', rarity: 'LEGENDARY', image: '😇', metadata: {} },
  { id: 'head-headband', name: 'Trader Headband', slot: 'HEAD', rarity: 'UNCOMMON', image: '🎽', metadata: {} },

  // FACE
  { id: 'face-laser-glasses', name: 'Laser Glasses', slot: 'FACE', rarity: 'RARE', image: '🕶️', metadata: {} },
  { id: 'face-monocle', name: 'Diamond Monocle', slot: 'FACE', rarity: 'EPIC', image: '🧐', metadata: {} },
  { id: 'face-shades', name: 'Classic Shades', slot: 'FACE', rarity: 'COMMON', image: '😎', metadata: {} },
  { id: 'face-visor', name: 'Neon Visor', slot: 'FACE', rarity: 'UNCOMMON', image: '🥽', metadata: {} },

  // NECK
  { id: 'neck-red-scarf', name: 'Red Scarf', slot: 'NECK', rarity: 'COMMON', image: '🧣', metadata: {} },
  { id: 'neck-gold-chain', name: 'Gold Chain', slot: 'NECK', rarity: 'RARE', image: '📿', metadata: {} },
  { id: 'neck-bowtie', name: 'Trader Bowtie', slot: 'NECK', rarity: 'UNCOMMON', image: '🎀', metadata: {} },
  { id: 'neck-medallion', name: 'Genesis Medallion', slot: 'NECK', rarity: 'LEGENDARY', image: '🏅', metadata: {} },

  // BODY
  { id: 'body-hoodie', name: 'BAG Hoodie', slot: 'BODY', rarity: 'COMMON', image: '🧥', metadata: {} },
  { id: 'body-suit', name: 'Pinstripe Suit', slot: 'BODY', rarity: 'RARE', image: '🥼', metadata: {} },
  { id: 'body-armor', name: 'Diamond-Hand Armor', slot: 'BODY', rarity: 'EPIC', image: '🦺', metadata: {} },
  { id: 'body-tee', name: 'Genesis Tee', slot: 'BODY', rarity: 'UNCOMMON', image: '👕', metadata: {} },

  // BACK
  { id: 'back-rocket', name: 'Rocket Backpack', slot: 'BACK', rarity: 'EPIC', image: '🚀', metadata: {} },
  { id: 'back-cape', name: 'Trader Cape', slot: 'BACK', rarity: 'RARE', image: '🦸', metadata: {} },
  { id: 'back-wings', name: 'Bull Wings', slot: 'BACK', rarity: 'LEGENDARY', image: '🪽', metadata: {} },
  { id: 'back-satchel', name: 'Canvas Satchel', slot: 'BACK', rarity: 'COMMON', image: '🎒', metadata: {} },

  // HANDS
  { id: 'hands-diamond-gloves', name: 'Diamond Gloves', slot: 'HANDS', rarity: 'RARE', image: '🧤', metadata: {} },
  { id: 'hands-fingerless', name: 'Fingerless Gloves', slot: 'HANDS', rarity: 'COMMON', image: '🖐️', metadata: {} },
  { id: 'hands-golden-fist', name: 'Golden Fist', slot: 'HANDS', rarity: 'EPIC', image: '👊', metadata: {} },
  { id: 'hands-rings', name: 'Stacked Rings', slot: 'HANDS', rarity: 'UNCOMMON', image: '💍', metadata: {} },

  // FEET
  { id: 'feet-sneakers', name: 'BAG Sneakers', slot: 'FEET', rarity: 'COMMON', image: '👟', metadata: {} },
  { id: 'feet-boots', name: 'Trader Boots', slot: 'FEET', rarity: 'UNCOMMON', image: '🥾', metadata: {} },
  { id: 'feet-rocket-boots', name: 'Rocket Boots', slot: 'FEET', rarity: 'RARE', image: '🛼', metadata: {} },
  { id: 'feet-golden-cleats', name: 'Golden Cleats', slot: 'FEET', rarity: 'EPIC', image: '⛳', metadata: {} },

  // SPECIAL
  { id: 'special-golden-banana', name: 'Golden Banana', slot: 'SPECIAL', rarity: 'LEGENDARY', image: '🍌', metadata: {} },
  { id: 'special-lucky-coin', name: 'Lucky Coin', slot: 'SPECIAL', rarity: 'RARE', image: '🪙', metadata: {} },
  { id: 'special-candle', name: 'Green Candle', slot: 'SPECIAL', rarity: 'UNCOMMON', image: '🕯️', metadata: {} },
  { id: 'special-diamond', name: 'Raw Diamond', slot: 'SPECIAL', rarity: 'EPIC', image: '💎', metadata: {} },
  { id: 'special-cup', name: 'Genesis Cup', slot: 'SPECIAL', rarity: 'COMMON', image: '🏆', metadata: {} },
];

export function accessoriesBySlot(slot: string): Accessory[] {
  return ACCESSORY_POOL.filter((a) => a.slot === slot);
}

/** id -> emoji glyph, derived from ACCESSORY_POOL so there's only one place accessory art lives. Used by AccessoryThumb as the fallback when the real PNG at `accessory.image`'s eventual replacement path 404s. */
export const ACCESSORY_GLYPH_FALLBACK: Record<string, string> = Object.fromEntries(
  ACCESSORY_POOL.map((a) => [a.id, a.image])
);

export function getAccessoryById(id: string): Accessory | undefined {
  return ACCESSORY_POOL.find((a) => a.id === id);
}
