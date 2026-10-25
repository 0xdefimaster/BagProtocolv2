#!/usr/bin/env node
// Writes manifest.json for the closing delivery. It contains public commits, file hashes, tool versions,
// chain blocks and fork changes only. Before writing, it refuses if any signature from
// wallet-fork/private/*/signatures.json or any value from --env-file appears in the output.
//   node tools/manifest.mjs --evidence results/closing-2026-10-25 --sdk <bag-sdk dir> --app <app checkout>
//     [--code-commit <sha>] [--v5-zip <file>] [--node24-tarball-sha256 <hex>] [--env-file <f>]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const sha = b => createHash('sha256').update(b).digest('hex');
const fileSha = f => sha(readFileSync(f));
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }); return r.status === 0 ? r.stdout.trim() : null; };
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const dirSha = d => sha(walk(d).sort().map(f => `${relative(d, f).replaceAll('\\', '/')}:${fileSha(f)}`).join('\n'));
const version = p => { try { return JSON.parse(readFileSync(join(here, 'node_modules', ...p.split('/'), 'package.json'), 'utf8')).version; } catch { return null; } };

const evidenceDir = resolve(arg('--evidence', join(here, 'results', 'closing-2026-10-25')));
const sdk = arg('--sdk') && resolve(arg('--sdk')), app = arg('--app') && resolve(arg('--app'));
const repoRoot = git(here, 'rev-parse', '--show-toplevel');
const pkgRel = relative(repoRoot, here).replaceAll('\\', '/');
const head = git(here, 'rev-parse', 'HEAD'), codeCommit = arg('--code-commit') ?? head;

// Code files must be byte-identical to the commit the evidence ran on (docs and results may differ).
const tracked = git(here, 'ls-files').split('\n').filter(Boolean);
const isCode = f => /\.(mjs|ts|sol|json|cmd|html|css|js)$/.test(f) && !f.startsWith('results/') && f !== 'manifest.json' && !f.startsWith('vendor/');
const codeDrift = codeCommit === head ? [] : tracked.filter(isCode).filter(f => {
  const then = spawnSync('git', ['-C', here, 'show', `${codeCommit}:${pkgRel}/${f}`], { maxBuffer: 64 << 20 });
  return then.status !== 0 || sha(then.stdout) !== fileSha(join(here, f));
});

const evidence = [];
for (const f of existsSync(evidenceDir) ? walk(evidenceDir) : []) {
  if (!f.endsWith('results.json')) continue;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const e = { path: relative(here, f).replaceAll('\\', '/'), sha256: fileSha(f), schema: r.schema };
  if (r.schema === 'bag-dca-wallet-fork/v1') Object.assign(e, { class: r.evidence, signer: r.signer, mode: r.mode, walletClient: r.walletClient ?? null, status: r.status, summary: r.summary, startedAt: r.startedAt, finishedAt: r.finishedAt,
    forks: r.forks.map(x => ({ label: x.label, block: x.block, localTransactions: x.localTx?.sent, changes: x.changes })), inputs: r.inputs, compiler: r.compiler, relay: r.relayFinal ?? r.relay, owner: r.owner, smartAccount: r.smartAccount?.address,
    signatures: (r.signatures ?? []).map(s => ({ id: s.id, class: s.class, digest: s.digest, signatureSha256: s.signatureSha256 })) });
  if (r.schema === 'bag-shadow-measure/v2') Object.assign(e, { class: 'FORK_DIRECT_EXECUTION (on-chain sources, existing router)', exit: r.exit, blockMode: r.blockMode, startedAt: r.startedAt, finishedAt: r.finishedAt,
    forks: r.forks.map(x => ({ label: x.label, blockNumber: x.blockNumber, blockHash: x.blockHash, localTransactions: x.localTransactions, changes: x.changes })), relay: r.relay, sourceHashes: r.sourceHashes, statusCounts: r.statusCounts, routerDca: { status: r.routerDca?.status, closed: r.routerDca?.closed },
    baskets: r.runs.map(x => ({ amountUsdg: x.amountUsdg, status: x.basket?.status, stage: x.basket?.stage, txHash: x.basket?.txHash, gate: x.basketGate?.decision })),
    // the measurement records the hashes of the code it ran; compare them with this checkout
    sourceHashesMatchHead: Object.fromEntries(Object.entries(r.sourceHashes ?? {}).map(([k, h]) => [k, k.includes('(app)') ? (app ? fileSha(join(app, 'contracts', 'BagExecutionRouter.sol')) === h : null)
      : fileSha(join(here, { 'measure.ts': 'shadow/measure.ts', 'ShadowAdapters.sol': 'shadow/contracts/ShadowAdapters.sol' }[k] ?? k)) === h])) });
  evidence.push(e);
}

