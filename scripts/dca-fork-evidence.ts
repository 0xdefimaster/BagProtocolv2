/**
 * Reproducible Robinhood fork evidence for DCA v1. Read-only against Robinhood Chain: it only forks it locally.
 *
 *   npx tsx scripts/dca-fork-evidence.ts
 *
 * 1. Pins a fork block: ROBINHOOD_FORK_BLOCK, or the chain's `finalized` block (fallback: latest − 100).
 * 2. Runs every fork test (contracts/test/fork/*.fork.test.ts) TWICE at that block, each run writing its evidence
 *    JSON to fork-evidence/<block>/run<n>/.
 * 3. Compares the two runs (everything except timings) and writes fork-evidence/<block>/summary.json.
 *
 * Environment: ROBINHOOD_MAINNET_RPC_URL (required, never printed or written). FACTORY_ADDRESS_ROBINHOOD and
 * BAG_EXECUTION_ROUTER_ADDRESS are read from the environment or, failing that, from .env.local (only these two keys)
 * so the real-BAG test can cross-check the app's configured factory.
 */
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL?.trim();
const TESTS = ['contracts/test/fork/BagDcaExecutor.fork.test.ts', 'contracts/test/fork/BagDcaRealBag.fork.test.ts'];
const scrub = (s: string) => (RPC ? s.split(RPC).join('<rpc>') : s).replace(/https?:\/\/\S+/g, '<url>');

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const j = (await res.json()) as { result?: any; error?: { message: string } };
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

function envLocal(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (process.env[k]) out[k] = process.env[k]!.trim();
  if (!existsSync('.env.local')) return out;
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\s]*)"?/);
    if (m && keys.includes(m[1]) && !out[m[1]] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

/** Deep comparison that ignores timings; returns the paths that differ. */
function diff(a: any, b: any, path = ''): string[] {
  if (/(^|\.)runtimeMs$/.test(path)) return [];
  if (typeof a !== typeof b) return [path || '<root>'];
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b ?? {})]);
    return [...keys].flatMap((k) => diff(a[k], b?.[k], path ? `${path}.${k}` : k));
  }
  return a === b ? [] : [path];
}

async function main() {
  if (!RPC) throw new Error('ROBINHOOD_MAINNET_RPC_URL is not set');
  const chainId = parseInt(await rpc('eth_chainId', []), 16);
  if (chainId !== 4663) throw new Error(`the RPC is on chain ${chainId}, not Robinhood Chain (4663)`);
  let block = process.env.ROBINHOOD_FORK_BLOCK?.trim();
  let blockSource = 'ROBINHOOD_FORK_BLOCK';
  if (!block) {
    try {
      block = BigInt((await rpc('eth_getBlockByNumber', ['finalized', false])).number).toString();
      blockSource = 'finalized tag';
    } catch {
      block = (BigInt(await rpc('eth_blockNumber', [])) - 100n).toString();
      blockSource = 'latest - 100';
    }
  }
  const blockInfo = await rpc('eth_getBlockByNumber', [`0x${BigInt(block).toString(16)}`, false]);
  console.log(`fork block ${block} (${blockSource}), hash ${blockInfo.hash}, timestamp ${BigInt(blockInfo.timestamp)}`);
  const commit = execSync('git rev-parse HEAD').toString().trim();
  const dirty = execSync('git status --porcelain -- contracts packages lib scripts hardhat.config.ts').toString().trim();
  const cross = envLocal(['FACTORY_ADDRESS_ROBINHOOD', 'BAG_EXECUTION_ROUTER_ADDRESS']);
  const root = join('fork-evidence', block);
  const runs: { run: number; exitCode: number | null; wallMs: number; dir: string }[] = [];
  for (const run of [1, 2]) {
    const dir = join(root, `run${run}`);
    mkdirSync(dir, { recursive: true });
    console.log(`\n=== run ${run}/2 at block ${block} ===`);
    const t0 = Date.now();
    const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['hardhat', 'test', 'nodejs', ...TESTS], {
      stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, ...cross, ROBINHOOD_FORK_BLOCK: block, DCA_FORK_EVIDENCE_DIR: dir },
    });
    runs.push({ run, exitCode: r.status, wallMs: Date.now() - t0, dir });
  }
  const files = [...new Set(runs.flatMap((r) => (existsSync(r.dir) ? readdirSync(r.dir) : [])))].sort();
  const tests: Record<string, unknown> = {};
  for (const f of files) {
    const [a, b] = runs.map((r) => (existsSync(join(r.dir, f)) ? JSON.parse(readFileSync(join(r.dir, f), 'utf8')) : null));
    const d = a && b ? diff(a, b) : ['missing in one run'];
    tests[f.replace(/\.json$/, '')] = { identicalAcrossRuns: d.length === 0, differences: d, run1: a, run2RuntimeMs: b?.runtimeMs ?? null };
  }
  const summary = {
    schema: 'bag-dca-fork-evidence/v1',
    evidenceClass: 'TEST_KEY_FORK (local EDR fork; Hardhat test accounts and impersonated addresses; nothing broadcast)',
    fork: { chainId, block, blockSource, hash: blockInfo.hash, timestamp: BigInt(blockInfo.timestamp).toString() },
    commit, sourceDirty: dirty.length > 0,
    appConfigCrossChecks: Object.fromEntries(['FACTORY_ADDRESS_ROBINHOOD', 'BAG_EXECUTION_ROUTER_ADDRESS'].map((k) => [k, cross[k] ? 'provided' : 'not provided'])),
    runs: runs.map(({ run, exitCode, wallMs }) => ({ run, exitCode, wallMs })),
    allPassed: runs.every((r) => r.exitCode === 0),
    reproducible: Object.values(tests).length > 0 && Object.values(tests).every((t: any) => t.identicalAcrossRuns),
    tests,
  };
  const text = scrub(JSON.stringify(summary, null, 2));
  writeFileSync(join(root, 'summary.json'), text + '\n');
  console.log(`\nsummary: ${join(root, 'summary.json')}`);
  console.log(`allPassed ${summary.allPassed}, reproducible ${summary.reproducible}, commit ${commit}${summary.sourceDirty ? ' (dirty)' : ''}`);
  process.exit(summary.allPassed && summary.reproducible ? 0 : 1);
}

main().catch((e) => {
  console.error(`dca-fork-evidence: ${scrub((e as Error).message)}`);
  process.exit(1);
});
