// -----------------------------------------------------------------------------
// Production-hardening P0-4 — the ONE place demo/mock data is allowed to be
// shown to a real, connected user. Every component that used to blend
// `mockUser`/`mockUserBags`/`mockBags` into a real screen's numbers now
// checks this flag first; when it's false (the default, and always false
// in a production build/deployment unless explicitly set), that blending
// never happens — a real, wallet-connected user's Dashboard/Explore/etc.
// show ONLY authoritative API/DB data, and a genuine "nothing yet" empty
// state rather than fabricated numbers standing in for it.
//
// `NEXT_PUBLIC_DEMO_MODE` (not just `DEMO_MODE`) because this is read from
// client components (Dashboard, FeaturedBags) — Next.js only inlines
// `NEXT_PUBLIC_`-prefixed env vars into the client bundle.
// -----------------------------------------------------------------------------

export function isDemoModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}
