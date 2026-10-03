# Inventory / Asset Pass

## What changed

- Added `public/assets/bag_v2/` as the corrected 1024x1024 aligned asset pool used by the Forge inventory.
- Fixed FEET assets that contained only one shoe by producing mirrored left/right pairs while preserving the original artwork.
- Moved the four headphone-style neck assets into corrected FACE-slot versions (`face_audio_headphones_01..04`) so they no longer appear as misplaced neck items.
- Added six new BAG-compatible NFT-style jacket variants:
  - Void Tech Jacket
  - Neon Blade Jacket
  - Inferno Jacket
  - Emerald Tech Jacket
  - Gold Trader Bomber
  - Arctic Alpha Jacket
- Added the same six jacket variants to the main `/dashboard/inventory` character builder using the builder's own base alignment.
- Fixed Forge layer ordering so BACK assets render behind the base character, while BODY/NECK/FACE/HEAD/HANDS/FEET/SPECIAL stack in the correct order.
- Fixed exported composite ordering to use the same z-order as the live preview.
- Updated Forge manifests to point to the corrected asset pool and include the new assets.

## Asset integrity

All new/normalized asset PNGs are 1024x1024 RGBA and preserve the base character coordinate system.


## Cowboy Collection — August 19, 2026

- Added 5 coordinated western/cowboy sets across all 8 slots: Desert Ranger, Midnight Outlaw, Nomad, Cardinal, and Raven.
- Added 40 new 1024x1024 RGBA assets (8 categories × 5 items).
- Repaired the remaining single-shoe FEET assets (`feet_020`, `feet_019`, `feet_024`, `feet_023`, `feet_021`, `feet_018`) into proper left/right pairs.
- All new cowboy assets use the same 1024x1024 character coordinate system and are registered in both Forge manifests.
