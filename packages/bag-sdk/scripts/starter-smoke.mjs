// Run via npm run smoke:starter. Builds/installs only the SDK tarball and this independent consumer.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const QUICKSTART_HASH = '0xe20192732fcf93465060bbcd43512fcb06cd486f37a939c2ff4801c88eebdad3';
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Run via npm run smoke:starter.');
const dir = mkdtempSync(join(tmpdir(), 'bag-sdk-starter-'));
const project = join(dir, 'consumer');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' });
try {
  cpSync(resolve(pkg, '../../examples/sdk-consumer'), project, { recursive: true, filter: path => !['node_modules', 'dist'].includes(basename(path)) });
  npm(['pack', '--pack-destination', dir, '--ignore-scripts'], pkg);
  const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'));
  if (!tarball) throw new Error('SDK tarball missing.');
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...(process.env.SDK_STARTER_OFFLINE === '1' ? ['--offline'] : []), join(dir, tarball)], project);
  const installed = JSON.parse(readFileSync(join(project, 'node_modules/@bagprotocol/sdk/package.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  if (installed.version !== expected.version) throw new Error('Installed SDK differs from candidate.');
  const installedRoot = realpathSync(join(project, 'node_modules/@bagprotocol/sdk'));
  if (!installedRoot.startsWith(realpathSync(project) + sep)) throw new Error('SDK resolved outside the independent installation.');
  npm(['run', 'build'], project);
  npm(['run', 'demo'], project);
  // The quickstart's frozen definition hash for bag.example.json (bag.json v1 hash rules are frozen).
  const quick = JSON.parse(execFileSync(process.execPath, ['quickstart.mjs'], { cwd: project, encoding: 'utf8' }));
  if (quick.status !== 'VALID' || quick.definitionHash !== QUICKSTART_HASH || !quick.hashMatchesValidation) throw new Error('Quickstart result changed.');
  const report = { status: 'PASS', sdkVersion: installed.version, node: process.version,
    dependencySource: 'SDK_TARBALL', consumerTypes: 'NODE_NEXT_STRICT', demonstration: 'SYNTHETIC_ONLY', quickstartHash: quick.definitionHash,
    signedOrSubmitted: false };
  if (process.env.SDK_STARTER_REPORT) writeFileSync(process.env.SDK_STARTER_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  const target = resolve(dir);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('bag-sdk-starter-')) throw new Error('Refusing cleanup outside the disposable starter directory.');
  rmSync(target, { recursive: true, force: true });
}
