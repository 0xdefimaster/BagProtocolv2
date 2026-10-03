'use client';

import { useEffect, useState, useCallback } from 'react';

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  timestamp: number;
  read: boolean;
}

const STORAGE_KEY = 'bag-protocol:notifications';
const LOCAL_EVENT = 'bag-protocol:notifications-updated';
const MAX_ITEMS = 20;

function seedNotifications(): NotificationItem[] {
  const now = Date.now();
  return [
    {
      id: 'n-seed-1',
      title: 'Protocol Labs published a new Bag',
      body: '"DeFi Blue Chips" just went live — you follow this creator.',
      timestamp: now - 5 * 60 * 60 * 1000,
      read: false,
    },
    {
      id: 'n-seed-2',
      title: 'Arbitrum DAO forked your bag',
      body: '"L2 Ecosystem" was forked into "L2 Ecosystem (Conservative)".',
      timestamp: now - 26 * 60 * 60 * 1000,
      read: true,
    },
  ];
}

function readNotifications(): NotificationItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as NotificationItem[];
    const seeded = seedNotifications();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  } catch {
    return [];
  }
}

function writeNotifications(items: NotificationItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  useEffect(() => {
    setNotifications(readNotifications());
    const sync = () => setNotifications(readNotifications());
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_EVENT, sync);
    };
  }, []);

  const addNotification = useCallback((title: string, body: string) => {
    const next = [
      { id: `n-${Date.now()}`, title, body, timestamp: Date.now(), read: false },
      ...readNotifications(),
    ].slice(0, MAX_ITEMS);
    writeNotifications(next);
    setNotifications(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
  }, []);

  const markAllRead = useCallback(() => {
    const next = readNotifications().map((n) => ({ ...n, read: true }));
    writeNotifications(next);
    setNotifications(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, addNotification, markAllRead, unreadCount };
}
