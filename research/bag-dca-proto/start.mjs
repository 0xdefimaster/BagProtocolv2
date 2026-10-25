#!/usr/bin/env node
// Single launcher for the BAG DCA research prototype (Windows: start.cmd). No shell is used anywhere:
// children are spawned with argument arrays, so paths with spaces work as they are.
//
//   node start.mjs unit                                   unit tests (rules, server, price gate, adapter)
//   node start.mjs test   --sdk <dir> [--env-file <f>]     unit tests + fork lifecycle with a local TEST key
//   node start.mjs wallet --sdk <dir> [--env-file <f>]     fork lifecycle with YOUR wallet: opens the signing page
//   node start.mjs shadow --app <app checkout> [--sources ...] [--env-file <f>] [--block-mode ...]
//   node start.mjs executor        --app <app checkout>    RecurringPurchaseExecutor on the fork, TEST keys (+ keeper)
//   node start.mjs executor-wallet --app <app checkout>    the same executor with YOUR wallet: 3 signatures, no transaction
//   node start.mjs preflight [--sdk <dir>] [--app <dir>]   checks only
// Options: --live (fresh Composer quotes; needs LIFI_API_KEY in --env-file), --no-open, --allow-other-sdk,
//          --url-file <f> (wallet: where the page URL is written; default the private session folder)
// Keys are read only by the child processes, only from --env-file, and never printed.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), cmd = argv[0];
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d), flag = n => argv.includes(n);
const EXPECTED_SDK_COMMIT = 'dadef00';
const PINNED = { hardhat: '3.14.0', viem: '2.56.0', solc: '0.8.23', tsx: '4.23.15', '@metamask/smart-accounts-kit': '2.0.0' };
const session = new Date().toISOString().replaceAll(':', '-').slice(0, 19) + '-' + randomBytes(2).toString('hex');
const log = { schema: 'bag-dca-launcher/v1', session, command: cmd, platform: process.platform, node: process.version, packageDir: here, checks: [], steps: [] };
const say = s => console.log(s);
const check = (id, ok, detail, fatal = true) => { log.checks.push({ id, ok, detail, fatal }); say(`${ok ? 'OK  ' : fatal ? 'FAIL' : 'WARN'} ${id}: ${detail}`); return ok; };
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const sha256 = f => createHash('sha256').update(readFileSync(f)).digest('hex');

if (!['unit', 'test', 'wallet', 'shadow', 'executor', 'executor-wallet', 'preflight'].includes(cmd)) {
  say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 2 : 0);
}

