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
function seedActivity(): ActivityItem[] {
  const now = Date.now();
  return [
    { id: 'seed-1', action: 'Invested $5,000 in AI Leaders', timestamp: now - 2 * 60 * 60 * 1000 },
    { id: 'seed-2', action: 'Forked L2 Ecosystem Bag', timestamp: now - 24 * 60 * 60 * 1000 },
    { id: 'seed-3', action: 'Started following RWA Index', timestamp: now - 3 * 24 * 60 * 60 * 1000 },
  ];
}

function readActivity(): ActivityItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ActivityItem[];
    const seeded = seedActivity();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
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
