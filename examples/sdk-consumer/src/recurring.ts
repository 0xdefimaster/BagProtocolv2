// Offline recurring (DCA) demonstration with synthetic data: terms → typed data round trip → Composer-free run plan
// from a synthetic QuoterV2 → receipt verification. No network call, signature or transaction.
import {
  buildRecurringAuthorization,
  compareRecurringAuthorization,
  decodeRecurringAuthorizationTypedData,
  parseBag,
  RECURRING_EXECUTOR_ABI,
  recurringAuthorizationId,
  recurringAuthorizationTypedData,
  recurringLegAmounts,
  recurringMinimumOutputs,
  verifyRecurringPurchaseReceipt,
  type Hex,
} from '@bagprotocol/sdk';
import { buildRecurringRunPlan, type QuoteClient } from '@bagprotocol/sdk/uniswap-v3';
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, stringToHex } from 'viem';

const A = ('0x' + 'a'.repeat(40)) as Hex;
const B = ('0x' + 'b'.repeat(40)) as Hex;
const USDG = ('0x' + 'c'.repeat(40)) as Hex;
const OWNER = ('0x' + '5'.repeat(40)) as Hex;
const EXECUTOR = ('0x' + '6'.repeat(40)) as Hex;
const ROUTER = ('0x' + '7'.repeat(40)) as Hex;
const SWAP = ('0x' + '8'.repeat(40)) as Hex;
const HASH = ('0x' + '1'.repeat(64)) as Hex;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

export async function recurringOfflineDemo() {
  const parsed = parseBag(JSON.stringify({ bagJson: 1, definition: {
    kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'IMMUTABLE',
    assets: [{ chain: 'robinhood', address: A, decimals: 18, weightBps: 6000 }, { chain: 'robinhood', address: B, decimals: 18, weightBps: 4000 }],
    rules: { weightBounds: { minBps: null, maxBps: null }, maxAssets: null, minInvestment: null, swapSlippageBps: 100, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: 'BLOCK' },
  } }));
  if (!parsed.ok) throw new Error('Offline recurring fixture did not parse');
  const deployment = { chainId: 4663, executor: EXECUTOR };
  const auth = buildRecurringAuthorization({
    bag: parsed.bag, owner: OWNER, funding: { kind: 'ALLOWANCE' }, inputToken: USDG, inputTokenDecimals: 6,
    registry: { bagId: keccak256(stringToHex('bag')), bagVersion: 1, compositionHash: keccak256(stringToHex('composition')) },
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

  // Synthetic receipt: owner → executor → router → (swap) → router → executor → owner, and one PurchaseExecuted.
  const id = recurringAuthorizationId(auth, deployment);
  const legIn = recurringLegAmounts(auth);
  const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) => ({ address: token,
    topics: encodeEventTopics({ abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }], eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
  const out = auth.assets.map((_, i) => floors[i] * BigInt(2));
  const logs = [
    transfer(USDG, OWNER, EXECUTOR, auth.schedule.grossAmountPerRun),
    transfer(USDG, EXECUTOR, ROUTER, auth.schedule.grossAmountPerRun),
    ...auth.assets.map((a, i) => transfer(USDG, ROUTER, SWAP, legIn[i])),
    ...auth.assets.map((a, i) => transfer(a.asset, SWAP, ROUTER, out[i])),
    ...auth.assets.map((a, i) => transfer(a.asset, ROUTER, EXECUTOR, out[i])),
    ...auth.assets.map((a, i) => transfer(a.asset, EXECUTOR, OWNER, out[i])),
    { address: EXECUTOR, topics: encodeEventTopics({ abi: RECURRING_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner: OWNER, authorizationId: id, executionHash: pad('0x01', { size: 32 }) } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(0), BigInt(0), auth.schedule.grossAmountPerRun, auth.schedule.grossAmountPerRun]) },
  ];
  const receipt = await verifyRecurringPurchaseReceipt({ client: { getTransactionReceipt: async () => ({ status: 'success', to: EXECUTOR, blockNumber: BigInt(1), logs }) }, transactionHash: HASH, auth, deployment });
  assert(receipt.status === 'VERIFIED', 'synthetic recurring receipt did not verify: ' + JSON.stringify(receipt.issues));
  return { recurring: receipt.status, legs: run.legs.map(l => l.fee), evidence: run.evidence };
}
