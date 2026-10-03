import { Rarity, RARITY_COLOR } from "@/types/character-builder";

export default function RarityBadge({ rarity }: { rarity: Rarity }) {
  const color = RARITY_COLOR[rarity];
  return (
    <span
      className="text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full border"
      style={{
        color,
        borderColor: `${color}55`,
        backgroundColor: `${color}14`,
      }}
    >
      {rarity}
    </span>
  );
}
