import manifestData from '@/data/bag-forge-manifest.json';
import { AccessorySlot } from '@/types/domain';
import { ForgeAsset, ForgeRarity } from './types';

// -----------------------------------------------------------------------------
// Single source of truth for the Forge's real, on-disk asset pool. Backed by
// data/bag-forge-manifest.json (a checked-in copy of
// public/assets/bag/manifest.json — the actual list of 1024x1024 transparent
// PNGs that exist under public/assets/bag/<slot>/). Nothing here invents
// filenames; every id in FORGE_ASSET_POOL maps to a real file on disk.
//
// The manifest doesn't carry rarity yet, so rarity is assigned deterministically
// from a hash of the asset id (same id -> same rarity, every load, every
// server). Swap `rarityForId` out for a real curated rarity field on the
// manifest whenever the art pipeline is ready to assign it by hand — nothing
// else in this module needs to change.
// -----------------------------------------------------------------------------

const SLOT_Z_INDEX: Record<AccessorySlot, number> = {
  // Back items must sit BEHIND the base character.
  BACK: -10,
  // Base character is always z=0.
  BODY: 20,
  NECK: 30,
  FACE: 40,
  HEAD: 50,
  HANDS: 60,
  FEET: 70,
  // Special effects/items stay in front.
  SPECIAL: 80,
};

export const FORGE_BASE_ASSET = {
  id: 'bag-base-character',
  name: 'BAG Base Character',
  image: '/assets/bag/base/bag-base.png',
  zIndex: 0,
};

const RARITY_BUCKETS: [ForgeRarity, number][] = [
  ['COMMON', 40],
  ['UNCOMMON', 25],
  ['RARE', 18],
  ['EPIC', 10],
  ['LEGENDARY', 5],
  ['MYTHIC', 2],
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

function rarityForId(id: string): ForgeRarity {
  const roll = hashId(id);
  let acc = 0;
  for (const [rarity, weight] of RARITY_BUCKETS) {
    acc += weight;
    if (roll < acc) return rarity;
  }
  return 'COMMON';
}

interface RawManifestAsset {
  id: string;
  slot: string;
  name: string;
  image: string;
}

export const FORGE_ASSET_POOL: ForgeAsset[] = (manifestData.assets as RawManifestAsset[]).map(
  (a) => ({
    id: a.id,
    slot: a.slot as AccessorySlot,
    name: a.name,
    image: a.image,
    rarity: rarityForId(a.id),
    zIndex: SLOT_Z_INDEX[a.slot as AccessorySlot],
  })
);

const byId = new Map(FORGE_ASSET_POOL.map((a) => [a.id, a]));

export function forgeAssetsBySlot(slot: AccessorySlot): ForgeAsset[] {
  return FORGE_ASSET_POOL.filter((a) => a.slot === slot);
}

export function getForgeAssetById(id: string | undefined | null): ForgeAsset | undefined {
  if (!id) return undefined;
  return byId.get(id);
}
