// Offline demonstration with synthetic tokens/readers. It performs no network call, signature or transaction.
import { compileBag, getSdkErrorInfo, parseBag, type Hex, type PurchaseReceiptClient } from '@bagprotocol/sdk';
import { fetchBag } from '@bagprotocol/sdk/http';
import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { createIntent, restoreIntent, verifySubmitted } from './purchase.js';

const A = ('0x' + 'a'.repeat(40)) as Hex;
const B = ('0x' + 'b'.repeat(40)) as Hex;
const SIGNER = ('0x' + '5'.repeat(40)) as Hex;
const ROUTER = ('0x' + '7'.repeat(40)) as Hex;
const HASH = ('0x' + '1'.repeat(64)) as Hex;
const BLOCK = ('0x' + '2'.repeat(64)) as Hex;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function main() {
  const text = JSON.stringify({ bagJson: 1, definition: {
    kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'IMMUTABLE',
    assets: [{ chain: 'robinhood', address: A, decimals: 18, weightBps: 5000 }, { chain: 'robinhood', address: B, decimals: 18, weightBps: 5000 }],
    rules: { weightBounds: { minBps: null, maxBps: null }, maxAssets: null, minInvestment: null, swapSlippageBps: 100,
      rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: 'BLOCK' },
  } });
  const parsed = parseBag(text);
  if (!parsed.ok) throw new Error('Offline fixture did not parse');
  const compiled = await compileBag(parsed.bag, { inputToken: '0x0000000000000000000000000000000000000000', amountRaw: BigInt(1000), signer: SIGNER }, {
    provider: { name: 'offline-fixture', async compile(request) { return {
      transaction: { to: ROUTER, data: '0x12345678', value: String(request.amountRaw), chainId: request.chainId }, executor: null, approvals: [],
      legs: request.legs.map(leg => ({ token: leg.token, expectedOutRaw: '1000', minOutRaw: '990' })), priceImpactBps: 0, fees: [], gasLimit: null,
    }; } }, trust: { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] },
  });
  const reviewedMinimums = [{ token: A, amountRaw: BigInt(990) }, { token: B, amountRaw: BigInt(990) }];
  const snapshot = createIntent(compiled, reviewedMinimums);
  const original = restoreIntent(snapshot.text, snapshot.integrityHash);
  assert(original.compiled.transaction.value === BigInt(1000), 'BigInt snapshot was not restored');
  let changedRejected = false;
  try { restoreIntent(snapshot.text + ' ', snapshot.integrityHash); } catch { changedRejected = true; }
  assert(changedRejected, 'Modified original snapshot was not refused');
  const topic = keccak256(stringToHex('Transfer(address,address,uint256)'));
  const addressWord = (address: Hex) => ('0x' + address.slice(2).padStart(64, '0')) as Hex;
  const rpc: PurchaseReceiptClient = {
    getChainId: async () => 4663,
    getTransaction: async () => ({ hash: HASH, from: SIGNER, to: ROUTER, input: compiled.transaction.data, value: compiled.transaction.value,
      chainId: 4663, blockHash: BLOCK, blockNumber: BigInt(10) }),
    getTransactionReceipt: async () => ({ transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), from: SIGNER, to: ROUTER, status: 'success',
      logs: [A, B].map((token, i) => ({ address: token, topics: [topic, addressWord(ROUTER), addressWord(SIGNER)],
        data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(1000)]), logIndex: i, transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), removed: false })) }),
    getBlock: async () => ({ hash: BLOCK }), getBlockNumber: async () => BigInt(12),
    getPurchaseBalanceChanges: async context => ({ ...context, scope: 'TRANSACTION', balances: context.tokens.map(token => ({ token, beforeRaw: BigInt(0), afterRaw: BigInt(1000) })) }),
  };
  const result = await verifySubmitted({ snapshotText: snapshot.text, trustedIntentHash: snapshot.integrityHash, transactionHash: HASH, client: rpc });
  assert(result.status === 'VERIFIED', 'Synthetic receipt did not verify');
  const slowFetch = (async () => new Promise<Response>(() => undefined)) as typeof fetch;
  const deadline = await fetchBag('https://fixture.invalid', { fetch: slowFetch, timeoutMs: 5 }).then(() => null, getSdkErrorInfo);
  assert(deadline?.code === 'HTTP_TIMEOUT', 'A custom fetch ignoring cancellation was not bounded');
  let bodyCancelled = false;
  const stalledBody = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode(' ')); },
    cancel() { bodyCancelled = true; return new Promise<void>(() => undefined); },
  });
  const bodyDeadline = await fetchBag('https://fixture.invalid', {
    fetch: (async () => new Response(stalledBody)) as typeof fetch, timeoutMs: 5,
  }).then(() => null, getSdkErrorInfo);
  assert(bodyDeadline?.code === 'HTTP_TIMEOUT' && bodyCancelled, 'A stalled body or cancel hook was not bounded');
  const aborted = new AbortController(); aborted.abort('private reason');
  const cancelled = await fetchBag('https://fixture.invalid', { signal: aborted.signal }).then(() => null, getSdkErrorInfo);
  assert(cancelled?.code === 'HTTP_ABORTED' && !JSON.stringify(cancelled).includes('private reason'), 'Cancellation was not safe');
  console.log(JSON.stringify({ status: 'OFFLINE_DEMO_OK', evidence: 'SYNTHETIC_ONLY', receiptVerification: result.status,
    snapshotIntegrity: 'CHECKED', httpDeadline: deadline?.code, bodyDeadline: bodyDeadline?.code, cancellation: cancelled?.code }));
}
main().catch(error => { console.error(JSON.stringify(getSdkErrorInfo(error))); process.exitCode = 1; });