// ---- Preflight ----------------------------------------------------------------------------------
function preflight() {
  let ok = true;
  ok &= check('node', Number(process.versions.node.split('.')[0]) >= 24, `Node ${process.version} (needs >= 24)`);
  for (const [pkg, want] of Object.entries(PINNED)) {
    const f = join(here, 'node_modules', ...pkg.split('/'), 'package.json');
    const have = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).version : null;
    ok &= check(`dep ${pkg}`, have === want, have ? `${have} (pinned ${want})` : `missing: run "npm ci" in ${here}`);
  }
  const sums = join(here, 'vendor', 'e6bdd10', 'SHA256SUMS');
  if (existsSync(sums)) {
    const bad = readFileSync(sums, 'utf8').trim().split('\n').map(l => l.match(/^([0-9a-f]{64})\s+\*?(.+)$/)).filter(Boolean)
      .filter(([, h, f]) => !existsSync(join(dirname(sums), f)) || sha256(join(dirname(sums), f)) !== h).map(m => m[2]);
    ok &= check('vendor e6bdd10', bad.length === 0, bad.length ? 'hash mismatch: ' + bad.join(', ') : 'all vendored files match SHA256SUMS');
  }
  const envFile = opt('--env-file');
  if (envFile) {
    const keys = existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/).map(l => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean) : null;
    ok &= check('env file', !!keys, keys ? `${resolve(envFile)} (names only: ${keys.filter(k => ['ROBINHOOD_RPC_URL', 'LIFI_API_KEY', 'ZEROX_API_KEY'].includes(k)).join(', ') || 'none of the used keys'})` : `not found: ${envFile}`);
  }
  if (['test', 'wallet'].includes(cmd) || opt('--sdk')) {
    const sdk = opt('--sdk');
    if (!check('sdk path', !!sdk && existsSync(join(sdk, 'dist', 'index.js')), sdk ? `${resolve(sdk)}${existsSync(join(sdk, 'dist', 'index.js')) ? '' : ' (no dist/index.js: build it with "npm run build" in packages/bag-sdk)'}` : '--sdk <BagProtocolv2 checkout>/packages/bag-sdk is required')) ok = false;
    else {
      const receipt = join(sdk, 'dist', 'receipt.js');
      ok &= check('sdk forwarded mode', existsSync(receipt) && readFileSync(receipt, 'utf8').includes('DELIVERY_AUTHORIZATION_MISMATCH'), 'built SDK contains the forwarded-delivery verification (#126)');
      const head = git(sdk, 'rev-parse', '--short=7', 'HEAD'), dirty = git(sdk, 'status', '--porcelain', '--untracked-files=no');
      log.sdk = { path: resolve(sdk), commit: head, dirty: !!dirty };
      const want = head?.startsWith(EXPECTED_SDK_COMMIT);
      ok &= check('sdk commit', want || flag('--allow-other-sdk'), head ? `${head}${dirty ? ' (tracked changes!)' : ''}; expected ${EXPECTED_SDK_COMMIT}${!want && flag('--allow-other-sdk') ? ' (overridden)' : ''}` : 'not a git checkout', !flag('--allow-other-sdk'));
      if (dirty) ok &= check('sdk clean', false, 'the SDK checkout has tracked changes; results would not be reproducible', !flag('--allow-other-sdk'));
    }
  }
  if (['executor', 'executor-wallet'].includes(cmd)) {
    const app = opt('--app');
    const need = ['artifacts/contracts/dca/RecurringPurchaseExecutor.sol/RecurringPurchaseExecutor.json', 'artifacts/contracts/BagExecutionRouter.sol/BagExecutionRouter.json', 'packages/bag-sdk/dist/recurring.js', 'lib/dca/keeper/keeper.ts'];
    const missing = app ? need.filter(f => !existsSync(join(app, f))) : need;
    ok &= check('app build', !!app && missing.length === 0, !app ? '--app <BagProtocolv2 checkout> is required' : missing.length ? `missing in ${resolve(app)}: ${missing.join(', ')} (run "npx hardhat build" and "npm run build" in packages/bag-sdk)` : `${resolve(app)} @ ${git(app, 'rev-parse', '--short', 'HEAD') ?? '?'}`);
  }
  if (cmd === 'shadow' || (opt('--app') && !['executor', 'executor-wallet'].includes(cmd))) {
    const app = opt('--app');
    const okApp = !!app && existsSync(join(app, 'contracts', 'BagExecutionRouter.sol')) && existsSync(join(app, 'lib', 'execution', 'plan.ts'));
    ok &= check('app checkout', okApp, app ? resolve(app) : '--app <BagProtocolv2 checkout> is required');
    if (okApp) {
      ok &= check('app deps', existsSync(join(app, 'node_modules', 'solc')), existsSync(join(app, 'node_modules', 'solc')) ? 'node_modules present' : 'run "npm ci" in the app checkout');
      log.app = { path: resolve(app), commit: git(app, 'rev-parse', '--short=7', 'HEAD'), dirty: !!git(app, 'status', '--porcelain', '--untracked-files=no') };
      check('app commit', !log.app.dirty, `${log.app.commit}${log.app.dirty ? ' (tracked changes)' : ''}`, false);
    }
  }
  return !!ok;
}

