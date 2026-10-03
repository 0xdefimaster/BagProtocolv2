import type { Metadata } from "next";
// Fonts are bundled from npm (@fontsource-variable), not fetched from Google
// Fonts at build time: that fetch broke a production build when Google's
// response changed shape. The CSS variables are defined in globals.css.
import "@fontsource-variable/jost";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/components/ui/ThemeToggle";

export const metadata: Metadata = {
  title: "Bag Protocol — Programmable portfolios for onchain assets",
  description:
    "Choose a strategy, enter an amount, and Bag turns it into a complete portfolio. Strategies are published by creators, investable in one action, forkable with lineage, and pay royalties to the creators who started them. Ethereum, Arbitrum, Base and Robinhood Chain.",
  icons: { icon: "/logo.png", apple: "/logo.png" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: the boot script may set data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
