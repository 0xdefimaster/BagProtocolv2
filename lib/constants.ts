export const NAV_LINKS = [
  { href: "/dashboard/explore", label: "Explore" },
  { href: "/dashboard/create", label: "Create" },
  { href: "#creatorfi", label: "CreatorFi" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#protocol", label: "Protocol" },
  { href: "#roadmap", label: "Roadmap" },
] as const;

// Public project links shown in the footer. Left empty on purpose: set them to
// the real URLs; an empty entry is not rendered (never a guessed handle).
export const SOCIAL_LINKS: { label: string; href: string }[] = [
  { label: "Docs", href: "" },
  { label: "GitHub", href: "" },
  { label: "X", href: "" },
];

// Internal dashboard entry point (the "Launch App" / "Launch Protocol" CTA).
export const APP_URL = "/dashboard";

export interface NetworkOption {
  id: string;
  label: string;
  color: string;
  glyph: string;
}

// Deployment targets selectable when publishing a Bag.
export const NETWORKS: NetworkOption[] = [
  { id: "ethereum", label: "Ethereum", color: "#627EEA", glyph: "Ξ" },
  { id: "base", label: "Base", color: "#0052FF", glyph: "🔵" },
  { id: "arbitrum", label: "Arbitrum", color: "#28A0F0", glyph: "🔷" },
  { id: "robinhood", label: "Robinhood Chain", color: "#00C805", glyph: "🪶" },
];
