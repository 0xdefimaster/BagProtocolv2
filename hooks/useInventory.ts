'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccessorySlot, ACCESSORY_SLOTS, InventoryItem, Rarity } from '@/types/domain';
import { getAccessoryById } from '@/data/mock-accessories';
import { useCurrentUserId } from './useCurrentUserId';

// -----------------------------------------------------------------------------
// Phase 18 — server-enforced inventory read. Previously read
// lib/services/inventory-service.ts's localStorage `inventory` collection,
// which nothing populated once box-opening moved server-side (see
// useBoxes.ts's doc comment) — inventory would always read empty. Now reads
// `/api/inventory`, backed by lib/server/box-repo.ts's listInventoryForUser().
// `lib/services/inventory-service.ts` no longer exists in this repo at all
// (removed after the migration above completed). NFT assembly's
// accessory-consumption flow has SINCE also been migrated —
// app/api/nfts/assemble/route.ts calls lib/server/nft-repo.ts's
// assembleBagNftForUser(), which is Supabase/RPC-backed
// (supabase/migrations/0010_add_assemble_bag_nft.sql), not localStorage.
// -----------------------------------------------------------------------------

export interface OwnedAccessory extends InventoryItem {
  name: string;
  slot: AccessorySlot;
  rarity: Rarity;
  image: string;
}

export function useInventory() {
  const { userId, isAuthenticated } = useCurrentUserId();
  const [items, setItems] = useState<InventoryItem[]>([]);

  const refresh = useCallback(() => {
    if (!isAuthenticated) {
      setItems([]);
      return;
    }
    fetch('/api/inventory')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { items: InventoryItem[] } | null) => {
        if (data) setItems(data.items);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const owned: OwnedAccessory[] = useMemo(
    () =>
      items
        .map((item: InventoryItem) => {
          const accessory = getAccessoryById(item.accessoryId);
          if (!accessory) return null;
          return { ...item, name: accessory.name, slot: accessory.slot, rarity: accessory.rarity, image: accessory.image };
        })
        .filter((x: OwnedAccessory | null): x is OwnedAccessory => x !== null),
    [items]
  );

  const bySlot: Record<AccessorySlot, OwnedAccessory[]> = useMemo(() => {
    const grouped = {} as Record<AccessorySlot, OwnedAccessory[]>;
    for (const slot of ACCESSORY_SLOTS) grouped[slot] = owned.filter((o) => o.slot === slot);
    return grouped;
  }, [owned]);

  const completedSlotCount = ACCESSORY_SLOTS.filter((slot) => bySlot[slot].length > 0).length;
  const canAssembleAny = completedSlotCount === ACCESSORY_SLOTS.length;

  return { userId, owned, bySlot, completedSlotCount, canAssembleAny, refresh };
}
