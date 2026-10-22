// Candidate preparation only. No publish, signing, private-key access or transaction submission.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Run via npm run release:check.');
const npm = (args, capture = false) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd: dir, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8',
});
const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'candidate';
if (!['candidate', 'package'].includes(mode)) throw new Error('Mode must be candidate or package.');
const outArg = args[args.indexOf('--out') + 1];
if (!args.includes('--out') || !outArg || !isAbsolute(outArg)) throw new Error('Supply --out with an absolute new artifact directory.');
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const gates = JSON.parse(readFileSync(join(dir, 'release-gates.json'), 'utf8'));
if (Number(process.versions.node.split('.')[0]) < 24 || !/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version !== gates.candidateVersion) throw new Error('Runtime/candidate version mismatch.');
if (pkg.publishConfig?.access !== 'public' || pkg.engines?.node !== '>=24') throw new Error('Public package metadata is incomplete.');
if (existsSync(join(out, 'candidate-report.json')) || existsSync(join(out, 'bagprotocol-sdk-' + pkg.version + '.tgz'))) throw new Error('Use a new artifact directory.');
// Ongoing package CI must remain useful after this version is published. Only release-candidate
// preparation queries the registry and requires an unused version; package mode cannot approve release.
const registry = mode === 'candidate' ? JSON.parse(npm(['view', '@bagprotocol/sdk', 'versions', 'dist-tags', 'dist.integrity', 'gitHead', '--json', '--registry=https://registry.npmjs.org'], true)) : null;
if (registry?.versions?.includes(pkg.version)) throw new Error('Candidate version is already published. Choose a new version.');
npm(['run', 'build']);
const skipConsumers = process.env.SDK_RELEASE_SKIP_CONSUMERS === '1';
if (!skipConsumers) {
  npm(['run', 'smoke:consumer']);
  npm(['run', 'smoke:starter']);
}
const manifest = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', out], true))[0];
if (!manifest || manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error('Packed identity differs from candidate.');
const paths = new Set(manifest.files.map(file => file.path));
const allowed = path => ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'schema/bag.v1.schema.json'].includes(path) || /^dist\/[A-Za-z0-9_/-]+\.(?:js|d\.ts)$/.test(path);
if ([...paths].some(path => !allowed(path))) throw new Error('Tarball contains an unexpected file.');
const exportedFiles = [];
const collect = value => { if (typeof value === 'string') exportedFiles.push(value.replace(/^\.\//, '')); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
collect(pkg.exports);
for (const path of [...exportedFiles, 'README.md', 'LICENSE', 'CHANGELOG.md']) if (!paths.has(path)) throw new Error('Tarball is missing a public export or release document.');
const archive = readFileSync(join(out, manifest.filename));
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
if (manifest.integrity !== integrity) throw new Error('Archive integrity differs from npm pack.');
const gateNames = ['factoryPolicyConfirmed', 'deploymentPinApproved', 'liveOriginalPurchaseVerified', 'publicationApproved'];
const openGates = gateNames.filter(name => gates[name] !== true);
const source = process.env.SDK_RELEASE_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? null;
if (source !== null && !/^[0-9a-fA-F]{40}$/.test(source)) throw new Error('Invalid source identifier.');
const report = {
  status: mode === 'candidate' ? 'CANDIDATE_CHECKS_PASSED' : 'PACKAGE_CHECKS_PASSED', mode, candidateVersion: pkg.version, generatedAt: new Date().toISOString(),
  node: process.version, sourceCommit: source, sourceIdentity: source ? 'CALLER_PROVIDED' : 'NOT_SUPPLIED',
  publicNpmObservation: registry, versionAvailability: mode === 'candidate' ? 'AVAILABLE_AT_CHECK_TIME' : 'NOT_CHECKED',
  consumerChecks: skipConsumers ? 'SKIPPED_IN_THIS_COMMAND' : 'PASSED_FRESH_INSTALLS',
  package: { filename: manifest.filename, files: [...paths].sort(), sha256: createHash('sha256').update(archive).digest('hex'), integrity, bytes: archive.length },
  releaseReady: mode === 'candidate' && !skipConsumers && source !== null && openGates.length === 0,
  openGates, signedOrSubmitted: false, published: false,
};
writeFileSync(join(out, 'candidate-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
