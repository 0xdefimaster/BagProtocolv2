"use client";

import { EquippedState, SLOT_ORDER, Slot } from "@/types/character-builder";
import EquipmentSlot from "./EquipmentSlot";
import styles from "./builder.module.css";

interface EquipmentPanelProps {
  equipped: EquippedState;
  onSlotClick: (slot: Slot) => void;
}

export default function EquipmentPanel({ equipped, onSlotClick }: EquipmentPanelProps) {
  return (
    <div className={`${styles.glassPanel} rounded-3xl p-5 md:p-6 h-full`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold tracking-[0.25em] text-[#00FF66] uppercase">
          Equipment
        </h2>
        <span className="text-[10px] text-[#7fa892]">
          {Object.keys(equipped).length}/8 equipped
        </span>
      </div>

      <div className="space-y-2">
        {SLOT_ORDER.map((slot) => (
          <EquipmentSlot
            key={slot}
            slot={slot}
            item={equipped[slot]}
            onClick={() => onSlotClick(slot)}
          />
        ))}
      </div>
    </div>
  );
}
