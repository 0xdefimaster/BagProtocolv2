// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useActivity } from '@/lib/activity-store';
import { useNotifications } from '@/lib/notifications-store';

// No invented entries: an empty log stays empty, and seed entries stored by older versions are dropped.
beforeEach(() => window.localStorage.clear());

describe('local activity / notifications have no demo seed', () => {
  it('an empty activity log stays empty', async () => {
    const { result } = renderHook(() => useActivity());
    await waitFor(() => expect(result.current.activity).toEqual([]));
  });

  it('previously stored seed entries are dropped, real ones kept', async () => {
    window.localStorage.setItem(
      'bag-protocol:activity',
      JSON.stringify([
        { id: 'seed-1', action: 'Invested $5,000 in AI Leaders', timestamp: 1 },
        { id: 'a-2', action: 'Created bag: asd', timestamp: 2 },
      ])
    );
    window.localStorage.setItem('bag-protocol:notifications', JSON.stringify([{ id: 'n-seed-1', title: 'x', body: 'y', timestamp: 1, read: false }]));
    const { result } = renderHook(() => useActivity());
    await waitFor(() => expect(result.current.activity.map((a) => a.id)).toEqual(['a-2']));
    const n = renderHook(() => useNotifications());
    await waitFor(() => expect(n.result.current.notifications).toEqual([]));
  });
});
