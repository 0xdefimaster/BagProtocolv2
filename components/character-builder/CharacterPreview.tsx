"use client";

import CharacterCanvas from "./CharacterCanvas";
import { EquippedState } from "@/types/character-builder";
import styles from "./builder.module.css";

interface CharacterPreviewProps {
  equipped: EquippedState;
  debug: boolean;
  onToggleDebug: () => void;
}

export default function CharacterPreview({
  equipped,
  debug,
  onToggleDebug,
}: CharacterPreviewProps) {
  return (
    <div className={`relative ${styles.glassPanel} ${styles.grainBg} rounded-3xl p-6 md:p-10 flex flex-col items-center justify-center h-full min-h-[420px]`}>
      <button
        onClick={onToggleDebug}
        className={`absolute top-4 right-4 text-[10px] font-mono px-3 py-1.5 rounded-full border transition-colors ${
          debug
            ? "border-[#00FF66] text-[#00FF66] bg-[#00FF66]/10"
            : "border-[#123822] text-[#7fa892] hover:text-white hover:border-[#16A34A]"
        }`}
      >
        DEBUG MODE {debug ? "ON" : "OFF"}
      </button>

      <div className={`absolute inset-0 rounded-3xl ${styles.radialGlow} pointer-events-none`} />

      <div className={`relative w-full max-w-[560px] ${styles.floaty}`}>
        <div
          className="absolute inset-0 rounded-full blur-3xl opacity-30"
          style={{ background: "radial-gradient(circle, #00FF66, transparent 65%)" }}
        />
        <CharacterCanvas equipped={equipped} debug={debug} />
      </div>

      <p className="relative mt-6 text-xs uppercase tracking-[0.3em] text-[#7fa892]">
        Character Preview
      </p>
    </div>
  );
}
