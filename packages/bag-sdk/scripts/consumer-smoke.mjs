// Packs the SDK (npm pack), installs the tarball in a fresh temporary project with only its peers
// (viem, @lifi/composer-sdk) and TypeScript, then imports every entry point from plain Node ESM and
// typechecks a TypeScript consumer (NodeNext, skipLibCheck off). Run `npm run build` first.
// The provider is a local stub: this checks the PACKAGE, not LI.FI (see examples/live-compile.ts).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Run via npm run smoke:consumer.');
const fixture = join(pkgDir, 'test', 'fixtures', 'feetest.v1.bag.json');
const dir = mkdtempSync(join(tmpdir(), 'bag-sdk-consumer-'));
const node = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const npm = (args, cwd) => node([npmCli, ...args], cwd);

try {
  npm(['pack', '--ignore-scripts', '--pack-destination', dir], pkgDir);
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  copyFileSync(fixture, join(dir, 'feetest.bag.json'));
  const require = createRequire(import.meta.url);
  const schemaPath = require.resolve('@bagprotocol/sdk/schema');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  if (schema.$id !== 'https://bagprotocol.com/schemas/bag-sdk.v1.json') throw new Error('SDK JSON Schema export is missing or invalid');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', `./${tarball}`, 'viem@2.56.0', '@lifi/composer-sdk@0.11.3', 'typescript@5.9.3'], dir);

  writeFileSync(
    join(dir, 'consumer.mjs'),
    `import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseBag, validateBag, hashBag, compileBag, verifyPurchaseReceipt, NATIVE_TOKEN, registryStrategyId, STRATEGY_REGISTRY_DEPLOYMENTS } from '@bagprotocol/sdk';
import { lifiComposer, resolveLifiComposerAccount } from '@bagprotocol/sdk/lifi';
import { fetchBag } from '@bagprotocol/sdk/http';
import { readTokenDecimals, withReceiptEvidence } from '@bagprotocol/sdk/evm';

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
const receiptHash = '0x' + '1'.repeat(64);
const blockHash = '0x' + '2'.repeat(64);
const { keccak256 } = await import('viem');
const transferEvent = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const addressWord = (address) => '0x' + address.slice(2).padStart(64, '0');
const receiptClient = {
  async getChainId() { return compiled.transaction.chainId; },
  async getTransaction() {
    return { hash: receiptHash, from: compiled.quote.plan.signer, to: compiled.transaction.to,
      input: compiled.transaction.data, value: compiled.transaction.value, chainId: compiled.transaction.chainId,
      blockHash, blockNumber: 10n };
  },
  async getTransactionReceipt() {
    return { transactionHash: receiptHash, blockHash, blockNumber: 10n, from: compiled.quote.plan.signer,
      to: compiled.transaction.to, status: 'success', logs: compiled.quote.plan.legs.map((leg, i) => ({
        address: leg.token, topics: [transferEvent, addressWord(ROUTER), addressWord(compiled.quote.plan.signer)],
        data: '0x' + (10n).toString(16).padStart(64, '0'), logIndex: i,
        transactionHash: receiptHash, blockHash, blockNumber: 10n, removed: false,
      })) };
  },
  async getBlock() { return { hash: blockHash }; },
  async getBlockNumber() { return 12n; },
  async getPurchaseBalanceChanges(context) {
    return { ...context, scope: 'TRANSACTION', balances: context.tokens.map(token => ({ token, beforeRaw: 0n, afterRaw: 10n })) };
  },
};
const verified = await verifyPurchaseReceipt(compiled, {
  client: receiptClient, transactionHash: receiptHash, confirmations: 3,
  minimumReceived: compiled.quote.plan.legs.map(leg => ({ token: leg.token, amountRaw: 9n })),
});
assert.equal(verified.status, 'VERIFIED');
assert.equal(verified.confirmations, 3n);
assert.equal(verified.keptBalanceVerified, false);
assert.equal(verified.evidence, 'TRANSACTION_AND_BALANCE_DELTAS');
assert.equal(verified.outputs[0].balanceDeltaRaw, 10n);
const nitroClient = withReceiptEvidence({ ...receiptClient, async request({ method, params }) {
  if (method === 'web3_clientVersion') return 'nitro/v3.12.1+70fa99a-20260929T140226Z/linux-amd64/go1.25.12';
  if (method === 'eth_getBlockByHash') return { hash: blockHash, number: '0xa', parentHash: '0x' + '3'.repeat(64), transactions: [receiptHash, '0x' + '4'.repeat(64)] };
  if (method === 'eth_getTransactionReceipt') return { transactionHash: receiptHash, blockHash, blockNumber: '0xa', transactionIndex: '0x0' };
  if (method === 'debug_traceCall') return { type: 'CALL', from: params[0].from, to: params[0].to, input: params[0].data, output: '0x' + (params[2].txIndex === '0x0' ? 0n : 10n).toString(16).padStart(64, '0') };
  throw new Error('Unexpected receipt RPC method');
} }, { balanceState: 'ROBINHOOD_NITRO_TRANSACTION_INDEX' });
const nitroVerified = await verifyPurchaseReceipt(compiled, {
  client: nitroClient, transactionHash: receiptHash,
  minimumReceived: compiled.quote.plan.legs.map(leg => ({ token: leg.token, amountRaw: 9n })),
});
assert.equal(nitroVerified.status, 'VERIFIED');
assert.equal(nitroVerified.balanceScope, 'TRANSACTION');
assert.equal(nitroVerified.outputs[0].balanceDeltaRaw, 10n);
const account = await resolveLifiComposerAccount({ chainId: 4663, signer: compiled.quote.plan.signer,
  deployment: { chainId: 4663, factory: ROUTER, factoryCodeHash: keccak256('0x6000') },
  client: { getChainId: async () => 4663, getBlockNumber: async () => 10n, getBlock: async () => ({ hash: blockHash }),
    getCode: async ({ address }) => address === ROUTER ? '0x6000' : undefined,
    readContract: async () => '0x' + '8'.repeat(40),
  },
});
assert.deepEqual(account.trust.allowedTransactionTargets, [ROUTER]);
assert.deepEqual(account.trust.allowedApprovalSpenders, ['0x' + '8'.repeat(40)]);
assert.equal(typeof lifiComposer({ apiKey: 'fixture-only', baseUrl: 'https://composer.test', account }).compile, 'function');

for (const f of [lifiComposer, fetchBag, readTokenDecimals, withReceiptEvidence]) assert.equal(typeof f, 'function');
console.log('consumer.mjs: OK');
`
  );
  writeFileSync(
    join(dir, 'consumer.ts'),
    `import { hashBag, parseBag, STRATEGY_REGISTRY_DEPLOYMENTS, type PurchasePlan, type StrategyRegistryDeployment, type PurchaseReceiptClient, verifyPurchaseReceipt } from '@bagprotocol/sdk';
import { lifiComposer, resolveLifiComposerAccount } from '@bagprotocol/sdk/lifi';
import { fetchBag } from '@bagprotocol/sdk/http';
import { readTokenDecimals, withReceiptEvidence } from '@bagprotocol/sdk/evm';
import { createPublicClient, http } from 'viem';
const publicClient = createPublicClient({ transport: http('http://127.0.0.1:8545') });
const receiptClient: PurchaseReceiptClient = publicClient;
const evidenceClient: PurchaseReceiptClient = withReceiptEvidence(publicClient);
const nitroClient: PurchaseReceiptClient = withReceiptEvidence(publicClient, { balanceState: 'ROBINHOOD_NITRO_TRANSACTION_INDEX' });
const verifyReceipt = verifyPurchaseReceipt;
const resolveAccount = (deployment: Parameters<typeof resolveLifiComposerAccount>[0]['deployment'], signer: Parameters<typeof resolveLifiComposerAccount>[0]['signer']) => resolveLifiComposerAccount({ chainId: deployment.chainId, signer, deployment, client: publicClient });
void [receiptClient, evidenceClient, nitroClient, verifyReceipt, resolveAccount];
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

  process.stdout.write(node(['consumer.mjs'], dir));
  node([join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], dir);
  console.log('consumer.ts: typechecks (NodeNext, skipLibCheck off)');
  console.log(`consumer-smoke: OK (${tarball})`);
} finally {
  const target = resolve(dir);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('bag-sdk-consumer-')) throw new Error('Refusing cleanup outside the disposable consumer directory.');
  rmSync(target, { recursive: true, force: true });
}
