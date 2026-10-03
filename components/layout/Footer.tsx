import Image from "next/image";
import Link from "next/link";
import { APP_URL, SOCIAL_LINKS } from "@/lib/constants";

// Every in-page link targets a section id that exists on the homepage
// (asserted by app/__tests__/landing-a11y.test.tsx).
export const FOOTER_SECTION_LINKS = [
  { href: "#creatorfi", label: "CreatorFi" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#networks", label: "Networks" },
  { href: "#spec", label: "Open format" },
  { href: "#architecture", label: "Architecture" },
  { href: "#roadmap", label: "Status" },
] as const;

export default function Footer() {
  const social = SOCIAL_LINKS.filter((l) => l.href);
  return (
    <footer>
      <div className="wrap foot-grid">
        <div className="foot-brand">
          <Image src="/logo.png" alt="" width={28} height={28} />
          <div>
            <span className="foot-name">Bag Protocol</span>
            <span className="foot-mono">An open strategy layer for programmable portfolios.</span>
          </div>
        </div>
        <nav className="foot-cols" aria-label="Footer">
          <div className="foot-col">
            <span className="foot-head mono">Product</span>
            <Link href="/dashboard/explore">Explore Bags</Link>
            <Link href="/dashboard/create">Create a Bag</Link>
            <Link href={APP_URL}>Launch App</Link>
          </div>
          <div className="foot-col">
            <span className="foot-head mono">Protocol</span>
            {FOOTER_SECTION_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
          {social.length > 0 && (
            <div className="foot-col">
              <span className="foot-head mono">Community</span>
              {social.map((l) => (
                <a key={l.label} href={l.href} rel="noopener noreferrer">
                  {l.label}
                </a>
              ))}
            </div>
          )}
        </nav>
      </div>
      <div className="wrap foot-bottom foot-mono">
        © 2026 Bag Protocol · Ethereum · Arbitrum · Base · Robinhood Chain · Not investment advice.
      </div>
    </footer>
  );
}
