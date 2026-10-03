import { BoxTypeId, Rarity } from '@/types/domain';

export type RarityWeights = Record<Rarity, number>;

// Base odds from the spec (percent, out of 100). Used for Common boxes.
export const BASE_RARITY_WEIGHTS: RarityWeights = {
  COMMON: 60,
  UNCOMMON: 25,
  RARE: 10,
  EPIC: 4,
  LEGENDARY: 1,
};

// Higher box tiers skew the odds toward better rarities. Values are still
// percentages that sum to 100 — kept in config so they can be tuned freely.
export const RARITY_WEIGHTS_BY_BOX: Record<BoxTypeId, RarityWeights> = {
  COMMON: BASE_RARITY_WEIGHTS,
  RARE: {
    COMMON: 35,
    UNCOMMON: 32,
    RARE: 22,
    EPIC: 9,
    LEGENDARY: 2,
  },
  EPIC: {
    COMMON: 10,
    UNCOMMON: 25,
    RARE: 33,
    EPIC: 24,
    LEGENDARY: 8,
  },
};

export const RARITY_ORDER: Rarity[] = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];

export const RARITY_SCORE: Record<Rarity, number> = {
  COMMON: 1,
  UNCOMMON: 2,
  RARE: 3,
  EPIC: 4,
  LEGENDARY: 5,
};