// ---- Steps ----------------------------------------------------------------------------------------
function run(id, args, { cwd = here, onLine } = {}) {
  return new Promise(res => {
    say(`\n== ${id}`);
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? (process.env.HTTPS_PROXY ? '1' : undefined) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const pump = s => d => { const t = d.toString(); s.write(t); tail = (tail + t).slice(-4000); if (onLine) for (const l of t.split(/\r?\n/)) onLine(l); };
    child.stdout.on('data', pump(process.stdout)); child.stderr.on('data', pump(process.stderr));
    child.on('close', code => { const r = { id, code, seconds: Math.round((Date.now() - started) / 1000) }; log.steps.push(r); res(r); });
  });
}
function openBrowser(url) {
  if (flag('--no-open')) return;
  const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(c, a, { stdio: 'ignore', detached: true, windowsVerbatimArguments: false }).on('error', () => {}).unref(); } catch {}
}
const unitTests = () => run('unit tests', ['--test', ...readdirSync(join(here, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => join(here, 'test', f))]);
const envArgs = () => (opt('--env-file') ? ['--env-file', resolve(opt('--env-file'))] : []);

const ok = preflight();
const launcherDir = join(here, 'out', 'launcher'); mkdirSync(launcherDir, { recursive: true });
const finish = code => { log.exitCode = code; log.finishedAt = new Date().toISOString(); writeFileSync(join(launcherDir, session + '.json'), JSON.stringify(log, null, 2)); say(`\nlauncher log: ${join(launcherDir, session + '.json')}`); process.exit(code); };
if (!ok) { say('\nPreflight failed; nothing was run.'); finish(2); }
if (cmd === 'preflight') finish(0);

if (cmd === 'unit' || cmd === 'test') { const r = await unitTests(); if (r.code !== 0) finish(1); if (cmd === 'unit') finish(0); }
if (cmd === 'test' || cmd === 'wallet') {
  const out = join(here, 'wallet-fork', 'out', `${session}-${cmd}`), urlFile = resolve(opt('--url-file', join(here, 'wallet-fork', 'private', session, 'url.txt')));
  const args = [join(here, 'wallet-fork', 'run.mjs'), '--signer', cmd === 'test' ? 'test' : 'wallet', '--sdk', resolve(opt('--sdk')), '--out', out, ...envArgs(), ...(flag('--live') ? ['--mode', 'live'] : [])];
  if (cmd === 'wallet') args.push('--url-file', urlFile, '--keep-open', '600000');
  let opened = false;
  const r = await run(cmd === 'test' ? 'fork lifecycle (test key)' : 'fork lifecycle (your wallet)', args, {
    onLine: l => { if (cmd === 'wallet' && !opened && existsSync(urlFile)) { opened = true; const url = readFileSync(urlFile, 'utf8').trim(); say('\n>>> Signing page: ' + url + '\n>>> Use a NEW, EMPTY account. Four signatures; each screen shows what you sign.\n'); openBrowser(url); } } });
  log.output = out;
  say(`\nResult: ${existsSync(join(out, 'results.json')) ? join(out, 'results.json') : '(no results.json)'} (exit ${r.code}: ${['PASSED', 'FAILED', 'NOT_RUN'][r.code] ?? 'ERROR'})`);
  finish(r.code);
}
if (cmd === 'executor' || cmd === 'executor-wallet') {
  const app = resolve(opt('--app'));
  if (cmd === 'executor') {
    // One fork per phase: the public RPC keeps the fork block's state for ~10 minutes, shorter than one run of every phase.
    const phases = opt('--phase') ? [opt('--phase')] : ['lifecycle', 'registry', 'keeper'];
    const results = [];
    for (const phase of phases) {
      const out = join(here, 'executor-fork', 'out', `${session}-executor-${phase}`);
      // tsx: the keeper phase imports the app's TypeScript keeper (lib/dca/keeper)
      const r = await run(`executor fork, ${phase} (test keys)`, [join(here, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(here, 'executor-fork', 'run.mjs'), '--app', app, '--out', out, '--phase', phase, ...envArgs()], { cwd: app });
      results.push({ phase, out, code: r.code });
      say(`Result (${phase}): ${join(out, 'summary.md')} (exit ${r.code}: ${['COMPLETE', 'FATAL', 'USAGE', 'EXTERNAL', 'SCENARIO_FAILED'][r.code] ?? 'ERROR'})`);
    }
    log.output = results;
    finish(results.find(x => x.code !== 0)?.code ?? 0);
  }
  const out = join(here, 'executor-wallet', 'out', `${session}-wallet`), urlFile = resolve(opt('--url-file', join(here, 'executor-wallet', 'private', session, 'url.txt')));
  let opened = false;
  const r = await run('executor with your wallet', [join(here, 'executor-wallet', 'run.mjs'), '--app', app, '--signer', 'wallet', '--out', out, '--url-file', urlFile, '--keep-open', '600000', ...envArgs()], {
    cwd: app,
    onLine: () => { if (!opened && existsSync(urlFile)) { opened = true; const url = readFileSync(urlFile, 'utf8').trim(); say('\n>>> Signing page: ' + url + '\n>>> Use a NEW, EMPTY account on Robinhood Chain (4663). Three signatures, no transaction; each screen shows what you sign.\n'); openBrowser(url); } } });
  log.output = out;
  say(`\nResult: ${existsSync(join(out, 'results.json')) ? join(out, 'results.json') : '(no results.json)'} (exit ${r.code}: ${['COMPLETE', 'FATAL', 'USAGE (e.g. account not empty)', 'EXTERNAL', 'STEP_FAILED', 'REJECTED_IN_PAGE'][r.code] ?? 'ERROR'})`);
  finish(r.code);
}
if (cmd === 'shadow') {
  const app = resolve(opt('--app')), out = join(here, 'shadow', 'out', `${session}-shadow`);
  const pass = ['--bag', '--amounts', '--sources', '--block-mode', '--block', '--sdk', '--kyber-chain'].flatMap(n => (opt(n) ? [n, n === '--bag' || n === '--sdk' ? resolve(opt(n)) : opt(n)] : []));
  if (!opt('--bag')) pass.push('--bag', join(here, 'vendor', 'e6bdd10', 'scripts', 'research', 'dca-trial', 'fixtures', '955df6e0-b6ea-44ba-a5eb-1288a80c0a06.bag.json'));
  const tsc = join(app, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(tsc)) {
    const t = await run('typecheck shadow/measure.ts (app TypeScript)', [tsc, '--noEmit', '--skipLibCheck', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--typeRoots', join(app, 'node_modules', '@types'), '--types', 'node', join(here, 'shadow', 'measure.ts')]);
    if (t.code !== 0) finish(1);
  }
  const r = await run('shadow measurement', [join(here, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(here, 'shadow', 'measure.ts'), '--app', app, '--out', out, ...pass, ...envArgs()], { cwd: app });
  log.output = out;
  say(`\nResult: ${join(out, 'summary.md')} (exit ${r.code}: ${['COMPLETE', 'FATAL', 'USAGE', 'INCOMPLETE', 'BASKET_FAILED'][r.code] ?? 'ERROR'})`);
  finish(r.code);
}
