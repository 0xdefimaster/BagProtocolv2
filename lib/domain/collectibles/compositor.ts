import { AccessorySlot, ACCESSORY_SLOTS } from '@/types/domain';
import { getAccessoryById } from '@/data/mock-accessories';
import { BASE_ASSET } from '@/data/base-asset';

// -----------------------------------------------------------------------------
// The 8-layer compositor's pure core: given a (possibly partial) slot
// selection, produce the ordered stack of image layers to draw. No DOM, no
// canvas, no randomness — deterministic and unit-testable on its own. The
// actual pixel compositing lives in canvas-compositor.ts (client-only, needs
// <img>/<canvas>); on-screen preview lives in components/nft/BagCompositePreview.tsx
// (stacked <img> layers, no canvas needed at all).
//
// Canonical z-order (bottom -> top). BASE is always first and always present;
// every accessory slot after it follows this fixed order regardless of the
// order the caller passed them in, so two callers with the same selection
// always get the same visual result.
// -----------------------------------------------------------------------------
export const LAYER_ORDER: AccessorySlot[] = [...ACCESSORY_SLOTS];

export interface CompositeLayer {
  slot: 'BASE' | AccessorySlot;
  accessoryId?: string;
  name: string;
  image: string;
}

export type SlotSelection = Partial<Record<AccessorySlot, string>>;

/**
 * Builds the ordered layer stack for a given selection. Missing slots are
 * simply omitted (this is what makes preview-with-gaps and a completed 8/8
 * BAG the same code path — the only difference is how many layers resolve).
 */
export function buildLayerStack(selection: SlotSelection): CompositeLayer[] {
  const layers: CompositeLayer[] = [
    { slot: 'BASE', name: BASE_ASSET.name, image: BASE_ASSET.image },
  ];

  for (const slot of LAYER_ORDER) {
    const accessoryId = selection[slot];
    if (!accessoryId) continue;
    const accessory = getAccessoryById(accessoryId);
    if (!accessory) continue;
    layers.push({ slot, accessoryId, name: accessory.name, image: accessory.image });
  }

  return layers;
}

export function isCompleteSelection(selection: SlotSelection): boolean {
  return ACCESSORY_SLOTS.every((slot) => Boolean(selection[slot]));
}

export const COMPOSITE_CANVAS_SIZE = 1024;