const manifest = {
  schema: 'bag-dca-closing-manifest/v1', generatedAt: new Date().toISOString(),
  secrets: 'none: no API key, RPC credential, private key or usable user signature (signatures appear only as sha256; the generator checks)',
  repository: { remote: git(here, 'remote', 'get-url', 'origin')?.replace(/\/\/[^@/]*@/, '//'), branch: git(here, 'rev-parse', '--abbrev-ref', 'HEAD'), head, package: pkgRel,
    evidenceCodeCommit: codeCommit, codeFilesChangedSinceEvidenceCommit: codeDrift,
    dirty: (git(here, 'status', '--porcelain', '--', '.') || '').split('\n').filter(Boolean),
    appCodeTouchedVsMain: (git(here, 'diff', '--name-only', 'origin/main', 'HEAD', '--', ':!research') || '').split('\n').filter(Boolean) },
  baseline: {
    verifiedAt: '2026-10-25', method: 'git ls-remote origin main; GitHub REST pulls/{n} head.sha, draft, merged_at',
    main: '82b3b2926da467e3530eba0c9f6c38452d8511ab',
    pr125_fixture: { head: 'e6bdd1057f4cb68d492e2c503736d7e30d24b0c0', draft: true, merged: false },
    pr126_sdk_forwarded: { head: '3f85a4cf80e6d9cc4289d6d074fc7e000e0737ef', draft: true, merged: false },
    pr127_sdk_negative_impact: { head: '616f49fc9d14c816809777608b17176af26dc8e0', draft: true, merged: false },
    integration_126_127: 'dadef000f9679cad9dbd2e13ce40b14a4310274e',
    v5ZipSha256: arg('--v5-zip') && existsSync(arg('--v5-zip')) ? fileSha(arg('--v5-zip')) : '21269784d4cb086208e8b6660887f5d7e13caca24a226dc92d1fc2380a37f821 (from the closing package; file not re-hashed)',
  },
  sdk: sdk ? { path: '<integration worktree>/packages/bag-sdk', commit: git(sdk, 'rev-parse', 'HEAD'), trackedChanges: !!git(sdk, 'status', '--porcelain', '--untracked-files=no'),
    distSha256: dirSha(join(sdk, 'dist')), receiptJsSha256: fileSha(join(sdk, 'dist', 'receipt.js')), defaultVerifyPurchaseReceiptChangedInThisDelivery: false } : null,
  app: app ? { path: '<BagProtocolv2 checkout>', commit: git(app, 'rev-parse', 'HEAD'), trackedChanges: !!git(app, 'status', '--porcelain', '--untracked-files=no'),
    files: Object.fromEntries(['contracts/BagExecutionRouter.sol', 'lib/execution/plan.ts', 'lib/domain/basket-protocol/deposit/allocation.ts', 'lib/domain/basket-protocol/deposit/execution-plan.ts'].map(f => [f, fileSha(join(app, f))])),
    solc: JSON.parse(readFileSync(join(app, 'node_modules', 'solc', 'package.json'), 'utf8')).version, typescript: JSON.parse(readFileSync(join(app, 'node_modules', 'typescript', 'package.json'), 'utf8')).version } : null,
  tools: { nodeUsedForEvidence: 'v24.22.0 (official linux-x64 tarball' + (arg('--node24-tarball-sha256') ? `, sha256 ${arg('--node24-tarball-sha256')}` : '') + '); development runs also on v22.22.0',
    manifestGeneratorNode: process.version, packageLockSha256: fileSha(join(here, 'package-lock.json')),
    pinned: Object.fromEntries(['hardhat', 'viem', 'solc', 'tsx', '@metamask/smart-accounts-kit', 'playwright'].map(p => [p, version(p)])),
    playwright: 'container-provided (not in package-lock); used only by wallet-fork/page-e2e.mjs' },
  network: { chainId: 4663, rpc: 'public https://rpc.mainnet.chain.robinhood.com (non-archive: state ~500k blocks old is pruned)', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    pins: JSON.parse(readFileSync(join(here, 'lib', 'pins.json'), 'utf8')) },
  deployments: { publicNetwork: 'none', forkOnly: 'see evidence[].forks[].changes (setCode/setBalance/impersonation) and the fork-local deployments named in each report' },
  sources: Object.fromEntries(tracked.filter(f => f !== 'manifest.json' && !f.startsWith('results/')).map(f => [f, fileSha(join(here, f))])),
  evidence,
};

// Refuse to write anything that contains a usable signature or an env value.
const text = JSON.stringify(manifest, null, 2);
const privateRoot = join(here, 'wallet-fork', 'private');
const secrets = [];
if (existsSync(privateRoot)) for (const f of walk(privateRoot).filter(f => f.endsWith('signatures.json'))) for (const it of JSON.parse(readFileSync(f, 'utf8')).items ?? []) secrets.push(it.signature.slice(2).toLowerCase());
if (arg('--env-file') && existsSync(arg('--env-file'))) for (const l of readFileSync(arg('--env-file'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*[A-Z0-9_]+\s*=\s*['"]?([^'"\s]{8,})/); if (m) secrets.push(m[1].toLowerCase()); }
const leak = secrets.find(s => text.toLowerCase().includes(s));
if (leak) { console.error('REFUSED: the manifest would contain a private signature or env value'); process.exit(1); }
writeFileSync(join(here, 'manifest.json'), text + '\n');
console.log(`manifest.json written: ${evidence.length} evidence file(s), ${Object.keys(manifest.sources).length} source hashes, code drift since ${codeCommit.slice(0, 7)}: ${codeDrift.length ? codeDrift.join(', ') : 'none'}; checked against ${secrets.length} private value(s)`);
