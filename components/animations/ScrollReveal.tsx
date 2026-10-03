"use client";

import { useEffect } from "react";

/**
 * Mount once per page. Observes every [data-reveal] element and adds
 * an `in` class when it scrolls into view, matching the original
 * landing page's fade/slide-up reveal behavior.
 */
export default function ScrollReveal() {
  useEffect(() => {
    const revealEls = document.querySelectorAll("[data-reveal]");
    // Never leave content invisible: without IntersectionObserver, or when the
    // user asked for reduced motion, reveal everything immediately.
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof IntersectionObserver === "undefined" || reduceMotion) {
      revealEls.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach((el) => io.observe(el));

    return () => io.disconnect();
  }, []);

  return null;
}
