// Read-only synthetic receipt fixtures. This does not execute a blockchain transaction.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('C:/Users/ilife/Documents/Codex/2026-10-21/bag');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const repo = resolve(arg('--sdk-repo', join(root, 'work/bag-claude-sdk126')));
const outputFile = resolve(arg('--out', join(root, 'outputs/DCA-SDK126-Canli-2026-10-24/spending-probe.json')));
const sdk = await import(pathToFileURL(join(repo, 'packages/bag-sdk/dist/index.js')));
const hex = (digit, length) => '0x' + digit.repeat(length);
const PLAN = hex('5', 40), SOURCE = hex('a', 40), RECIPIENT = hex('b', 40);
const KEEPER = hex('d', 40), ROUTER = hex('7', 40), INPUT = hex('c', 40);
const HASH = hex('1', 64), BLOCK = hex('2', 64), RUN = '0xabcdef01';
const parsed = sdk.parseBag(JSON.parse(readFileSync(join(repo, 'packages/bag-sdk/test/fixtures/external.bag.json'), 'utf8')));
assert(parsed.ok);
const compiled = await sdk.compileBag(parsed.bag, { inputToken: INPUT, amountRaw: 10_000_000n,
  inputTokenDecimals: 6, signer: PLAN }, {
  provider: { name: 'synthetic-review-fixture', async compile(request) {
    return { transaction: { to: ROUTER, data: '0x12345678', value: '0', chainId: request.chainId },
      executor: null, approvals: [], priceImpactBps: 1, gasLimit: null, fees: [],
      legs: request.legs.map(leg => ({ token: leg.token, expectedOutRaw: '1000', minOutRaw: '990' })) };
  } }, trust: { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] },
});
const plan = compiled.quote.plan;
const outputs = plan.legs.map(leg => leg.token.toLowerCase());
const minimumReceived = outputs.map(token => ({ token, amountRaw: 80n }));
const transaction = { hash: HASH, from: KEEPER, to: PLAN, input: RUN, value: 0n,
  chainId: 4663, blockHash: BLOCK, blockNumber: 10n };
const receipt = { transactionHash: HASH, from: KEEPER, to: PLAN, blockHash: BLOCK,
  blockNumber: 10n, status: 'success', logs: [] };
const cases = [];
for (const [name, debit] of [['exact', plan.swapAmountRaw], ['half', plan.swapAmountRaw / 2n],
  ['zero', 0n], ['net-credit', -100n], ['excess', plan.swapAmountRaw + 1n]]) {
  const balances = {
    [PLAN]: Object.fromEntries([...outputs, INPUT].map(t => [t, [0n, 0n]])),
    [SOURCE]: { ...Object.fromEntries(outputs.map(t => [t, [0n, 0n]])),
      [INPUT]: [plan.amountRaw * 2n, plan.amountRaw * 2n - debit] },
    [RECIPIENT]: { ...Object.fromEntries(outputs.map(t => [t, [0n, 100n]])), [INPUT]: [0n, 0n] },
  };
  const client = {
    getChainId: async () => 4663,
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: BLOCK, transactions: [HASH] }),
    getBlockNumber: async () => 12n,
    tracePurchaseCall: async () => ({ transactionHash: HASH, blockHash: BLOCK,
      call: { type: 'CALL', from: KEEPER, to: PLAN, input: RUN, value: '0x0',
        calls: [{ type: 'CALL', from: PLAN, to: ROUTER, input: compiled.transaction.data, value: '0x0' }] } }),
    getPurchaseBalanceChanges: async ctx => ({ ...ctx, scope: 'SINGLE_TRANSACTION_BLOCK',
      balances: ctx.tokens.map(token => ({ token, beforeRaw: balances[ctx.owner][token][0],
        afterRaw: balances[ctx.owner][token][1] })) }),
    readDeliveryAuthorization: async ctx => ({ ...ctx, fundingSource: SOURCE, recipient: RECIPIENT }),
  };
  const result = await sdk.verifyPurchaseReceipt(compiled, { client, transactionHash: HASH,
    minimumReceived, delivery: { caller: PLAN, fundingSource: SOURCE, recipient: RECIPIENT } });
  cases.push({ name, plannedSwapRaw: plan.swapAmountRaw, requestedFixtureDebitRaw: debit,
    observedStatus: result.status, spentInputRaw: result.spentInputRaw, issues: result.issues });
}
assert.equal(cases[0].observedStatus, 'VERIFIED');
assert.equal(cases[4].observedStatus, 'FAILED');
for (const c of cases.slice(1, 4)) { assert.equal(c.observedStatus, 'FAILED'); assert(c.issues.some(i => i.code === 'INPUT_SPEND_BELOW_PLAN')); }
const output = { scope: 'SYNTHETIC_RECEIPT_FIXTURE_NOT_A_FORK_OR_MAINNET_EXPLOIT',
  sdkCommit: '3f85a4cf80e6d9cc4289d6d074fc7e000e0737ef',
  finding: 'Independent exact-debit regression probe on the fixed SDK. Underfunding and net credits must be rejected.',
  implementationReference: 'packages/bag-sdk/src/receipt.ts:435-441',
  policyDecision: 'The fixed opt-in mode enforces exact swapped-share funding. The default mode remains a maximum-debit check.',
  cases };
mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile,
  JSON.stringify(output, (_k, value) => typeof value === 'bigint' ? value.toString() : value, 2));
console.log(JSON.stringify(output, (_k, value) => typeof value === 'bigint' ? value.toString() : value, 2));


