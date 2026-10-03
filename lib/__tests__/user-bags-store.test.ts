// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useUserBags } from '../user-bags-store';

const KEY = 'bag-protocol:user-bags';

beforeEach(() => localStorage.clear());

describe('useUserBags', () => {
  it('drops legacy local-only user-*/fork-* bags and removes them from storage', async () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: 'user-1' }, { id: 'fork-2' }, { id: 'imported-3' }]));
    const { result } = renderHook(() => useUserBags());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.userBags.map((b) => b.id)).toEqual(['imported-3']);
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual([{ id: 'imported-3' }]);
  });
});
