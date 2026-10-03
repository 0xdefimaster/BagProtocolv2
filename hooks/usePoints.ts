'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserPoints, PointTransaction, Season } from '@/types/domain';
import { useCurrentUserId } from './useCurrentUserId';

export function usePoints() {
  const { isAuthenticated } = useCurrentUserId();
  // Production-hardening P0-6 — no hardcoded placeholder season anymore;
  // `null` (unknown/no active season yet) until the real fetch resolves.
  const [season, setSeason] = useState<Season | null>(null);
  const [points, setPoints] = useState<UserPoints | null>(null);
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);

  const refresh = useCallback(() => {
    if (!isAuthenticated) {
      setPoints(null);
      setTransactions([]);
      return;
    }
    fetch('/api/points')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { season: Season | null; points: UserPoints | null; transactions: PointTransaction[] } | null) => {
        if (!data) return;
        setSeason(data.season);
        setPoints(data.points);
        setTransactions(data.transactions);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { season, points, transactions, refresh };
}
