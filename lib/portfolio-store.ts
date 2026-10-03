'use client';

import { useEffect, useState, useCallback } from 'react';

const INVESTMENTS_KEY = 'bag-protocol:investments'; // Record<bagId, amount>
const FOLLOWING_KEY = 'bag-protocol:following'; // string[] of bagIds
const LOCAL_EVENT = 'bag-protocol:portfolio-updated';

function readInvestments(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(INVESTMENTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readFollowing(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FOLLOWING_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeInvestments(data: Record<string, number>) {
  try {
    window.localStorage.setItem(INVESTMENTS_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function writeFollowing(ids: string[]) {
  try {
    window.localStorage.setItem(FOLLOWING_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export function usePortfolio() {
  const [investments, setInvestments] = useState<Record<string, number>>({});
  const [following, setFollowing] = useState<string[]>([]);

  useEffect(() => {
    setInvestments(readInvestments());
    setFollowing(readFollowing());
    const sync = () => {
      setInvestments(readInvestments());
      setFollowing(readFollowing());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_EVENT, sync);
    };
  }, []);

  const invest = useCallback((bagId: string, amount: number) => {
    const current = readInvestments();
    const next = { ...current, [bagId]: (current[bagId] || 0) + amount };
    writeInvestments(next);
    setInvestments(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
  }, []);

  const toggleFollow = useCallback((bagId: string): boolean => {
    const current = readFollowing();
    const isFollowing = current.includes(bagId);
    const next = isFollowing ? current.filter((id) => id !== bagId) : [...current, bagId];
    writeFollowing(next);
    setFollowing(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
    return !isFollowing; // returns the new following state
  }, []);

  const totalInvested = Object.values(investments).reduce((sum, v) => sum + v, 0);

  return { investments, following, invest, toggleFollow, totalInvested };
}
