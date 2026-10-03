export type Slot =
  | "HEAD"
  | "FACE"
  | "NECK"
  | "BODY"
  | "BACK"
  | "HANDS"
  | "FEET"
  | "SPECIAL";

export type Rarity = "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY";

export interface BuilderItem {
  id: string;
  name: string;
  slot: Slot;
  rarity: Rarity;
  /** primary layer image, 1024x1024, transparent PNG */
  image: string;
  /** optional second image for slots that need two independent layers (e.g. HANDS: left + right) */
  image2?: string;
  /** optional full-character reference render shown in the item picker */
  preview?: string;
  /** Explicit render priority. Higher values render in front. */
  layer: number;
  description: string;
}

export type EquippedState = Partial<Record<Slot, BuilderItem>>;

export const SLOT_ORDER: Slot[] = [
  "HEAD",
  "FACE",
  "NECK",
  "BODY",
  "BACK",
  "HANDS",
  "FEET",
  "SPECIAL",
];

/**
 * Render order is independent of selection order.
 * A user can select a chain first and a hoodie second (or vice versa) and
 * the final composition is always identical.
 *
 * DO NOT reorder / renumber these — this is the exact layering that keeps
 * every item pinned to the base character (see CharacterCanvas.tsx).
 */
export const RENDER_ORDER: Slot[] = [
  "SPECIAL", // 10: aura/effects behind the character
  "BACK",    // 20: wings/back items behind the character
  "BODY",    // 40: clothing such as hoodies
  "NECK",    // 50: necklaces/chains on top of clothing
  "FACE",    // 60: face items
  "HEAD",    // 70: hats/caps on top of the head
  "HANDS",   // 80: gloves
  "FEET",    // 90: shoes
];

/** Explicit z-index per slot. Base character stays at z=30. */
export const SLOT_Z: Record<Slot, number> = {
  SPECIAL: 10,
  BACK: 20,
  BODY: 40,
  NECK: 50,
  FACE: 60,
  HEAD: 70,
  HANDS: 80,
  FEET: 90,
};

export const BASE_CHARACTER_Z = 30;

export const RARITY_SCORE: Record<Rarity, number> = {
  COMMON: 10,
  UNCOMMON: 25,
  RARE: 40,
  EPIC: 60,
  LEGENDARY: 100,
};

export const RARITY_COLOR: Record<Rarity, string> = {
  COMMON: "#9CA3AF",
  UNCOMMON: "#22C55E",
  RARE: "#3B82F6",
  EPIC: "#A855F7",
  LEGENDARY: "#EAB308",
};

export const SLOT_LABEL: Record<Slot, string> = {
  HEAD: "Head",
  FACE: "Face",
  NECK: "Neck",
  BODY: "Body",
  BACK: "Back",
  HANDS: "Hands",
  FEET: "Feet",
  SPECIAL: "Special",
};
