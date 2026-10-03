'use client';

import { useState } from 'react';
import { useBagNFTs } from '@/hooks/useBagNFTs';
import { useInventory } from '@/hooks/useInventory';
import { NFTCard } from '@/components/nft/NFTCard';
import { InventoryGrid } from '@/components/inventory/InventoryGrid';
import BagCharacterBuilder from '@/components/character-builder/BagCharacterBuilder';
import { ACCESSORY_SLOTS, AccessorySlot } from '@/types/domain';

export default function InventoryPage() {
  const { nfts, assemble } = useBagNFTs();
  const { bySlot, canAssembleAny, refresh: refreshInventory } = useInventory();
  const [minting, setMinting] = useState(false);
  const [mintMessage, setMintMessage] = useState<string | null>(null);
  const [builderNote, setBuilderNote] = useState<string | null>(null);

  const handleBuild = () => {
    // The Character Builder's catalog (data/character-builder-items.ts) is a
    // free cosmetic preview — it isn't tied to the owned-accessory economy
    // (data/mock-accessories.ts + inventory), so it can't mint a real BAG
    // NFT on its own without letting anyone mint accessories they never
    // earned from a box. Minting below uses your REAL owned accessories.
    setBuilderNote('This is a live preview. To mint a real BAG NFT, use your owned accessories below.');
  };

  const handleMint = async () => {
    setMinting(true);
    setMintMessage(null);
    const selection: Partial<Record<AccessorySlot, string>> = {};
    for (const slot of ACCESSORY_SLOTS) {
      const first = bySlot[slot]?.[0];
      if (first) selection[slot] = first.accessoryId;
    }
    const result = await assemble(selection);
    setMinting(false);
    if (result.ok) {
      setMintMessage(`Minted a ${result.nft?.rarity} BAG NFT!`);
      refreshInventory();
    } else {
      setMintMessage(result.error ?? 'Could not mint — please try again.');
    }
  };

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <span className="eyebrow">
          <span className="dot" />
          Collectibles
        </span>
        <h1 style={{ marginTop: 16 }}>Inventory</h1>
        <p className="lead">
          Equip any accessory to any slot and preview your BAG character live before you build it.
        </p>
      </div>

      <div style={{ marginTop: 36 }}>
        <div
          style={{
            background: '#04140c',
            borderRadius: 24,
            padding: 1,
          }}
        >
          <BagCharacterBuilder onBuild={handleBuild} />
        </div>
        {builderNote && (
          <p className="lead" style={{ marginTop: 12, fontSize: 13 }}>
            {builderNote}
          </p>
        )}
      </div>

      <div style={{ marginTop: 44 }}>
        <span className="section-label">Your Accessories</span>
        <p className="lead" style={{ marginTop: 6, fontSize: 13 }}>
          Earned from opening boxes. Mint consumes one accessory per slot — the same rules the box loop
          already enforces server-side.
        </p>
        <div style={{ marginTop: 14 }}>
          <InventoryGrid bySlot={bySlot} />
        </div>
        <button
          className="btn btn-primary"
          style={{ marginTop: 18 }}
          disabled={!canAssembleAny || minting}
          onClick={handleMint}
        >
          {minting ? 'Minting…' : 'Mint BAG NFT'}
        </button>
        {mintMessage && (
          <p className="lead" style={{ marginTop: 10, fontSize: 13 }}>
            {mintMessage}
          </p>
        )}
      </div>

      {nfts.length > 0 && (
        <div style={{ marginTop: 44 }}>
          <span className="section-label">My BAG NFTs</span>
          <div className="nft-grid" style={{ marginTop: 14 }}>
            {nfts.map((nft) => (
              <NFTCard key={nft.id} nft={nft} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
