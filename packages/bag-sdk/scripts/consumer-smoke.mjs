// Packs the SDK (npm pack), installs the tarball in a fresh temporary project with only its peers
// (viem, @lifi/composer-sdk) and TypeScript, then imports every entry point from plain Node ESM and
// typechecks a TypeScript consumer (NodeNext, skipLibCheck off). Run `npm run build` first.
// The provider is a local stub: this checks the PACKAGE, not LI.FI (see examples/live-compile.ts).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(pkgDir, 'test', 'fixtures', 'feetest.v1.bag.json');
const dir = mkdtempSync(join(tmpdir(), 'bag-sdk-consumer-'));
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }).toString();

try {
  sh('npm', ['pack', '--pack-destination', dir], pkgDir);
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  copyFileSync(fixture, join(dir, 'feetest.bag.json'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  sh('npm', ['install', '--no-audit', '--no-fund', `./${tarball}`, 'viem@^2', '@lifi/composer-sdk@0.11.3', 'typescript@5'], dir);

  writeFileSync(
    join(dir, 'consumer.mjs'),
    `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseBag, validateBag, hashBag, compileBag, NATIVE_TOKEN, registryStrategyId, STRATEGY_REGISTRY_DEPLOYMENTS } from '@bagprotocol/sdk';
import { lifiComposer } from '@bagprotocol/sdk/lifi';
import { fetchBag } from '@bagprotocol/sdk/http';
import { readTokenDecimals } from '@bagprotocol/sdk/evm';

const schemaPath = fileURLToPath(import.meta.resolve('@bagprotocol/sdk/schema.json'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
assert.equal(schema.$id, 'https://bagprotocol.com/schemas/bag.v1.json');
assert.deepEqual(schema.required, ['bagJson', 'definition']);

const parsed = parseBag(readFileSync('./feetest.bag.json', 'utf8'));
assert.ok(parsed.ok, JSON.stringify(parsed.issues));
assert.equal(validateBag(parsed.bag).valid, true);
assert.equal(hashBag(parsed.bag), parsed.bag.definitionHash);
assert.equal(registryStrategyId('0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46', parsed.bag.ref.strategyId), '0x2518fc2191cd250b9dea7fec6c4e8a6c31e897881255cd5ef0af4dbe085f0326');
assert.deepEqual(STRATEGY_REGISTRY_DEPLOYMENTS.robinhood, { chainId: 4663, address: '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8', deployedAtBlock: 85332074 });

const ROUTER = '0x' + '7'.repeat(40);
const stub = { name: 'stub', async compile(q) {
  return { transaction: { to: ROUTER, data: '0x12345678', value: String(q.amountRaw), chainId: q.chainId }, executor: null, approvals: [],
    legs: q.legs.map((l) => ({ token: l.token, expectedOutRaw: '10', minOutRaw: '9' })), priceImpactBps: 5, gasLimit: null, fees: [] };
} };
const amountRaw = 1000000000000000n;
const compiled = await compileBag(parsed.bag, { inputToken: NATIVE_TOKEN, amountRaw, signer: '0x' + '5'.repeat(40) },
  { provider: stub, trust: { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] } });
assert.equal(compiled.quote.plan.inputKind, 'native');
assert.equal(compiled.transaction.value, amountRaw);
assert.deepEqual(compiled.approvals, []);
for (const f of [lifiComposer, fetchBag, readTokenDecimals]) assert.equal(typeof f, 'function');
console.log('consumer.mjs: OK');
`
  );
  writeFileSync(
    join(dir, 'consumer.ts'),
    `import { hashBag, parseBag, STRATEGY_REGISTRY_DEPLOYMENTS, type PurchasePlan, type StrategyRegistryDeployment } from '@bagprotocol/sdk';
import { lifiComposer } from '@bagprotocol/sdk/lifi';
import { fetchBag } from '@bagprotocol/sdk/http';
import { readTokenDecimals } from '@bagprotocol/sdk/evm';
const d: StrategyRegistryDeployment | undefined = STRATEGY_REGISTRY_DEPLOYMENTS.robinhood;
const kind: PurchasePlan['inputKind'] = 'native';
const r = parseBag('{}');
if (r.ok) hashBag(r.bag);
void [d, kind, lifiComposer, fetchBag, readTokenDecimals];
`
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: [] }, files: ['consumer.ts'] })
  );

  process.stdout.write(sh('node', ['consumer.mjs'], dir));
  sh('npx', ['tsc', '-p', 'tsconfig.json'], dir);
  console.log('consumer.ts: typechecks (NodeNext, skipLibCheck off)');
  console.log(`consumer-smoke: OK (${tarball})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
