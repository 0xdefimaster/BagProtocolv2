'use client';

import { useEffect, useState } from 'react';
import { parseDec, formatDec } from '@/lib/domain/basket-protocol/accounting/decimal';

// -----------------------------------------------------------------------------
// The signed-in user's total position value, from the same source as the
// Portfolio page (GET /api/portfolio/positions, valued from holdings). A
// position whose value cannot be known right now (unpriced asset, unreadable
// balance) is left out and the total is marked incomplete, never guessed.
// -----------------------------------------------------------------------------

export type PositionsTotal =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'ready'; total: string; complete: boolean };

export function usePositionsTotal(enabled: boolean): PositionsTotal {
  const [state, setState] = useState<PositionsTotal>({ status: 'idle' });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    fetch('/api/portfolio/positions', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { positions: { effectivePosition: string | null }[] };
      })
      .then(({ positions }) => {
        if (cancelled) return;
        let total = BigInt(0);
        let complete = true;
        for (const p of positions) {
          if (p.effectivePosition === null) complete = false;
          else total += parseDec(p.effectivePosition);
        }
        setState({ status: 'ready', total: formatDec(total), complete });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
