'use client';

import { useEffect, useState, useCallback } from 'react';

export interface ActivityItem {
  id: string;
  action: string;
  timestamp: number; // ms since epoch
}

const STORAGE_KEY = 'bag-protocol:activity';
const LOCAL_EVENT = 'bag-protocol:activity-updated';
const MAX_ITEMS = 20;

// Seed data so the feed doesn't look empty on a first-ever visit, backdated
// so it reads naturally alongside real, newer events.
// Local, per-browser log of actions this browser took (create, fork, follow).
// Real money activity (purchases, redemptions, fees, royalties) comes from the
// server (GET /api/activity) and is merged in by the profile page. There is
// no demo seed: an earlier version filled an empty log with invented entries
// ("Invested $5,000 in AI Leaders"); any stored seed entries are dropped.
const isSeed = (item: ActivityItem) => typeof item.id === 'string' && item.id.startsWith('seed-');

function readActivity(): ActivityItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw) as ActivityItem[];
    if (!Array.isArray(items)) return [];
    const real = items.filter((i) => !isSeed(i));
    if (real.length !== items.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(real));
    return real;
  } catch {
    return [];
  }
}

function writeActivity(items: ActivityItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore quota / privacy-mode errors
  }
}

export function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function useActivity() {
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  useEffect(() => {
    setActivity(readActivity());
    const sync = () => setActivity(readActivity());
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_EVENT, sync);
    };
  }, []);

  const addActivity = useCallback((action: string) => {
    const next = [{ id: `a-${Date.now()}`, action, timestamp: Date.now() }, ...readActivity()].slice(
      0,
      MAX_ITEMS
    );
    writeActivity(next);
    setActivity(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
  }, []);

  return { activity, addActivity };
}
