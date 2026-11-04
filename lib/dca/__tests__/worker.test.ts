import { describe, expect, it } from 'vitest';
import type { DcaKeeper } from '../keeper/keeper';
import { KeeperWorker } from '../keeper/worker';

describe('KeeperWorker', () => {
  it('reports healthy after a tick, unhealthy when ticks fail or go stale, and fans out alerts', async () => {
    let fail = false;
    const clock = { ms: 0 };
    const keeper = {
      tick: async () => {
        if (fail) throw new Error('rpc');
        return [{ id: '0x1', state: 'DUE' }];
      },
    } as unknown as DcaKeeper;
    const seen: string[] = [];
    const w = new KeeperWorker(keeper, { mode: 'PAPER', intervalMs: 1000, sinks: [(a) => void seen.push(a.kind)], now: () => clock.ms });
    expect(w.health().ok).toBe(false); // no tick yet
    await w.runOnce();
    expect(w.health()).toMatchObject({ ok: true, ticks: 1, states: { DUE: 1 } });
    clock.ms += 5_000;
    expect(w.health().ok).toBe(false); // stale
    fail = true;
    for (let i = 0; i < 3; i++) await w.runOnce();
    expect(w.health()).toMatchObject({ ok: false, failedTicks: 3, consecutiveFailures: 3 });
    expect(seen).toContain('RPC_ERROR');
    fail = false;
    await w.runOnce();
    expect(w.health().ok).toBe(true);
  });
});
