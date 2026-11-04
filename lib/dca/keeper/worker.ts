import { createServer, type Server } from 'node:http';
import type { DcaKeeper, KeeperAlert } from './keeper';
import type { KeeperJob, KeeperJobState } from './types';

// -----------------------------------------------------------------------------
// Long-running loop around DcaKeeper: one tick every `intervalMs`, never two at
// once, health and status over HTTP (bind to localhost unless the deployment
// puts it behind its own network policy), alerts to a sink. A tick that throws
// is counted and reported; the loop keeps running.
// -----------------------------------------------------------------------------

export interface WorkerHealth {
  ok: boolean;
  mode: string;
  startedAt: number;
  lastTickAt: number | null;
  lastTickMs: number | null;
  ticks: number;
  failedTicks: number;
  consecutiveFailures: number;
  lastError: string | null;
  states: Partial<Record<KeeperJobState, number>>;
  recentAlerts: (KeeperAlert & { at: number })[];
}

export type AlertSink = (a: KeeperAlert & { at: number }) => void | Promise<void>;

/** JSON line on stdout. Never includes RPC URLs or keys (alerts carry ids, hashes and reasons only). */
export const consoleAlertSink: AlertSink = (a) => {
  process.stdout.write(`${JSON.stringify({ level: 'alert', ...a })}\n`);
};

/** POSTs each alert to a webhook (e.g. a chat or paging integration). Failures are swallowed and logged. */
export function webhookAlertSink(url: string): AlertSink {
  return async (a) => {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a), signal: AbortSignal.timeout(5_000) });
    } catch {
      process.stderr.write('alert webhook delivery failed\n');
    }
  };
}

export class KeeperWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private server: Server | null = null;
  private readonly h: WorkerHealth;
  /** Last state seen per job (jobs not claimed in a tick keep their previous state). */
  private readonly lastState = new Map<string, KeeperJobState>();

  constructor(
    private readonly keeper: DcaKeeper,
    private readonly o: { mode: string; intervalMs: number; sinks: AlertSink[]; staleAfterMs?: number; maxConsecutiveFailures?: number; now?: () => number },
  ) {
    this.h = { ok: true, mode: o.mode, startedAt: this.now(), lastTickAt: null, lastTickMs: null, ticks: 0, failedTicks: 0, consecutiveFailures: 0, lastError: null, states: {}, recentAlerts: [] };
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Feed for DcaKeeper's onAlert. */
  readonly alert = (a: KeeperAlert) => {
    const e = { ...a, at: this.now() };
    this.h.recentAlerts = [...this.h.recentAlerts.slice(-49), e];
    for (const s of this.o.sinks) void s(e);
  };

  /** One tick, unless one is already running. */
  async runOnce(): Promise<KeeperJob[] | null> {
    if (this.running) return null;
    this.running = true;
    const t0 = this.now();
    try {
      const jobs = await this.keeper.tick();
      this.h.ticks++;
      this.h.consecutiveFailures = 0;
      for (const j of jobs) this.lastState.set(j.id, j.state);
      const states: Partial<Record<KeeperJobState, number>> = {};
      for (const st of this.lastState.values()) states[st] = (states[st] ?? 0) + 1;
      this.h.states = states;
      return jobs;
    } catch (e) {
      this.h.failedTicks++;
      this.h.consecutiveFailures++;
      this.h.lastError = (e as Error)?.name ?? 'Error';
      if (this.h.consecutiveFailures >= (this.o.maxConsecutiveFailures ?? 3)) {
        this.alert({ kind: 'RPC_ERROR', jobId: '0x', detail: `${this.h.consecutiveFailures} consecutive failed ticks (${this.h.lastError})` });
      }
      return null;
    } finally {
      this.h.lastTickAt = this.now();
      this.h.lastTickMs = this.now() - t0;
      this.running = false;
    }
  }

  health(): WorkerHealth {
    const stale = this.o.staleAfterMs ?? this.o.intervalMs * 3;
    const fresh = this.h.lastTickAt !== null && this.now() - this.h.lastTickAt <= stale;
    return { ...this.h, ok: !this.stopped && fresh && this.h.consecutiveFailures < (this.o.maxConsecutiveFailures ?? 3) };
  }

  start() {
    const loop = async () => {
      if (this.stopped) return;
      await this.runOnce();
      if (!this.stopped) this.timer = setTimeout(loop, this.o.intervalMs);
    };
    void loop();
  }

  /** /healthz → 200 or 503; /status → health JSON. */
  serve(port: number, host = '127.0.0.1'): Server {
    this.server = createServer((req, res) => {
      const h = this.health();
      if (req.url === '/healthz') {
        res.writeHead(h.ok ? 200 : 503, { 'content-type': 'text/plain' }).end(h.ok ? 'ok' : 'unhealthy');
      } else if (req.url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(h));
      } else res.writeHead(404).end();
    });
    this.server.listen(port, host);
    return this.server;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
