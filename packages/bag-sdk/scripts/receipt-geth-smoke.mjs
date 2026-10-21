// Optional integration check against a disposable, explicitly started Geth 1.16 dev node.
// Local transactions only. Never point this script at a funded/public network.
// Build SDK first, then: node packages/bag-sdk/scripts/receipt-geth-smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from 'viem';
import { compileBag, parseBag, NATIVE_TOKEN, verifyPurchaseReceipt } from '../dist/index.js';
import { withReceiptEvidence } from '../dist/adapters/evm.js';

const url = process.env.SDK_GETH_DEV_RPC ?? 'http://127.0.0.1:8547';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Local dev RPC only');
const chain = defineChain({ id: 1337, name: 'Disposable Geth dev', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url), pollingInterval: 100 });
assert.equal(await client.getChainId(), 1337);
assert.match(await client.request({ method: 'web3_clientVersion' }), /^Geth\/v1\.16\./);
const [account] = await client.request({ method: 'eth_accounts' });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const solc = createRequire(import.meta.url)('solc');
const compiledSolidity = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'T.sol': { content: `
pragma solidity ^0.8.24;
contract T {
  mapping(address => uint256) public balanceOf;
  function buy(address recipient, uint256 amount) external payable { balanceOf[recipient] += amount; }
}
` } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const artifact = compiledSolidity.contracts['T.sol'].T;
const deployed = await wallet.deployContract({ abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object });
const token = (await client.waitForTransactionReceipt({ hash: deployed })).contractAddress;
const raw = JSON.parse(readFileSync(new URL('../test/fixtures/external.bag.json', import.meta.url), 'utf8'));
raw.definition.assets = [{ chain: 'robinhood', address: token, decimals: 18, weightBps: 10000 }];
raw.definition.rules.weightBounds = { minBps: 100, maxBps: 10000 };
raw.definition.rules.minInvestment = null;
delete raw.metadata; delete raw.definitionHash;
const parsed = parseBag(raw);
assert.ok(parsed.ok);
const data = encodeFunctionData({ abi: artifact.abi, functionName: 'buy', args: [account, 1000n] });
const purchase = await compileBag(parsed.bag, { inputToken: NATIVE_TOKEN, amountRaw: 10000n, signer: account }, {
  provider: { name: 'local-geth', async compile(q) { return {
    transaction: { to: token, data, value: q.amountRaw.toString(), chainId: 4663 }, executor: null, approvals: [],
    legs: [{ token, expectedOutRaw: '1000', minOutRaw: '900' }], priceImpactBps: 0, gasLimit: null, fees: [],
  }; } }, trust: { chainId: 4663, allowedTransactionTargets: [token], allowedApprovalSpenders: [] },
});
// Test-only chain binding: bag.json v1's supported chain table is not changed.
purchase.transaction.chainId = 1337;
purchase.quote.plan.chainId = 1337;
const minimumReceived = [{ token, amountRaw: 900n }];
let hashes;
for (let attempt = 0; attempt < 5; attempt++) {
  const nonce = await client.getTransactionCount({ address: account });
  hashes = [];
  for (let i = 0; i < 3; i++) hashes.push(await wallet.sendTransaction({ to: token, data, value: purchase.transaction.value, gas: 200000n, nonce: nonce + i }));
  const receipts = await Promise.all(hashes.map(hash => client.waitForTransactionReceipt({ hash })));
  if (receipts.every(r => r.blockHash === receipts[0].blockHash)) break;
  if (attempt === 4) throw new Error('Could not place three transactions in one dev block; increase --dev.period.');
}
for (const hash of hashes) {
  const result = await verifyPurchaseReceipt(purchase, { client: withReceiptEvidence(client, { balanceState: 'GETH_TRANSACTION_INDEX' }), transactionHash: hash, minimumReceived });
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result.issues));
  assert.equal(result.balanceScope, 'TRANSACTION');
  assert.equal(result.outputs[0].balanceDeltaRaw, 1000n, 'Must isolate this transaction, not the 3000-unit block delta');
}
const refused = await verifyPurchaseReceipt(purchase, { client: withReceiptEvidence(client), transactionHash: hashes[0], minimumReceived });
assert.equal(refused.status, 'INDETERMINATE');
console.log('Geth 1.16 transaction-state smoke: first, middle and last transaction each credited exactly 1000; busy-block default refused.');
