# archive/legacy-services/

These 4 files were moved here (NOT deleted) during the V13 cleanup pass,
after being independently verified dead by V13_DURUM_RAPORU.md and
re-verified a second time before this move (see the cleanup pass's own
report for the full reference-check evidence: static imports, dynamic
imports, string/path references, test references, script/config
references, tsconfig inclusion — all checked, zero real references found
outside this archive and each other).

- `leaderboard-service.ts` — old localStorage-based leaderboard (42 fake
  seeded traders). Replaced by `lib/server/leaderboard-repo.ts`.
- `season-service.ts` — only ever called by `leaderboard-service.ts`
  above (dead alongside it). Live season config is `lib/config/season.ts`.
- `points-service.ts` — old localStorage-based points ledger. Replaced by
  `lib/server/points-repo.ts`. This file's own header comment claimed it
  was "still LIVE" via `lib/services/box-service.ts` — that file has
  since been deleted from the repo entirely (confirmed: does not exist),
  so that claim was already stale before this archive move.
- `db.ts` — the shared localStorage read/write helper the three files
  above were built on. No other file imports it.

Excluded from the TypeScript build and eslint via `tsconfig.json`'s
`exclude` and `.eslintrc.json`'s `ignorePatterns` (both add `archive`).

**Not a decision to permanently delete these** — that's a separate,
explicit step the person doing the cleanup can take once they're
comfortable, per their own instruction not to do irreversible deletes in
this pass.
