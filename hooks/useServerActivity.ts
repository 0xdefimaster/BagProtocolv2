'use client';

import { useEffect, useState } from 'react';
import type { ActivityItem } from '@/lib/activity-store';

/**
 * The signed-in user's real activity from the server (GET /api/activity): purchases, redemptions, fees and
 * royalties earned, from the database records the accounting writes. Empty when signed out or on error;
 * never invented.
 */
export function useServerActivity(enabled: boolean): ActivityItem[] {
  const [items, setItems] = useState<ActivityItem[]>([]);
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    let cancelled = false;
    fetch('/api/activity', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { activity?: ActivityItem[] } | null) => {
        if (!cancelled) setItems(Array.isArray(body?.activity) ? body.activity : []);
      })
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return items;
}
