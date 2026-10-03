// -----------------------------------------------------------------------------
// scripts/seed-input-assets.ts — registers a small, verified set of
// deposit-input assets in the Asset Registry (`assets` table), via the
// existing `registerAsset()` (lib/server/asset-repo.ts). Additive only —
// does not touch scripts/seed-bags.ts or anything it seeds.
//
// Why this exists: the Purchase Preview flow (Phase 12) restricts the
// "you pay" asset to the verified Asset Registry (never a hardcoded native
// equity ticker list — see PurchasePreviewModal's module doc). Nothing
// seeds that registry today, so without this script the registry is empty
// and the preview has nothing to offer as an input asset.
//
// Every address below is a well-established, independently-verifiable
// canonical identity — not a guess (same standard scripts/seed-bags.ts
// already holds itself to for why it does NOT hardcode a broader list):
//   ETH  -> this codebase's own NATIVE_ASSET_ADDRESS sentinel for a
//           chain's native gas asset (asset-identity.ts) — not a token,
//           needs no external verification.
//   USDC -> Circle's official Ethereum mainnet contract, cross-checked
//           against Circle's own docs (developers.circle.com/stablecoins/
//           usdc-contract-addresses) and Etherscan as of Aug 2026:
//           0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 6 decimals.
//
// Run with: npx tsx scripts/seed-input-assets.ts
// Requires the same env vars as any other server-side Supabase call
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — see .env.example).
// -----------------------------------------------------------------------------

import './load-env';
import { supabaseAdmin } from '@/lib/supabase/server';
import { registerAsset } from '@/lib/server/asset-repo';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';
import type { RegisterAssetInput } from '@/lib/server/asset-repo';

const INPUT_ASSETS: RegisterAssetInput[] = [
  { chain: 'ethereum', address: NATIVE_ASSET_ADDRESS, symbol: 'ETH', decimals: 18, name: 'Ether', assetType: 'crypto' },
  {
    chain: 'ethereum',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    assetType: 'crypto',
  },
];

async function main() {
  const admin = supabaseAdmin();
  let registered = 0;
  let alreadyPresent = 0;
  let failed = 0;

  for (const asset of INPUT_ASSETS) {
    const result = await registerAsset(admin, asset);
    if (result.ok) {
      registered += 1;
      console.log(`REGISTERED  ${asset.symbol} (${asset.chain}:${asset.address})`);
    } else if (result.error === 'DUPLICATE_ASSET') {
      alreadyPresent += 1;
      console.log(`ALREADY SET ${asset.symbol} (${asset.chain}:${asset.address})`);
    } else {
      failed += 1;
      console.error(`FAILED      ${asset.symbol}: ${result.message}`);
    }
  }

  console.log(`\n${registered} registered, ${alreadyPresent} already present, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
