"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import ArrowIcon from "@/components/ui/ArrowIcon";
import { NAV_LINKS, APP_URL } from "@/lib/constants";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

// -----------------------------------------------------------------------------
// Site header. Desktop (> 840px): inline links, unchanged. Mobile (≤ 840px):
// the inline links are hidden and a disclosure-pattern menu button reveals the
// same links in a panel below the bar.
//
// Mobile menu behavior (tests: components/layout/__tests__/Header.test.tsx):
//   - button has an accessible name, aria-expanded and aria-controls
//   - opening moves focus to the first menu link
//   - Escape closes and returns focus to the button
//   - choosing a link closes the menu
//   - focus leaving the header (Tab past the last item) closes the menu, so
//     keyboard users are never stranded behind an open overlay
//   - page scroll is locked only while open, and restored exactly
//   - widening past the breakpoint closes it
// It is a disclosure, not a modal dialog, so there is no focus trap.
// -----------------------------------------------------------------------------

const PANEL_ID = "mobile-nav";
const DESKTOP_QUERY = "(min-width: 841px)";

export default function Header() {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("a")?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const onHeaderBlur = (e: React.FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && !headerRef.current?.contains(next)) setOpen(false);
  };

  return (
    <header ref={headerRef} onBlur={onHeaderBlur}>
      <div className="wrap nav">
        <Link href="/" className="brand">
          {/* Decorative: the link's name comes from the visible text next to it. */}
          <Image src="/logo.png" alt="" width={32} height={32} />
          <div className="brand-text">
            <span className="b1">BAG PROTOCOL</span>
            <span className="b2 mono">Programmable Portfolios</span>
          </div>
        </Link>
        <nav className="navlinks" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="nav-actions">
          <ThemeToggle />
          <Link className="btn btn-primary nav-cta" href={APP_URL}>
            Launch App
            <ArrowIcon size={14} />
          </Link>
          <button
            ref={buttonRef}
            type="button"
            className="nav-toggle"
            aria-label="Navigation menu"
            aria-expanded={open}
            aria-controls={PANEL_ID}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="nav-toggle-bars" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div id={PANEL_ID} ref={panelRef} className="mobile-nav" hidden={!open}>
        <nav aria-label="Mobile">
          <ul>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} onClick={() => close(false)}>
                  {link.label}
                </a>
              </li>
            ))}
            <li>
              <Link className="btn btn-primary" href={APP_URL} onClick={() => close(false)}>
                Launch App
                <ArrowIcon size={14} />
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
