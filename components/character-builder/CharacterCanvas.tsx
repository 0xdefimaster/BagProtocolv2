"use client";

import {
  EquippedState,
  RENDER_ORDER,
  RARITY_COLOR,
  SLOT_Z,
  BASE_CHARACTER_Z,
} from "@/types/character-builder";

interface CharacterCanvasProps {
  equipped: EquippedState;
  debug?: boolean;
}

/**
 * DO NOT CHANGE the layering / positioning logic in this file.
 *
 * Every asset (base + every item) is a pre-aligned 1024x1024 transparent PNG
 * on the exact same coordinate grid, so every layer is simply stacked with
 * `absolute inset-0 w-full h-full object-contain` — no per-item offsets, no
 * per-item scaling. That is what keeps items pinned exactly onto the base
 * character. This file is a verbatim port of the verified working
 * character-builder canvas — if an item ever looks misaligned, fix the PNG
 * (regenerate it on the same 1024x1024 canvas), never this component.
 */
export default function CharacterCanvas({
  equipped,
  debug,
}: CharacterCanvasProps) {
  /*
   * BODY önce çizilir.
   * NECK en son çizilir.
   *
   * Böylece kolye zinciri + kolye ucu
   * hoodie'nin DAİMA üzerinde kalır.
   */

  const normalSlots = RENDER_ORDER.filter(
    (slot) => slot !== "NECK"
  );

  const neckItem = equipped["NECK"];

  const renderItem = (
    slot: keyof EquippedState,
    index: number,
    forcedZ?: number
  ) => {
    const item = equipped[slot];

    if (!item) return null;

    let zIndex = forcedZ ?? item.layer ?? SLOT_Z[slot];

    /*
     * Katman sıralaması
     */

    if (slot === "BACK") {
      zIndex = 20;
    }

    if (slot === "BODY") {
      zIndex = 40;
    }

    if (slot === "HEAD") {
      zIndex = 70;
    }

    if (slot === "FACE") {
      zIndex = 80;
    }

    if (slot === "HANDS") {
      zIndex = 90;
    }

    if (slot === "FEET") {
      zIndex = 90;
    }

    /*
     * NECK için çok yüksek z-index.
     *
     * Hoodie, göğüs yazısı, yaprak vb.
     * hiçbir şey kolyenin üzerine gelemez.
     */

    if (slot === "NECK") {
      zIndex = 500;
    }

    return (
      <div
        key={`${slot}-${item.id}`}
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex,
        }}
      >
        <img
          src={item.image}
          alt={item.name}
          className="absolute inset-0 w-full h-full object-contain"
          draggable={false}
        />

        {item.image2 && (
          <img
            src={item.image2}
            alt={`${item.name} secondary`}
            className="absolute inset-0 w-full h-full object-contain"
            draggable={false}
          />
        )}

        {debug && (
          <div
            className="absolute top-2 left-2 text-[10px] font-mono px-2 py-1 rounded bg-black/70 border"
            style={{
              zIndex: 9999,
              borderColor: RARITY_COLOR[item.rarity],
              color: RARITY_COLOR[item.rarity],
              transform: `translateY(${index * 18}px)`,
            }}
          >
            {slot} · z{zIndex} · {item.name}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="relative w-full aspect-square select-none"
      style={{
        isolation: "isolate",
      }}
    >
      {/* =====================================================
          BASE
          ===================================================== */}

      <img
        src="/assets/builder/base/bag-base.png"
        alt="BAG base character"
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        draggable={false}
        style={{
          zIndex: BASE_CHARACTER_Z,
        }}
      />

      {/* =====================================================
          NORMAL ITEMS
          ===================================================== */}

      {normalSlots.map((slot, index) =>
        renderItem(slot, index)
      )}

      {/* =====================================================
          NECK / CHAIN
          
          BİLEREK EN SON RENDER EDİLİYOR
          ===================================================== */}

      {neckItem &&
        renderItem(
          "NECK",
          normalSlots.length + 1,
          500
        )}
    </div>
  );
}
