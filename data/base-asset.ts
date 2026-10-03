// -----------------------------------------------------------------------------
// The BASE character layer — always present, never selected, never consumed
// from inventory. This is the one manifest entry that isn't an `Accessory`
// (it has no slot, rarity, or weight in the trait sense), so it gets its own
// small type rather than being force-fit into `Accessory`.
// -----------------------------------------------------------------------------

export interface BaseAsset {
  id: 'bag-base-character';
  name: string;
  /** Path to the transparent base-character PNG, drawn first (bottom layer). */
  image: string;
}

export const BASE_ASSET: BaseAsset = {
  id: 'bag-base-character',
  name: 'BAG Base Character',
  image: '/assets/bag/base/bag-base.png',
};
