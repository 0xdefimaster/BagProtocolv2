import { LeaderboardEntry, LeaderboardResult } from '@/types/domain';
import { realizedPnLToPoints } from '@/lib/domain/points/engine';
import { getUserPoints } from './points-service';
import { getActiveSeason } from './season-service';
import { LEADERBOARD_TOP_N } from '@/lib/config/season';

// Deterministic PRNG (mulberry32) so the demo leaderboard is stable across
// reloads without needing to persist 40 fake rows in storage.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_TRADER_COUNT = 42;

interface SeededTrader {
  userId: string;
  displayName: string;
  realizedPnL: number;
}

function generateSeededTraders(seasonId: string): SeededTrader[] {
  const seed = Array.from(seasonId).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const rand = mulberry32(seed);
  const traders: SeededTrader[] = [];

  for (let i = 0; i < DEMO_TRADER_COUNT; i++) {
    const addr = Array.from({ length: 6 }, () => Math.floor(rand() * 16).toString(16)).join('');
    const suffix = Array.from({ length: 3 }, () => Math.floor(rand() * 16).toString(16)).join('');
    // Skewed distribution: a handful of big winners, a long tail of modest
    // profit, and a few underwater traders — reads like a real season.
    const roll = rand();
    let pnl: number;
    if (roll < 0.08) pnl = 3000 + rand() * 3500; // top performers
    else if (roll < 0.55) pnl = 200 + rand() * 2800; // solid profit
    else if (roll < 0.85) pnl = rand() * 600; // marginal
    else pnl = -(rand() * 900); // underwater

    traders.push({
      userId: `demo-${addr}`,
      displayName: `0x${addr}...${suffix}`,
      realizedPnL: Math.round(pnl),
    });
  }

  return traders.sort((a, b) => b.realizedPnL - a.realizedPnL);
}

export function getLeaderboard(userId: string, displayName: string): LeaderboardResult {
  const season = getActiveSeason();
  const seeded = generateSeededTraders(season.id);

  const selfPoints = getUserPoints(userId, season.id);
  const selfEntryRaw: SeededTrader = {
    userId,
    displayName,
    realizedPnL: selfPoints.totalRealizedPnL,
  };

  const combined = [...seeded.filter((t) => t.userId !== userId), selfEntryRaw].sort(
    (a, b) => b.realizedPnL - a.realizedPnL
  );

  const entries: LeaderboardEntry[] = combined.map((t, i) => ({
    rank: i + 1,
    userId: t.userId,
    displayName: t.displayName,
    realizedPnL: t.realizedPnL,
    bagPoints: realizedPnLToPoints(t.realizedPnL),
    isSelf: t.userId === userId,
  }));

  const selfIndex = entries.findIndex((e) => e.isSelf);
  const selfEntry = selfIndex >= 0 ? entries[selfIndex] : null;
  const rankAboveSelf = selfIndex > 0 ? entries[selfIndex - 1] : null;

  return {
    seasonId: season.id,
    entries: entries.slice(0, LEADERBOARD_TOP_N),
    topN: LEADERBOARD_TOP_N,
    self: selfEntry
      ? {
          rank: selfEntry.rank,
          bagPoints: selfEntry.bagPoints,
          realizedPnL: selfEntry.realizedPnL,
          pointsToNextRank: rankAboveSelf ? Math.max(0, rankAboveSelf.bagPoints - selfEntry.bagPoints + 1) : 0,
        }
      : null,
  };
}
