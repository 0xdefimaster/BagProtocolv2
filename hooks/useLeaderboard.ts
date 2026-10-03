'use client';

import { useCallback, useEffect, useState } from 'react';
import { LeaderboardResult, Season } from '@/types/domain';

export function useLeaderboard() {
  const [result, setResult] = useState<LeaderboardResult | null>(null);
  // Production-hardening P0-6 — the real, date-derived current season
  // (or null when none is active), never the hardcoded GENESIS_SEASON.
  const [season, setSeason] = useState<Season | null>(null);

  const refresh = useCallback(() => {
    fetch('/api/leaderboard')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { result: LeaderboardResult | null; season: Season | null } | null) => {
        if (data) {
          setResult(data.result);
          setSeason(data.season);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { result, season, refresh };
}
