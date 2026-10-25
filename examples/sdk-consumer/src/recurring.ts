// Offline recurring (DCA) demonstration with synthetic data: terms bound to the registered composition → typed data
// round trip → Composer-free run plan from a synthetic QuoterV2 → purchase verification against the prepared call and
// synthetic transaction-scoped balances. No network call, signature or transaction.
import {
  bagFactoryCompositionHash,
  buildRecurringAuthorization,
  compareRecurringAuthorization,
  decodeRecurringAuthorizationTypedData,
  parseBag,
  RECURRING_EXECUTOR_ABI,
  recurringAuthorizationId,
  recurringAuthorizationTypedData,
  recurringExecutionHash,
  recurringLegAmounts,
  recurringMinimumOutputs,
  verifyRecurringPurchase,
  type Hex,
  type PurchaseReceiptClient,
  type RecurringPurchaseIntent,
} from '@bagprotocol/sdk';
import { buildRecurringRunPlan, type QuoteClient } from '@bagprotocol/sdk/uniswap-v3';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, stringToHex } from 'viem';

const A = ('0x' + 'a'.repeat(40)) as Hex;
const B = ('0x' + 'b'.repeat(40)) as Hex;
const USDG = ('0x' + 'c'.repeat(40)) as Hex;
const OWNER = ('0x' + '5'.repeat(40)) as Hex;
const EXECUTOR = ('0x' + '6'.repeat(40)) as Hex;
const ROUTER = ('0x' + '7'.repeat(40)) as Hex;
const SWAP = ('0x' + '8'.repeat(40)) as Hex;
const HASH = ('0x' + '1'.repeat(64)) as Hex;
const BLOCK = ('0x' + '2'.repeat(64)) as Hex;
const KEEPER = ('0x' + '9'.repeat(40)) as Hex;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

