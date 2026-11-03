// Run via npm run smoke:published-quickstart. Installs the PUBLISHED SDK from the npm registry (not this
// source tree) into a disposable directory and runs the starter's quickstart against it. Proves the
// quickstart works for a developer who only runs `npm install @bagprotocol/sdk`. Network: npm registry only.
//
//   SDK_PUBLISHED_VERSION=0.3.0 (default) npm run smoke:published-quickstart
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same frozen value as starter-smoke.mjs: bag.json v1 hash rules do not change between SDK versions.
const QUICKSTART_HASH = '0xe20192732fcf93465060bbcd43512fcb06cd486f37a939c2ff4801c88eebdad3';
const version = process.env.SDK_PUBLISHED_VERSION ?? '0.3.0';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('SDK_PUBLISHED_VERSION must be an exact version.');
const starter = fileURLToPath(new URL('../../../examples/sdk-consumer/', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Run via npm run smoke:published-quickstart.');
const viemVersion = JSON.parse(readFileSync(join(starter, 'package.json'), 'utf8')).dependencies.viem;
const dir = mkdtempSync(join(tmpdir(), 'bag-sdk-published-'));
try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bag-published-quickstart', private: true, type: 'module' }));
  for (const f of ['quickstart.mjs', 'bag.example.json']) copyFileSync(join(starter, f), join(dir, f));
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@bagprotocol/sdk@${version}`, `viem@${viemVersion}`], { cwd: dir, stdio: 'inherit' });
  const installed = JSON.parse(readFileSync(join(dir, 'node_modules/@bagprotocol/sdk/package.json'), 'utf8')).version;
  if (installed !== version) throw new Error(`Installed ${installed}, expected ${version}.`);
  const quick = JSON.parse(execFileSync(process.execPath, ['quickstart.mjs'], { cwd: dir, encoding: 'utf8' }));
  if (quick.status !== 'VALID' || quick.definitionHash !== QUICKSTART_HASH || !quick.hashMatchesValidation) throw new Error('Quickstart result differs.');
  console.log(JSON.stringify({ status: 'PASS', sdkVersion: installed, dependencySource: 'NPM_REGISTRY', node: process.version, definitionHash: quick.definitionHash, network: 'NPM_REGISTRY_ONLY', signedOrSubmitted: false }));
} finally {
  const target = resolve(dir);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('bag-sdk-published-')) throw new Error('Refusing cleanup outside the disposable directory.');
  rmSync(target, { recursive: true, force: true });
}
