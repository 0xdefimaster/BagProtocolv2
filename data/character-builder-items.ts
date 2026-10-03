import { BuilderItem } from "@/types/character-builder";

/**
 * Real, uploaded, aligned assets ported from the standalone BAG Character
 * Builder project. Every image below is pre-composited onto a 1024x1024
 * transparent canvas in the exact position it needs to sit on the BASE
 * CHARACTER, so CharacterCanvas can just stack images with inset-0.
 *
 * To add more items to a slot: drop a new 1024x1024 aligned PNG into
 * /public/assets/builder/items/<slot>/ and add an entry here. No code
 * changes needed.
 */
export const builderItems: BuilderItem[] = [
  {
    id: "head-green-cap",
    layer: 70,
    name: "Green BAG Cap",
    slot: "HEAD",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/head/green-cap.png",
    preview: "/assets/builder/previews/head/green-cap.png",
    description: "Classic low-profile cap with the BAG leaf embroidered on front.",
  },
  {
    id: "head-black-cap",
    layer: 70,
    name: "Black BAG Cap",
    slot: "HEAD",
    rarity: "COMMON",
    image: "/assets/builder/items/head/black-cap.png",
    description: "Blacked-out low-profile cap with a subtle leaf embroidery.",
  },
  {
    id: "head-red-cap",
    layer: 70,
    name: "Crimson BAG Cap",
    slot: "HEAD",
    rarity: "RARE",
    image: "/assets/builder/items/head/red-cap.png",
    description: "Deep red colorway of the classic BAG cap.",
  },
  {
    id: "head-gold-cap",
    layer: 70,
    name: "Gold BAG Cap",
    slot: "HEAD",
    rarity: "EPIC",
    image: "/assets/builder/items/head/gold-cap.png",
    description: "Amber-gold colorway of the classic BAG cap.",
  },
  {
    id: "face-digital-gold-glasses",
    layer: 60,
    name: "Digital Gold Glasses",
    slot: "FACE",
    rarity: "RARE",
    image: "/assets/builder/items/face/digital-gold-glasses.png",
    preview: "/assets/builder/previews/face/digital-gold-glasses.png",
    description: "Retro-futuristic black frames with glowing gold digital details.",
  },
  {
    id: "face-blue-cyber-goggles",
    layer: 60,
    name: "Blue Cyber Goggles",
    slot: "FACE",
    rarity: "EPIC",
    image: "/assets/builder/items/face/blue-cyber-goggles.png",
    preview: "/assets/builder/previews/face/blue-cyber-goggles.png",
    description: "High-tech blue illuminated visor with a cyber HUD.",
  },
  {
    id: "face-green-cyber-goggles",
    layer: 60,
    name: "Green Cyber Goggles",
    slot: "FACE",
    rarity: "EPIC",
    image: "/assets/builder/items/face/green-cyber-goggles.png",
    preview: "/assets/builder/previews/face/green-cyber-goggles.png",
    description: "Neon green tactical goggles with an electronic HUD.",
  },
  {
    id: "face-orange-visor-goggles",
    layer: 60,
    name: "Orange Solar Visor",
    slot: "FACE",
    rarity: "RARE",
    image: "/assets/builder/items/face/orange-visor-goggles.png",
    preview: "/assets/builder/previews/face/orange-visor-goggles.png",
    description: "Amber-orange futuristic visor with a bold protective frame.",
  },
  {
    id: "neck-emerald-chain",
    layer: 50,
    name: "Emerald Gold Chain",
    slot: "NECK",
    rarity: "RARE",
    image: "/assets/builder/items/neck/emerald-chain.png",
    preview: "/assets/builder/previews/neck/emerald-chain.png",
    description: "Cuban link chain with a pear-cut emerald pendant.",
  },
  {
    id: "neck-bitcoin-chain",
    layer: 50,
    name: "Bitcoin Gold Chain",
    slot: "NECK",
    rarity: "RARE",
    image: "/assets/builder/items/neck/bitcoin-chain.png",
    preview: "/assets/builder/previews/neck/bitcoin-chain.png",
    description: "Cuban link chain with a gold Bitcoin coin pendant.",
  },
  {
    id: "neck-ethereum-chain",
    layer: 50,
    name: "Ethereum Crystal Chain",
    slot: "NECK",
    rarity: "RARE",
    image: "/assets/builder/items/neck/ethereum-chain.png",
    preview: "/assets/builder/previews/neck/ethereum-chain.png",
    description: "Cuban link chain with a faceted crystal Ethereum pendant.",
  },
  {
    id: "neck-solana-chain",
    layer: 50,
    name: "Solana Gradient Chain",
    slot: "NECK",
    rarity: "RARE",
    image: "/assets/builder/items/neck/solana-chain.png",
    preview: "/assets/builder/previews/neck/solana-chain.png",
    description: "Cuban link chain with a purple-to-teal Solana medallion.",
  },
  {
    id: "body-bag-hoodie",
    layer: 40,
    name: "BAG Layer 2 Hoodie",
    slot: "BODY",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/body/bag-hoodie.png",
    description: "Built on Robinhood Layer 2 — the official BAG hoodie.",
  },
  {
    id: "body-void-tech-jacket",
    layer: 40,
    name: "Void Tech Jacket",
    slot: "BODY",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/body/void-tech-jacket.png",
    description: "Black techwear jacket with cyan reactive trim and BAG chest branding.",
  },
  { id: "hands-void-tech-gloves", layer: 80, name: "Void Tech Gloves", slot: "HANDS", rarity: "LEGENDARY", image: "/assets/builder/items/hands/void-tech-gloves-left.png", image2: "/assets/builder/items/hands/void-tech-gloves-right.png", description: "Cyan reactive tech gloves matched to the Void Tech Jacket." },
  { id: "feet-void-tech-sneakers", layer: 90, name: "Void Tech Sneakers", slot: "FEET", rarity: "LEGENDARY", image: "/assets/builder/items/feet/void-tech-sneakers.png", description: "Black/cyan tech sneakers matched to the Void Tech Jacket." },

  {
    id: "body-neon-blade-jacket",
    layer: 40,
    name: "Neon Blade Jacket",
    slot: "BODY",
    rarity: "EPIC",
    image: "/assets/builder/items/body/neon-blade-jacket.png",
    description: "Deep violet cyber jacket with magenta energy piping.",
  },
  { id: "hands-neon-blade-gloves", layer: 80, name: "Neon Blade Gloves", slot: "HANDS", rarity: "EPIC", image: "/assets/builder/items/hands/neon-blade-gloves-left.png", image2: "/assets/builder/items/hands/neon-blade-gloves-right.png", description: "Magenta energy gloves matched to the Neon Blade Jacket." },
  { id: "feet-neon-blade-boots", layer: 90, name: "Neon Blade Boots", slot: "FEET", rarity: "EPIC", image: "/assets/builder/items/feet/neon-blade-boots.png", description: "Purple cyber boots matched to the Neon Blade Jacket." },

  {
    id: "body-inferno-jacket",
    layer: 40,
    name: "Inferno Jacket",
    slot: "BODY",
    rarity: "EPIC",
    image: "/assets/builder/items/body/inferno-jacket.png",
    description: "Crimson tactical jacket with ember-red and gold accents.",
  },
  { id: "hands-inferno-gauntlets", layer: 80, name: "Inferno Gauntlets", slot: "HANDS", rarity: "EPIC", image: "/assets/builder/items/hands/inferno-gauntlets-left.png", image2: "/assets/builder/items/hands/inferno-gauntlets-right.png", description: "Crimson tactical gauntlets matched to the Inferno Jacket." },
  { id: "feet-inferno-runners", layer: 90, name: "Inferno Runners", slot: "FEET", rarity: "EPIC", image: "/assets/builder/items/feet/inferno-runners.png", description: "Black/red runners matched to the Inferno Jacket." },

  {
    id: "body-emerald-tech-jacket",
    layer: 40,
    name: "Emerald Tech Jacket",
    slot: "BODY",
    rarity: "EPIC",
    image: "/assets/builder/items/body/emerald-tech-jacket.png",
    description: "Deep emerald tech jacket with neon green energy seams.",
  },
  { id: "hands-emerald-tech-gloves", layer: 80, name: "Emerald Tech Gloves", slot: "HANDS", rarity: "EPIC", image: "/assets/builder/items/hands/emerald-tech-gloves-left.png", image2: "/assets/builder/items/hands/emerald-tech-gloves-right.png", description: "Emerald reactive gloves matched to the Emerald Tech Jacket." },
  { id: "feet-emerald-tech-sneakers", layer: 90, name: "Emerald Tech Sneakers", slot: "FEET", rarity: "EPIC", image: "/assets/builder/items/feet/emerald-tech-sneakers.png", description: "Green reactive sneakers matched to the Emerald Tech Jacket." },

  {
    id: "body-gold-trader-bomber",
    layer: 40,
    name: "Gold Trader Bomber",
    slot: "BODY",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/body/gold-trader-bomber.png",
    description: "Luxury black-and-gold bomber built for the BAG trader aesthetic.",
  },
  { id: "hands-gold-trader-gloves", layer: 80, name: "Gold Trader Gloves", slot: "HANDS", rarity: "LEGENDARY", image: "/assets/builder/items/hands/gold-trader-gloves-left.png", image2: "/assets/builder/items/hands/gold-trader-gloves-right.png", description: "Black and gold gloves matched to the Gold Trader Bomber." },
  { id: "feet-gold-trader-lows", layer: 90, name: "Gold Trader Lows", slot: "FEET", rarity: "LEGENDARY", image: "/assets/builder/items/feet/gold-trader-lows.png", description: "Luxury gold-accented lows matched to the Gold Trader Bomber." },

  {
    id: "body-arctic-alpha-jacket",
    layer: 40,
    name: "Arctic Alpha Jacket",
    slot: "BODY",
    rarity: "RARE",
    image: "/assets/builder/items/body/arctic-alpha-jacket.png",
    description: "White tactical jacket with icy cyan detailing.",
  },
  { id: "hands-arctic-alpha-gloves", layer: 80, name: "Arctic Alpha Gloves", slot: "HANDS", rarity: "RARE", image: "/assets/builder/items/hands/arctic-alpha-gloves-left.png", image2: "/assets/builder/items/hands/arctic-alpha-gloves-right.png", description: "Ice-blue tactical gloves matched to the Arctic Alpha Jacket." },
  { id: "feet-arctic-alpha-sneakers", layer: 90, name: "Arctic Alpha Sneakers", slot: "FEET", rarity: "RARE", image: "/assets/builder/items/feet/arctic-alpha-sneakers.png", description: "Black/cyan sneakers matched to the Arctic Alpha Jacket." },

  {
    id: "back-golden-wings",
    layer: 20,
    name: "Golden Wings",
    slot: "BACK",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/back/golden-wings.png",
    description: "A pair of radiant gold wings, fully spread.",
  },
  {
    id: "hands-bag-gloves",
    layer: 80,
    name: "BAG Gloves",
    slot: "HANDS",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/hands/glove-left.png",
    image2: "/assets/builder/items/hands/glove-right.png",
    description: "Tactical green/gold gloves, one for each hand.",
  },
  {
    id: "feet-bag-sneakers",
    layer: 90,
    name: "BAG Sneakers",
    slot: "FEET",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/feet/bag-sneakers.png",
    description: "Green/white high-tops with the BAG leaf on the tongue.",
  },
  {
    id: "special-green-aura",
    layer: 10,
    name: "Green Energy Aura",
    slot: "SPECIAL",
    rarity: "EPIC",
    image: "/assets/builder/items/special/green-aura.png",
    description: "A swirling green energy field radiating from the ground up.",
  },
  // Additional wing variants
  {
    id: "back-metal-wings",
    layer: 20,
    name: "Metal Wings",
    slot: "BACK",
    rarity: "RARE",
    image: "/assets/builder/items/back/metal.png",
    preview: "/assets/builder/previews/back/metal.png",
    description: "Large dark metallic feathered wings.",
  },
  {
    id: "back-emerald-wings",
    layer: 20,
    name: "Emerald Wings",
    slot: "BACK",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/back/emerald.png",
    preview: "/assets/builder/previews/back/emerald.png",
    description: "Green feathered wings with ornate emerald accents.",
  },
  {
    id: "back-demonic-wings",
    layer: 20,
    name: "Demonic Wings",
    slot: "BACK",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/back/demonic.png",
    preview: "/assets/builder/previews/back/demonic.png",
    description: "Dark demonic wings with red distressed detailing.",
  },
  // Additional glove variants
  {
    id: "hands-skeleton-gloves",
    layer: 80,
    name: "Skeleton Gloves",
    slot: "HANDS",
    rarity: "RARE",
    image: "/assets/builder/items/hands/skeleton.png",
    preview: "/assets/builder/previews/hands/skeleton.png",
    description: "Bone-plated gloves with articulated skeletal fingers.",
  },
  {
    id: "hands-red-skeleton-gloves",
    layer: 80,
    name: "Red Skeleton Gloves",
    slot: "HANDS",
    rarity: "EPIC",
    image: "/assets/builder/items/hands/red-skeleton.png",
    preview: "/assets/builder/previews/hands/red-skeleton.png",
    description: "Red armored gloves with skeletal finger plating.",
  },

  // ---------------------------------------------------------------------
  // Additional HEAD (cap) colorways. Each is a recolor of the same aligned
  // cap silhouette (see black-cap.png), so alpha/positioning is byte-for-byte
  // identical to the originals — guaranteed to sit correctly on the head.
  // ---------------------------------------------------------------------
  {
    id: "head-navy-cap",
    layer: 70,
    name: "Navy BAG Cap",
    slot: "HEAD",
    rarity: "COMMON",
    image: "/assets/builder/items/head/navy-cap.png",
    description: "Deep navy colorway of the classic BAG cap.",
  },
  {
    id: "head-white-cap",
    layer: 70,
    name: "Snow White BAG Cap",
    slot: "HEAD",
    rarity: "COMMON",
    image: "/assets/builder/items/head/white-cap.png",
    description: "Clean off-white colorway of the classic BAG cap.",
  },
  {
    id: "head-purple-cap",
    layer: 70,
    name: "Violet BAG Cap",
    slot: "HEAD",
    rarity: "RARE",
    image: "/assets/builder/items/head/purple-cap.png",
    description: "Rich violet colorway of the classic BAG cap.",
  },
  {
    id: "head-pink-cap",
    layer: 70,
    name: "Blush BAG Cap",
    slot: "HEAD",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/head/pink-cap.png",
    description: "Soft blush-pink colorway of the classic BAG cap.",
  },
  {
    id: "head-cyan-cap",
    layer: 70,
    name: "Cyan Volt Cap",
    slot: "HEAD",
    rarity: "RARE",
    image: "/assets/builder/items/head/cyan-cap.png",
    description: "Electric cyan colorway of the classic BAG cap.",
  },
  {
    id: "head-orange-cap",
    layer: 70,
    name: "Ember BAG Cap",
    slot: "HEAD",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/head/orange-cap.png",
    description: "Warm ember-orange colorway of the classic BAG cap.",
  },
  {
    id: "head-diamond-cap",
    layer: 70,
    name: "Diamond BAG Cap",
    slot: "HEAD",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/head/diamond-cap.png",
    description: "Icy diamond-white colorway with a frosted shimmer finish.",
  },

  // ---------------------------------------------------------------------
  // New HEAD silhouettes (non-cap). Each is aligned to the same head
  // anchor box as the caps above (x≈325..678, head top≈y20-60) so it sits
  // flush on the base character with no manual offset needed.
  // ---------------------------------------------------------------------
  {
    id: "head-cowboy-hat",
    layer: 70,
    name: "Cowboy Hat",
    slot: "HEAD",
    rarity: "RARE",
    image: "/assets/builder/items/head/cowboy-hat.png",
    description: "Wide-brimmed felt cowboy hat with a leather band and gold buckle.",
  },
  {
    id: "head-beanie",
    layer: 70,
    name: "Knit Beanie",
    slot: "HEAD",
    rarity: "COMMON",
    image: "/assets/builder/items/head/beanie.png",
    description: "Cozy ribbed knit beanie with a folded cuff and a fuzzy pom-pom.",
  },
  {
    id: "head-crown",
    layer: 70,
    name: "Royal Crown",
    slot: "HEAD",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/head/crown.png",
    description: "Gold five-point crown set with ruby, sapphire and emerald gems.",
  },

  // ---------------------------------------------------------------------
  // Additional BODY (jacket) colorways. Each is a recolor of the same
  // aligned hoodie silhouette (see bag-hoodie.png), so alpha/positioning is
  // byte-for-byte identical to the originals — guaranteed to sit correctly
  // on the torso.
  // ---------------------------------------------------------------------
  {
    id: "body-royal-purple-jacket",
    layer: 40,
    name: "Royal Purple Jacket",
    slot: "BODY",
    rarity: "EPIC",
    image: "/assets/builder/items/body/royal-purple-jacket.png",
    description: "Deep royal-purple colorway of the BAG hoodie.",
  },
  {
    id: "body-crimson-racer-jacket",
    layer: 40,
    name: "Crimson Racer Jacket",
    slot: "BODY",
    rarity: "RARE",
    image: "/assets/builder/items/body/crimson-racer-jacket.png",
    description: "Bold crimson-red colorway of the BAG hoodie.",
  },
  {
    id: "body-obsidian-jacket",
    layer: 40,
    name: "Obsidian Jacket",
    slot: "BODY",
    rarity: "LEGENDARY",
    image: "/assets/builder/items/body/obsidian-jacket.png",
    description: "Matte near-black colorway of the BAG hoodie with a graphite sheen.",
  },
  {
    id: "body-sunrise-jacket",
    layer: 40,
    name: "Sunrise Jacket",
    slot: "BODY",
    rarity: "UNCOMMON",
    image: "/assets/builder/items/body/sunrise-jacket.png",
    description: "Warm amber-to-gold colorway of the BAG hoodie.",
  },
  {
    id: "body-glacier-jacket",
    layer: 40,
    name: "Glacier Jacket",
    slot: "BODY",
    rarity: "RARE",
    image: "/assets/builder/items/body/glacier-jacket.png",
    description: "Cool teal-to-ice colorway of the BAG hoodie.",
  },
];

export const builderItemsBySlot = builderItems.reduce<Record<string, BuilderItem[]>>(
  (acc, item) => {
    acc[item.slot] = acc[item.slot] || [];
    acc[item.slot].push(item);
    return acc;
  },
  {}
);
