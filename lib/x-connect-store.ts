'use client';

import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'bag-protocol:x-handle';
const LOCAL_EVENT = 'bag-protocol:x-handle-updated';

function readHandle(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, '');
}

export function useXConnection() {
  const [handle, setHandle] = useState('');

  useEffect(() => {
    setHandle(readHandle());
    const sync = () => setHandle(readHandle());
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_EVENT, sync);
    };
  }, []);

  const connectHandle = useCallback((input: string) => {
    const clean = normalizeHandle(input);
    if (!clean) return;
    window.localStorage.setItem(STORAGE_KEY, clean);
    setHandle(clean);
    window.dispatchEvent(new Event(LOCAL_EVENT));
  }, []);

  const disconnectHandle = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setHandle('');
    window.dispatchEvent(new Event(LOCAL_EVENT));
  }, []);

  return { handle, isConnected: handle !== '', connectHandle, disconnectHandle };
}
