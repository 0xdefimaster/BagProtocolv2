import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import type { BagJson } from '@/types/strategy';
import type { DcaPlan, DcaSettings } from '@/lib/dca/plan';
import type { DcaTrialState } from '@/lib/dca/types';

interface Job { public: DcaTrialState; directory: string }
const shared = globalThis as typeof globalThis & { bagDcaTrials?: Map<string, Job> };
const jobs = shared.bagDcaTrials ??= new Map();
const TIMEOUT_MS = 20 * 60 * 1000;

/** This worker must never run on a deployment, even with the public flag enabled. */
export function localDcaRequestAllowed(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DCA_TRIAL !== 'true' || process.env.BAG_DCA_TRIAL !== 'true') return false;
  const url = new URL(request.url), origin = request.headers.get('origin');
  // Next's internal URL may use localhost while the browser uses 127.0.0.1.
  // Validate the actual Host as a loopback address before comparing origins.
  let publicUrl: URL;
  try { publicUrl = new URL(`${url.protocol}//${request.headers.get('host') || url.host}`); } catch { return false; }
  let sameOrigin = origin === publicUrl.origin;
  if (!origin && request.method === 'GET' && request.headers.get('sec-fetch-site') === 'same-origin') {
    try { sameOrigin = new URL(request.headers.get('referer') || '').origin === publicUrl.origin; } catch { /* No browser origin evidence. */ }
  }
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname) && sameOrigin && request.headers.get('x-bag-local-trial') === '1';
}
export function getDcaTrial(id: string, bagId: string): DcaTrialState | null {
  const job = jobs.get(`${bagId}:${id}`);
  return job ? structuredClone(job.public) : null;
}
export async function startDcaTrial(bagId: string, bag: Pick<BagJson, 'bagJson' | 'definition'>, definitionHash: string, settings: DcaSettings, plan: DcaPlan): Promise<DcaTrialState> {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DCA_TRIAL !== 'true' || process.env.BAG_DCA_TRIAL !== 'true') throw new Error('Local DCA worker is disabled.');
  if ([...jobs.values()].some(j => j.public.state === 'RUNNING')) throw new Error('A local trial is already running. Wait for it to finish.');
  // Reserve synchronously, before any I/O; parallel requests cannot launch two workers.
  const id = randomUUID();
  const directory = path.join(process.cwd(), 'artifacts', 'dca-trial', id);
  const job: Job = { public: { id, state: 'RUNNING', plan, definitionHash, completedChecks: 0, completedPurchases: 0 }, directory };
  jobs.set(`${bagId}:${id}`, job);
  try {
    await mkdir(directory, { recursive: true });
    const config = path.join(directory, 'request.json');
    await writeFile(config, JSON.stringify({ bagId, bag, definitionHash, settings, plan }, null, 2));
    const script = path.join(process.cwd(), 'scripts/research/dca-trial/run.mjs');
    const envFile = process.env.BAG_DCA_ENV_FILE || path.join(process.cwd(), '.env.local');
    const child = spawn(process.execPath, [script, '--repo', process.cwd(), '--config', config, '--env-file', envFile, '--out', path.join(directory, 'execution')], {
      cwd: process.cwd(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      // Child settings select RPC/Composer entries only; no wallet signing credentials are passed here.
      env: { NODE_ENV: 'development', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE },
    });
    let buffer = '', outputBytes = 0, timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 2_000_000) { child.kill(); return; }
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) { if (line.startsWith('PASS ')) job.public.completedChecks++; if (line.startsWith('PURCHASE ')) job.public.completedPurchases++; }
    });
    child.stderr.on('data', () => { /* Never expose credential-bearing transport stacks to the browser. */ });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
    timeout.unref();
    child.once('error', () => { clearTimeout(timeout); job.public.state = 'FAILED'; job.public.error = 'The local worker could not start. Check Node and installed dependencies.'; });
    child.once('close', async code => {
      clearTimeout(timeout);
      try {
        const report = JSON.parse(await readFile(path.join(directory, 'execution/results.json'), 'utf8'));
        if (code !== 0 || report.status !== 'CONFIGURED_USDG_RECURRING_FORK_VERIFIED' || report.summary.fail !== 0 || report.executions.length !== plan.purchases || report.publicTransactionsSubmitted !== 0 || report.strategy.definitionHash !== definitionHash) throw new Error('incomplete');
        job.public.result = { checks: report.summary, finalUsdgRaw: report.finalBalances.USDG, reservedUsdgRaw: report.finalReservedRaw, spentUsdgRaw: report.totalSpentRaw, publicTransactions: 0 };
        job.public.completedChecks = report.summary.pass;
        job.public.completedPurchases = report.executions.length;
        job.public.state = 'SUCCEEDED';
      } catch {
        job.public.state = 'FAILED';
        job.public.error = timedOut ? 'The local trial reached its time limit. Nothing was sent to the public chain.' : 'The trial stopped before verification completed. Inspect the local results.json for the failed stage; no live automation was activated.';
      }
    });
    // Keep bounded state in a long-lived development process; disk evidence remains available.
    if (jobs.size > 30) for (const [key, value] of jobs) { if (jobs.size <= 30) break; if (value.public.state !== 'RUNNING') jobs.delete(key); }
    return structuredClone(job.public);
  } catch (err) {
    job.public.state = 'FAILED'; job.public.error = 'The local trial could not be prepared.';
    throw err;
  }
}
