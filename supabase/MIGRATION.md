# Backend migration — localStorage → Supabase

## Status

| Piece | Status |
|---|---|
| Real price feed | ✅ done (`lib/market/price-feed.ts`) |
| Wallet-signature auth (nonce → sign → session → user) | ✅ done |
| `users`, `portfolios`, `positions`, `trades` | ✅ on Supabase |
| `user_points`, `point_transactions`, `seasons` | ✅ on Supabase |
| Real (non-simulated) leaderboard | ✅ done |
| Server-side enforcement of trades/points | ✅ done (route handlers, service-role key) |
| `boxes`, `inventory`, `accessories`, `bag_nfts`, `activities` | ⬜ still localStorage — not in scope yet |

Everything below this line describes what shipped, so the next phase (boxes /
inventory / BAG NFTs) has the same seam to follow.

## What actually changed

### 1. Auth: Wallet → Sign Message → Nonce → Session → User → Supabase

There is no Supabase Auth identity here (no email/password, no OAuth) — the
only credential is a wallet signature. The flow:

1. `POST /api/auth/nonce` — client sends `walletAddress`, server generates a
   random nonce, builds the exact message to sign, and stores
   `{wallet_address, nonce, message, expires_at}` in `auth_nonces`
   (5-minute TTL, one-time use).
2. Client calls `personal_sign` on that exact message via the injected
   wallet provider (`lib/wallet-context.tsx`'s `signIn()`).
3. `POST /api/auth/verify` — server re-fetches the stored message by
   `(walletAddress, nonce)` (deleting it either way, so it can never be
   replayed), verifies the signature against it with `viem`'s
   `verifyMessage`, then upserts a `users` row by `wallet_address` (seeding
   a `portfolios` row with the $10,000 starting balance on first sign-in).
4. On success, the server issues an httpOnly JWT cookie (`lib/auth/session.ts`)
   naming `users.id` — this is the "Session" step. Every subsequent
   `app/api/*` route reads the user id from this cookie, **never** from a
   value the client sends in the request body.
5. `GET /api/auth/session` restores this on page reload; `POST
   /api/auth/logout` clears it; `lib/wallet-context.tsx` auto-triggers
   `signIn()` right after `connect()` so it reads as one action to the user.

`hooks/useCurrentUserId.ts` returns the real `users.id` (uuid) once
`authUser` is set, and only then — a connected-but-unsigned wallet still
falls back to guest behavior, since there's no server-trusted identity yet.

### 2. Trading, portfolio, points: now server-enforced

`lib/domain/trading/engine.ts`'s `applyTrade()` (pure: portfolio + trade
request in, next portfolio out) is unchanged and reused as-is — only the
persistence layer moved:

- `lib/server/trading-repo.ts` — loads/saves `portfolios` + `positions`,
  inserts `trades` (unique `(user_id, client_trade_id)` makes retries
  idempotent).
- `lib/server/points-repo.ts` — re-derives `user_points.bag_points` from
  `total_realized_pnl` after every SELL, same "always recompute, never
  accumulate deltas" rule as before, now backed by a real upsert instead of
  a localStorage array.
- Both are called only from `app/api/portfolio/route.ts` and
  `app/api/trades/route.ts`, using `supabaseAdmin()` (service-role key,
  server-only — see `lib/supabase/server.ts`). Every route calls
  `requireSession()` first; there is no path where a client-supplied userId
  is trusted.
- `hooks/usePaperPortfolio.ts` / `usePoints.ts` now call these routes via
  `fetch()` instead of importing `lib/services/trading-service.ts` /
  `points-service.ts` directly. The only visible change to callers:
  `buy()` / `sell()` / `invest()` are `async` now.

### 3. Leaderboard: real query, fake traders removed

`lib/server/leaderboard-repo.ts` replaces
`lib/services/leaderboard-service.ts`'s ~40-seeded-fake-trader generator
with an actual query — `user_points` joined to `users`, ordered by
`total_realized_pnl desc`. `GET /api/leaderboard` is public (no session
required to view), `self` only resolves when signed in. The old generator
file is unused dead code now; safe to delete once nothing else references it.

## ⚠️ Known regression introduced by this pass

`lib/services/box-service.ts` (still localStorage-only) spends BAG Points by
calling `lib/services/points-service.ts`'s `spendPoints()`, which reads/writes
the localStorage `user_points` collection. Trading now awards points into
**Supabase** instead (`lib/server/points-repo.ts`), so that localStorage copy
never gets written to anymore — it permanently reads `pointsAvailable: 0`,
and **every box purchase will fail** with "Not enough BAG Points" regardless
of a user's real balance.

This isn't fixed in this pass because boxes/inventory are explicitly out of
scope (see the table above). Fixing it requires the same repo/route pattern
used for trading: a `lib/server/box-repo.ts` + `app/api/boxes/route.ts` that
calls `lib/server/points-repo.ts`'s balance instead of the localStorage one.
Until that lands, either disable the "buy box" UI or accept that it's
broken — don't ship it as-is.

## What's still on localStorage (out of scope for this pass)

`boxes`, `accessories`, `inventory`, and `bag_nfts` (the collectibles loop)
and `activities` (the feed) still go through `lib/services/db.ts`'s
localStorage collections via `hooks/useBoxes.ts`, `useInventory.ts`,
`useBagNFTs.ts`. The schema for all four already exists in
`supabase/schema.sql` with RLS enabled — migrating them is the same pattern
as trading/points above: a `lib/server/*-repo.ts` + `app/api/*` route per
resource, then swap the hook's import from the service file to `fetch()`.
Box-opening RNG in particular should move server-side in that pass, for the
same reason points were: the result must not be a value the client can
choose or replay.

## Phase 20–22 — creator rewards + redemption (done since the note above was written)

Per-user share/holdings ledgers (`bag_investor_positions`,
`bag_investor_holdings`), real redemption (`redeem_intents` +
`apply_redeem_execution`), fork royalty (deposit-time, credited to a fork's
ROOT creator), and performance fee (redemption-time, credited to a bag's
OWN creator, computed off each depositor's own proportionally-reduced cost
basis — no separate high-water-mark needed) are all implemented — see
`supabase/migrations/0011_add_bag_investor_positions.sql` through
`0013_add_creator_rewards.sql` and `types/basket-protocol.ts`'s Phase 22
doc block. Both rewards settle into `portfolios.cash_balance` (the same
paper ledger `commit_investment_transaction()` already uses), not an
on-chain transfer — this protocol has no pooled custody, so an on-chain
fee-split needs a new signed swap leg per transaction, deliberately left
as a follow-up rather than attempted under this pass's scope.

`bag_nfts` (mentioned as still-localStorage above) has since been migrated
too — see `lib/server/nft-repo.ts` / `app/api/nfts/*`.



1. Create a Supabase project, run `supabase/schema.sql` in the SQL editor
   (or `supabase db push`).
2. Copy `.env.example` to `.env.local` and fill in
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (Settings → API), and a random
   `SESSION_SECRET` (`openssl rand -base64 32`).
3. Every route in `app/api/**` returns a `503` with a clear message instead
   of a stack trace if these aren't set (`isSupabaseConfigured()`), so a
   misconfigured deployment fails loudly rather than silently falling back
   to nothing.
