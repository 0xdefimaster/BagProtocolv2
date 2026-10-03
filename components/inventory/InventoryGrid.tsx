'use client';

import { AccessorySlot, ACCESSORY_SLOTS } from '@/types/domain';
import { OwnedAccessory } from '@/hooks/useInventory';

interface InventoryGridProps {
  bySlot: Record<AccessorySlot, OwnedAccessory[]>;
}

export function InventoryGrid({ bySlot }: InventoryGridProps) {
  return (
    <div className="inventory-grid">
      {ACCESSORY_SLOTS.map((slot) => {
        const items = bySlot[slot];
        return (
          <div key={slot} className={`inventory-slot-card ${items.length > 0 ? 'filled' : ''}`}>
            <div className="inventory-slot-label">{slot}</div>
            {items.length === 0 ? (
              <div className="inventory-empty-slot">
                <span style={{ fontSize: 20 }}>—</span>
                Empty
              </div>
            ) : (
              items.map((item) => (
                <div className="inventory-item-row" key={item.accessoryId}>
                  <span className="inventory-item-glyph">{item.image}</span>
                  <span className="inventory-item-name">{item.name}</span>
                  <span className="inventory-item-qty mono">×{item.quantity}</span>
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}
