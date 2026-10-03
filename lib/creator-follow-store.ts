'use client';

import { useEffect, useState, useCallback } from 'react';

const FOLLOWING_KEY = 'bag-protocol:following-creators'; // string[] of creator ids/handles
const LOCAL_EVENT = 'bag-protocol:creator-follow-updated';

function readFollowing(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FOLLOWING_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeFollowing(ids: string[]) {
  try {
    window.localStorage.setItem(FOLLOWING_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export function useCreatorFollows() {
  const [following, setFollowing] = useState<string[]>([]);

  useEffect(() => {
    setFollowing(readFollowing());
    const sync = () => setFollowing(readFollowing());
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_EVENT, sync);
    };
  }, []);

  const isFollowing = useCallback(
    (creatorId: string) => following.includes(creatorId),
    [following]
  );

  const toggleFollowCreator = useCallback((creatorId: string): boolean => {
    const current = readFollowing();
    const already = current.includes(creatorId);
    const next = already ? current.filter((id) => id !== creatorId) : [...current, creatorId];
    writeFollowing(next);
    setFollowing(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
    return !already;
  }, []);

  return { following, isFollowing, toggleFollowCreator };
}
