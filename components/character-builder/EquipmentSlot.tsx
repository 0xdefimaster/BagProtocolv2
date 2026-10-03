"use client";

import { BuilderItem, Slot, SLOT_LABEL } from "@/types/character-builder";
import RarityBadge from "./RarityBadge";

interface EquipmentSlotProps {
  slot: Slot;
  item?: BuilderItem;
  onClick: () => void;
}

export default function EquipmentSlot({ slot, item, onClick }: EquipmentSlotProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all group ${
        item
          ? "border-[#16A34A]/50 bg-[#0d281a]/60 hover:border-[#00FF66]"
          : "border-dashed border-[#123822] bg-black/20 hover:border-[#16A34A] hover:bg-[#0d281a]/40"
      }`}
    >
      <div className="w-12 h-12 rounded-lg bg-black/40 border border-[#123822] shrink-0 relative overflow-hidden flex items-center justify-center">
        {item ? (
          <img
            src={item.image}
            alt={item.name}
            className="absolute inset-0 w-full h-full object-contain p-1"
          />
        ) : (
          <span className="text-[#7fa892] text-lg">+</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-[0.2em] text-[#7fa892]">
          {SLOT_LABEL[slot]}
        </p>
        {item ? (
          <p className="text-sm font-medium truncate">{item.name}</p>
        ) : (
          <p className="text-sm text-[#7fa892]">Empty</p>
        )}
      </div>

      <div className="flex flex-col items-end gap-1 shrink-0">
        {item && <RarityBadge rarity={item.rarity} />}
        <span className="text-[10px] font-semibold text-[#00FF66] opacity-0 group-hover:opacity-100 transition-opacity">
          {item ? "CHANGE" : "EQUIP"}
        </span>
      </div>
    </button>
  );
}
