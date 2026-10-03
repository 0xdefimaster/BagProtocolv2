import { AccessorySlot } from '@/types/domain';

// -----------------------------------------------------------------------------
// Forge-local rarity scale. Deliberately NOT the same `Rarity` type used by
// the box-drop/points economy (types/domain.ts) — that type is a closed
// 5-tier scale wired into BASE_RARITY_WEIGHTS / RARITY_WEIGHTS_BY_BOX
// (lib/config/rarity.ts) and touching it would ripple into unrelated,
// already-working code. The Forge spec calls for a 6th tier (MYTHIC), so it
// gets its own scale, scoped to this module.
// -----------------------------------------------------------------------------
export type ForgeRarity = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'MYTHIC';

export const FORGE_RARITY_ORDER: ForgeRarity[] = [
  'COMMON',
  'UNCOMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
  'MYTHIC',
];

export const FORGE_RARITY_SCORE: Record<ForgeRarity, number> = {
  COMMON: 1,
  UNCOMMON: 2,
  RARE: 3,
  EPIC: 4,
  LEGENDARY: 5,
  MYTHIC: 6,
};

/**
 * One real, on-disk 1024x1024 transparent PNG asset, pre-aligned to the
 * shared BAG character canvas. `zIndex` is the fixed compositor layer order
 * from the spec (BASE=0, BACK=10, BODY=20, FEET=30, HEAD=40, FACE=50,
 * NECK=60, HANDS=70, SPECIAL=80) — never derived from selection order.
 */
export interface ForgeAsset {
  id: string;
  slot: AccessorySlot;
  name: string;
  rarity: ForgeRarity;
  image: string;
  zIndex: number;
}