export async function recurringOfflineDemo() {
  const parsed = parseBag(JSON.stringify({ bagJson: 1, definition: {
    kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'IMMUTABLE',
    assets: [{ chain: 'robinhood', address: A, decimals: 18, weightBps: 6000 }, { chain: 'robinhood', address: B, decimals: 18, weightBps: 4000 }],
    rules: { weightBounds: { minBps: null, maxBps: null }, maxAssets: null, minInvestment: null, swapSlippageBps: 100, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: 'BLOCK' },
  }, metadata: { name: 'Offline', symbol: 'OFF', description: 'Synthetic', assets: [{ chain: 'robinhood', address: A, symbol: 'AAA' }, { chain: 'robinhood', address: B, symbol: 'BBB' }] } }));
  if (!parsed.ok) throw new Error('Offline recurring fixture did not parse');
  const deployment = { chainId: 4663, executor: EXECUTOR };
  const auth = buildRecurringAuthorization({
    bag: parsed.bag, owner: OWNER, funding: { kind: 'ALLOWANCE' }, inputToken: USDG, inputTokenDecimals: 6,
    registry: { bagId: keccak256(stringToHex('bag')), bagVersion: 1, compositionHash: bagFactoryCompositionHash(parsed.bag)! },
    amountPerRunRaw: BigInt(5_000_000), runs: 5, totalBudgetRaw: BigInt(25_000_000), startsAt: BigInt(1_800_000_000), periodSeconds: BigInt(7 * 86_400),
    maxPriceRaw: { [A]: BigInt(30_000_000), [B]: BigInt(250_000_000) }, route: { router: ROUTER, swapTarget: SWAP, allowedFees: [500, 3000] }, nonce: BigInt(1),
  });
  // What a wallet receives is JSON; the page decodes THAT and compares it with what the user chose.
  const wire = JSON.parse(JSON.stringify(recurringAuthorizationTypedData(auth, deployment), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert(compareRecurringAuthorization(decodeRecurringAuthorizationTypedData(wire, deployment), auth).length === 0, 'typed data did not round-trip');

  const floors = recurringMinimumOutputs(auth);
  const quotes: QuoteClient = { async simulateContract({ args }) {
    const p = args[0] as { tokenOut: string };
    return { result: [floors[auth.assets.findIndex(a => a.asset === p.tokenOut.toLowerCase())] * BigInt(2), BigInt(1), 0, BigInt(0)] };
  } };
  const run = await buildRecurringRunPlan({ client: quotes, auth, deployment, quoter: SWAP, nowSeconds: auth.schedule.startsAt + BigInt(60) });
  assert(run.plan.wallet === EXECUTOR && run.plan.inputAmount === auth.schedule.grossAmountPerRun, 'run plan is not the signed purchase');

  // The call the keeper prepared; the mined transaction must be exactly this call.
  const intent: RecurringPurchaseIntent = { execution: { ...run.execution, plan: run.plan, planSignature: ('0x' + '3'.repeat(130)) as Hex }, ownerSignature: ('0x' + '4'.repeat(130)) as Hex, fundingProof: '0x' };
  // Synthetic chain: owner → executor → router → (swap) → router → executor → owner, one PurchaseExecuted, and balances.
  const id = recurringAuthorizationId(auth, deployment);
  const legIn = recurringLegAmounts(auth);
  const out = auth.assets.map((_, i) => floors[i] * BigInt(2));
  const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) => ({ address: token,
    topics: encodeEventTopics({ abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }], eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
  const gross = auth.schedule.grossAmountPerRun;
  const logs = [
    transfer(USDG, OWNER, EXECUTOR, gross),
    transfer(USDG, EXECUTOR, ROUTER, gross),
    ...auth.assets.map((_, i) => transfer(USDG, ROUTER, SWAP, legIn[i])),
    ...auth.assets.map((a, i) => transfer(a.asset, SWAP, ROUTER, out[i])),
    ...auth.assets.map((a, i) => transfer(a.asset, ROUTER, EXECUTOR, out[i])),
    ...auth.assets.map((a, i) => transfer(a.asset, EXECUTOR, OWNER, out[i])),
    { address: EXECUTOR, topics: encodeEventTopics({ abi: RECURRING_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner: OWNER, authorizationId: id, executionHash: recurringExecutionHash(run.plan) } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [run.execution.window, BigInt(0), gross, gross]) },
  ].map((l, i) => ({ ...l, logIndex: i, transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(1), removed: false }));
  const balance = (account: string, token: string): [bigint, bigint] => {
    if (account.toLowerCase() === OWNER && token.toLowerCase() === USDG) return [BigInt(100_000_000), BigInt(100_000_000) - gross];
    const i = auth.assets.findIndex(a => a.asset === token.toLowerCase());
    return account.toLowerCase() === OWNER && i >= 0 ? [BigInt(0), out[i]] : [BigInt(0), BigInt(0)];
  };
  const chain: PurchaseReceiptClient = {
    getChainId: async () => 4663,
    getTransaction: async () => ({ hash: HASH, from: KEEPER, to: EXECUTOR, value: BigInt(0), chainId: 4663, blockHash: BLOCK, blockNumber: BigInt(1),
      input: encodeFunctionData({ abi: RECURRING_EXECUTOR_ABI, functionName: 'execute', args: [auth, intent.execution, intent.ownerSignature, intent.fundingProof] as never }) }),
    getTransactionReceipt: async () => ({ transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(1), from: KEEPER, to: EXECUTOR, status: 'success', logs }),
    getBlock: async () => ({ hash: BLOCK, transactions: [HASH] }),
    getBlockNumber: async () => BigInt(1),
    getPurchaseBalanceChanges: async context => ({ ...context, scope: 'SINGLE_TRANSACTION_BLOCK', balances: context.tokens.map(token => { const [beforeRaw, afterRaw] = balance(context.owner, token); return { token, beforeRaw, afterRaw }; }) }),
  };
  const receipt = await verifyRecurringPurchase({ client: chain, transactionHash: HASH, auth, deployment, intent });
  assert(receipt.status === 'VERIFIED' && receipt.transactionBinding === 'PREPARED_INTENT', 'synthetic recurring purchase did not verify: ' + JSON.stringify(receipt.issues));
  return { recurring: receipt.status, binding: receipt.transactionBinding, evidence: receipt.evidence, quotes: run.evidence };
}
