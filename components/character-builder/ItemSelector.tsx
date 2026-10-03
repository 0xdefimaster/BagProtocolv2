"use client";

import { BuilderItem, Slot, SLOT_LABEL } from "@/types/character-builder";
import RarityBadge from "./RarityBadge";
import styles from "./builder.module.css";

interface ItemSelectorProps {
  slot: Slot;
  items: BuilderItem[];
  equippedId?: string;
  onSelect: (item: BuilderItem) => void;
  onUnequip: () => void;
  onClose: () => void;
}

export default function ItemSelector({
  slot,
  items,
  equippedId,
  onSelect,
  onUnequip,
  onClose,
}: ItemSelectorProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-sm ${styles.glassPanel} ${styles.shadowGlow} rounded-2xl border border-[#123822] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#123822]">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-[#7fa892]">
              {SLOT_LABEL[slot]} slot
            </p>
            <h3 className="font-semibold">Choose an item</h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full border border-[#123822] text-[#7fa892] hover:text-white hover:border-[#16A34A] flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        <div className={`max-h-[60vh] overflow-y-auto ${styles.scrollThin} px-3 py-3 space-y-2`}>
          {items.length === 0 && (
            <p className="text-sm text-[#7fa892] px-2 py-6 text-center">
              No items available for this slot yet.
            </p>
          )}

          {items.map((item) => {
            const active = item.id === equippedId;
            return (
              <button
                key={item.id}
                onClick={() => onSelect(item)}
                className={`w-full flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                  active
                    ? "border-[#00FF66] bg-[#00FF66]/10"
                    : "border-[#123822] bg-black/20 hover:border-[#16A34A] hover:bg-[#0d281a]"
                }`}
              >
                <div className="w-14 h-14 rounded-lg bg-black/40 border border-[#123822] shrink-0 relative overflow-hidden">
                  <img
                    src={item.preview || item.image}
                    alt={item.name}
                    className="absolute inset-0 w-full h-full object-contain p-1"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-[#7fa892] truncate">{item.description}</p>
                </div>
                <RarityBadge rarity={item.rarity} />
              </button>
            );
          })}
        </div>

        {equippedId && (
          <div className="px-5 py-3 border-t border-[#123822]">
            <button
              onClick={onUnequip}
              className="w-full text-xs font-medium text-red-300/80 hover:text-red-300 py-2 rounded-lg border border-red-500/20 hover:border-red-500/40 transition-colors"
            >
              Unequip {SLOT_LABEL[slot]}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
