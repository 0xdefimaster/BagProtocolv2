"use client";

import { useMemo, useState } from "react";
import EquipmentPanel from "./EquipmentPanel";
import CharacterPreview from "./CharacterPreview";
import ItemSelector from "./ItemSelector";
import RarityBadge from "./RarityBadge";
import styles from "./builder.module.css";
import { builderItemsBySlot } from "@/data/character-builder-items";
import {
  BuilderItem,
  EquippedState,
  RARITY_SCORE,
  Slot,
  SLOT_LABEL,
  SLOT_ORDER,
} from "@/types/character-builder";

function randomFrom<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

interface BagCharacterBuilderProps {
  /** Called when the player hits BUILD BAG with all state needed to mint/save. */
  onBuild?: (equipped: EquippedState) => void;
}

export default function BagCharacterBuilder({ onBuild }: BagCharacterBuilderProps) {
  const [equipped, setEquipped] = useState<EquippedState>({});
  const [activeSlot, setActiveSlot] = useState<Slot | null>(null);
  const [debug, setDebug] = useState(false);
  const [buildMessage, setBuildMessage] = useState<string | null>(null);

  const rarityScore = useMemo(() => {
    const values = Object.values(equipped) as BuilderItem[];
    if (values.length === 0) return 0;
    const total = values.reduce((sum, it) => sum + RARITY_SCORE[it.rarity], 0);
    return Math.round(total / values.length);
  }, [equipped]);

  function equip(item: BuilderItem) {
    setEquipped((prev) => ({ ...prev, [item.slot]: item }));
    setActiveSlot(null);
  }

  function unequip(slot: Slot) {
    setEquipped((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });
    setActiveSlot(null);
  }

  function handleReset() {
    setEquipped({});
    setBuildMessage(null);
  }

  function handleRandomize() {
    const next: EquippedState = {};
    for (const slot of SLOT_ORDER) {
      const pool = builderItemsBySlot[slot] || [];
      const pick = randomFrom(pool);
      if (pick) next[slot] = pick;
    }
    setEquipped(next);
    setBuildMessage(null);
  }

  function handleBuild() {
    onBuild?.(equipped);
    setBuildMessage("Character configuration generated.");
    setTimeout(() => setBuildMessage(null), 3500);
  }

  return (
    <div className={`${styles.glassPanel} rounded-3xl overflow-hidden`}>
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5 p-5 md:p-8">
        {/* Desktop: equipment left. Mobile: preview shown first via order utilities */}
        <div className="order-2 lg:order-1">
          <EquipmentPanel equipped={equipped} onSlotClick={setActiveSlot} />
        </div>

        <div className="order-1 lg:order-2">
          <CharacterPreview
            equipped={equipped}
            debug={debug}
            onToggleDebug={() => setDebug((d) => !d)}
          />
        </div>
      </div>

      {/* BOTTOM: equipped summary + actions */}
      <div className="px-5 md:px-8 pb-8">
        <div className={`${styles.glassPanel} rounded-3xl p-5 md:p-6`}>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
            <h2 className="text-sm font-semibold tracking-[0.25em] text-[#00FF66] uppercase">
              Equipped
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-[#7fa892]">
                Rarity Score
              </span>
              <span className="text-lg font-bold text-[#00FF66]">
                {rarityScore}
                <span className="text-xs text-[#7fa892]"> / 100</span>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
            {SLOT_ORDER.map((slot) => {
              const item = equipped[slot];
              return (
                <div
                  key={slot}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[#123822] bg-black/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-[#7fa892]">
                      {SLOT_LABEL[slot]}
                    </p>
                    <p className="text-xs font-medium truncate">
                      {item ? item.name : "—"}
                    </p>
                  </div>
                  {item && <RarityBadge rarity={item.rarity} />}
                </div>
              );
            })}
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleReset}
              className="flex-1 py-3 rounded-xl border border-[#123822] text-sm font-semibold text-[#7fa892] hover:text-white hover:border-white/30 transition-colors"
            >
              RESET
            </button>
            <button
              onClick={handleRandomize}
              className="flex-1 py-3 rounded-xl border border-[#16A34A] text-sm font-semibold text-[#16A34A] hover:bg-[#16A34A]/10 transition-colors"
            >
              RANDOMIZE
            </button>
            <button
              onClick={handleBuild}
              className={`flex-1 py-3 rounded-xl bg-[#00FF66] text-[#04140c] text-sm font-bold ${styles.shadowGlowSm} transition-shadow`}
            >
              BUILD BAG
            </button>
          </div>

          {buildMessage && (
            <p className={`mt-4 text-center text-sm text-[#00FF66] ${styles.pulseGlow}`}>
              {buildMessage}
            </p>
          )}
        </div>
      </div>

      {activeSlot && (
        <ItemSelector
          slot={activeSlot}
          items={builderItemsBySlot[activeSlot] || []}
          equippedId={equipped[activeSlot]?.id}
          onSelect={equip}
          onUnequip={() => unequip(activeSlot)}
          onClose={() => setActiveSlot(null)}
        />
      )}
    </div>
  );
}
