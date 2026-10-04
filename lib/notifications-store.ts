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

// No demo seed: an earlier version filled an empty list with invented
// notifications ("Arbitrum DAO forked your bag"). Stored seed entries are dropped.
const isSeed = (item: NotificationItem) => typeof item.id === 'string' && item.id.startsWith('n-seed-');

function readNotifications(): NotificationItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw) as NotificationItem[];
    if (!Array.isArray(items)) return [];
    const real = items.filter((i) => !isSeed(i));
    if (real.length !== items.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(real));
    return real;
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
