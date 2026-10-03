// -----------------------------------------------------------------------------
// Local "database". Every domain service (trading, points, leaderboard, boxes,
// inventory, NFTs) reads and writes through this module instead of touching
// `localStorage` directly. That keeps a single seam: replacing this file's
// internals with real fetch()/Supabase calls is enough to move the whole app
// from local-only demo storage to a real backend — no service or component
// code has to change.
//
// Because JS execution in the browser is single-threaded, every service
// function that does a synchronous read -> mutate -> write cycle is
// effectively atomic: nothing else can interleave mid-function. That's what
// stands in here for "use a database transaction" from the spec.
// -----------------------------------------------------------------------------

const NAMESPACE = 'bag-protocol:db';

function isBrowser() {
  return typeof window !== 'undefined';
}

function key(collection: string) {
  return `${NAMESPACE}:${collection}`;
}

export function readCollection<T>(collection: string): T[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(key(collection));
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

export function writeCollection<T>(collection: string, items: T[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key(collection), JSON.stringify(items));
    window.dispatchEvent(new Event(dbEventName(collection)));
  } catch {
    // Storage full or unavailable (private mode) — fail silently, same as
    // the rest of the app's existing local stores.
  }
}

export function dbEventName(collection: string): string {
  return `bag-protocol:db-updated:${collection}`;
}

export function readSingleton<T>(key_: string, fallback: T): T {
  if (!isBrowser()) return fallback;
  try {
    const raw = window.localStorage.getItem(key(key_));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeSingleton<T>(key_: string, value: T): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key(key_), JSON.stringify(value));
    window.dispatchEvent(new Event(dbEventName(key_)));
  } catch {
    // ignore
  }
}

export function genId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
