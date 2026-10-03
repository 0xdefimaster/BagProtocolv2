import { AccessorySlot, ACCESSORY_SLOTS } from '@/types/domain';
import { CompositeLayer } from '@/lib/domain/collectibles/compositor';
import { FORGE_BASE_ASSET, getForgeAssetById } from './manifest';

export type ForgeSelection = Partial<Record<AccessorySlot, string>>;

/** Ordered BASE + selected-slot layer stack, ready for the canvas compositor. */
export function buildForgeLayerStack(selection: ForgeSelection): CompositeLayer[] {
  const layers: { layer: CompositeLayer; zIndex: number }[] = [
    {
      layer: {
        slot: 'BASE',
        name: FORGE_BASE_ASSET.name,
        image: FORGE_BASE_ASSET.image,
      },
      zIndex: FORGE_BASE_ASSET.zIndex,
    },
  ];

  for (const slot of ACCESSORY_SLOTS) {
    const id = selection[slot];
    const asset = getForgeAssetById(id);
    if (!asset) continue;

    layers.push({
      layer: {
        slot,
        accessoryId: asset.id,
        name: asset.name,
        image: asset.image,
      },
      zIndex: asset.zIndex,
    });
  }

  // Exported composite MUST use the exact same z-order as the live preview.
  layers.sort((a, b) => a.zIndex - b.zIndex);
  return layers.map((entry) => entry.layer);
}

/** The pre-mint combination JSON shown to the user (spec section 10). */
export function buildCombinationJson(selection: Record<AccessorySlot, string>) {
  const out: Record<string, string> = { base: FORGE_BASE_ASSET.id };
  for (const slot of ACCESSORY_SLOTS) {
    out[slot.toLowerCase()] = selection[slot];
  }
  return out;
}

function toTraitType(slot: AccessorySlot): string {
  return slot.charAt(0) + slot.slice(1).toLowerCase();
}

/** OpenSea-style metadata.json matching the spec's exact shape (section 11). */
export function buildForgeMetadata(
  selection: Record<AccessorySlot, string>,
  opts: { name?: string; imageFile?: string } = {}
) {
  const attributes = ACCESSORY_SLOTS.map((slot) => {
    const asset = getForgeAssetById(selection[slot]);
    return { trait_type: toTraitType(slot), value: asset?.name ?? 'Unknown' };
  });

  return {
    name: opts.name ?? 'BAG #0001',
    description: 'A unique BAG Protocol character.',
    image: opts.imageFile ?? 'final_bag.png',
    attributes,
  };
}
