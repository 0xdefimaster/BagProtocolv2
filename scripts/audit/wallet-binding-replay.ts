/**
 * Read-only replay of BAG's transaction bindings against mined transactions, before shadow or enforce mode is
 * switched on anywhere (docs/runbooks/WALLET_BATCH_BINDING_SHADOW.md).
 *
 *   npx tsx --env-file=.env.local scripts/audit/wallet-binding-replay.ts cases.json --out report.json [--quiet]
 *
 * cases.json: [{ "label": "…", "flow": "purchase" | "redeem" | "rebalance", "chain": "robinhood", "txHash": "0x…",
 *   "wallet": "0x…", "expected": { "to": "0x…", "data": "0x…", "value": "0" },
 *   "approvals": [{ "token": "0x…", "spender": "0x…", "amountRaw": "…" }],
 *   "deposit": { "token": "0x…", "amountRaw": "…" } | null,          // purchase: ERC-20 deposit that must leave
 *   "sold": [{ "token": "0x…", "amountRaw": "…" }],                    // redeem / rebalance: what must leave
 *   "outputs": ["0x…"] }]                                              // what must arrive
 * The expected call and approvals are the intent's stored composerTransaction; the runbook has the export query.
 *
 * Per case it reports, side by side:
 *   legacyBefore  the default binding before the F-01 fix (calldata containment, any redeemDelegations target);
 *   legacyAfter   the default binding now (isWalletRoutedBatch with the pinned DelegationManager) plus, for a
 *                 purchase, the deposit-left-wallet evidence the flow requires;
 *   exact         the shared exact binding (bindWalletEnvelope + checkWalletExecutionState), as in enforce mode;
 * and the facts behind them: envelope kind, wallet code before the block (EOA / pinned EIP-7702 / other), whether
 * that historical state could be read, receipt status, and Transfer-log evidence (deposit left, sold in full,
 * outputs arrived, sold tokens refunded back to the wallet inside the transaction).
 *
 * Never signs or sends. RPC: <CHAIN>_RPC_URL from the environment if set (never printed), else the public endpoint.
 * The report contains wallet-linked data (hashes, labels): keep it outside the repository.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hex } from 'viem';
import {
  bindWalletEnvelope, chainIdOf, checkWalletExecutionState, isBagChain, METAMASK_EIP7702_STATELESS_DELEGATOR, type BagChain,
} from '../../packages/bag-sdk/src/index';
import { batchContainsCall, isWalletRoutedBatch, REDEEM_DELEGATIONS_SELECTOR } from '../../lib/blockchain/composer-status';

const PUBLIC_RPC: Record<BagChain, string> = {
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  ethereum: 'https://ethereum-rpc.publicnode.com',
};
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

interface ReplayCase {
  label?: string;
  flow?: 'purchase' | 'redeem' | 'rebalance';
  chain: string;
  txHash: Hex;
  wallet: Hex;
  expected: { to: Hex; data: Hex; value: string };
  approvals?: { token: Hex; spender: Hex; amountRaw: string }[];
  deposit?: { token: Hex; amountRaw: string } | null;
  sold?: { token: Hex; amountRaw: string }[];
  outputs?: Hex[];
}

const errName = (e: unknown) => (e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : 'Error');
const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The default binding exactly as it was before the F-01 fix (kept here only to measure the change). */
function legacyBeforeF01(tx: { from: string; to: string | null; input: string; value: bigint }, c: ReplayCase): boolean {
  if (!same(tx.from, c.wallet)) return false;
  const selfCall = same(tx.to, c.wallet);
  const redeem = tx.input.toLowerCase().startsWith(REDEEM_DELEGATIONS_SELECTOR);
  if ((selfCall || redeem) && batchContainsCall(tx.input, c.expected)) return true;
  return same(tx.to, c.expected.to) && same(tx.input, c.expected.data) && tx.value === BigInt(c.expected.value || '0');
}

function legacyAfterF01(tx: { from: string; to: string | null; input: string; value: bigint }, c: ReplayCase, chain: BagChain): boolean {
  if (!same(tx.from, c.wallet)) return false;
  if (isWalletRoutedBatch(tx, c.wallet, c.expected, chain)) return true;
  return same(tx.to, c.expected.to) && same(tx.input, c.expected.data) && tx.value === BigInt(c.expected.value || '0');
}

async function replay(c: ReplayCase) {
  if (!isBagChain(c.chain)) return { label: c.label, flow: c.flow, verdict: 'ERROR', code: 'UNKNOWN_CHAIN' };
  const chain = c.chain;
  const rpc = process.env[`${chain.toUpperCase()}_RPC_URL`] || PUBLIC_RPC[chain];
  const client = createPublicClient({ transport: http(rpc, { timeout: 25_000, retryCount: 2 }) });
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: c.txHash }), client.getTransactionReceipt({ hash: c.txHash })]);
  const mined = { from: tx.from, to: tx.to ?? null, input: tx.input, value: tx.value };

  // Transfer-log evidence, summed per token for the wallet, as the app's verifier does.
  const received: Record<string, bigint> = {};
  const sent: Record<string, bigint> = {};
  for (const log of receipt.logs) {
    try {
      const d = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      const token = log.address.toLowerCase();
      if (same(d.args.to, c.wallet)) received[token] = (received[token] ?? BigInt(0)) + d.args.value;
      if (same(d.args.from, c.wallet)) sent[token] = (sent[token] ?? BigInt(0)) + d.args.value;
    } catch { /* not a Transfer */ }
  }
  const evidence = {
    depositLeft: c.deposit ? (sent[c.deposit.token.toLowerCase()] ?? BigInt(0)) >= BigInt(c.deposit.amountRaw) : null,
    // Composer-internal flows back to the wallet: gross sums would overstate what a purchase spent or a sale sold.
    depositRefunded: c.deposit ? (received[c.deposit.token.toLowerCase()] ?? BigInt(0)) > BigInt(0) : null,
    soldInFull: c.sold?.length ? c.sold.every((s) => (sent[s.token.toLowerCase()] ?? BigInt(0)) >= BigInt(s.amountRaw)) : null,
    outputsArrived: c.outputs?.length ? c.outputs.every((o) => (received[o.toLowerCase()] ?? BigInt(0)) > BigInt(0)) : null,
    soldTokenRefunded: c.sold?.length ? c.sold.some((s) => (received[s.token.toLowerCase()] ?? BigInt(0)) > BigInt(0)) : null,
  };

  // Wallet code before the block (what could run in the wallet), read once for the report.
  let walletCode = 'UNAVAILABLE';
  try {
    const code = ((await client.getCode({ address: tx.from, blockNumber: receipt.blockNumber - BigInt(1) })) ?? '0x').toLowerCase();
    walletCode = code === '0x' ? 'EOA'
      : /^0xef0100[0-9a-f]{40}$/.test(code) ? (same(`0x${code.slice(8)}`, METAMASK_EIP7702_STATELESS_DELEGATOR.delegate) ? 'EIP7702_PINNED' : `EIP7702_OTHER:0x${code.slice(8)}`)
        : 'CONTRACT';
  } catch { /* stays UNAVAILABLE */ }

  const expectation = {
    chainId: chainIdOf(chain),
    wallet: c.wallet,
    call: { to: c.expected.to, data: c.expected.data, value: BigInt(c.expected.value || '0') },
    approvals: (c.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, maxAmountRaw: BigInt(a.amountRaw) })),
  };
  const bound = bindWalletEnvelope(mined, expectation);
  let exact: { status: string; code?: string; envelope?: string };
  if (!bound.ok) exact = { status: 'REFUSED', code: bound.code };
  else {
    const state = await checkWalletExecutionState(client as never, {
      ...mined, nonce: tx.nonce, type: tx.type,
      authorizationList: (tx as { authorizationList?: readonly unknown[] }).authorizationList ?? null, blockNumber: receipt.blockNumber,
    }, bound);
    exact = state.ok ? { status: 'BOUND', envelope: bound.envelope } : { status: state.code === 'STATE_UNAVAILABLE' ? 'INDETERMINATE' : 'REFUSED', code: state.code, envelope: bound.envelope };
  }

  const success = receipt.status === 'success';
  const before = legacyBeforeF01(mined, c) && success;
  const afterBinding = legacyAfterF01(mined, c, chain) && success;
  const after = afterBinding && (c.flow !== 'purchase' || evidence.depositLeft !== false);
  const exactAccept = exact.status === 'BOUND' && success;
  return {
    label: c.label, flow: c.flow, chain, txHash: c.txHash, receiptStatus: receipt.status,
    envelope: exact.envelope ?? (same(tx.to, c.expected.to) ? 'DIRECT' : `to:${same(tx.to, c.wallet) ? 'SELF' : 'OTHER'}:${tx.input.slice(0, 10)}`),
    walletCode,
    legacyBefore: before ? 'ACCEPT' : 'REFUSE',
    legacyAfter: after ? 'ACCEPT' : 'REFUSE',
    exact: exactAccept ? 'ACCEPT' : exact.status === 'INDETERMINATE' ? 'INSUFFICIENT_EVIDENCE' : 'REFUSE',
    exactCode: exact.code ?? null,
    agreeAfterVsExact: after === exactAccept,
    evidence,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) throw new Error('usage: wallet-binding-replay.ts cases.json [--out file] [--quiet]');
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const cases = JSON.parse(readFileSync(file, 'utf8')) as ReplayCase[];
  const results = [];
  for (const c of cases) {
    try { results.push(await replay(c)); } catch (e) { results.push({ label: c.label, flow: c.flow, verdict: 'ERROR', code: errName(e) }); }
  }
  const report = { schema: 'bag-wallet-binding-replay/v2', createdAt: new Date().toISOString(), readOnly: true, results };
  if (out) writeFileSync(out, JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  if (!args.includes('--quiet')) console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  else console.log(`replayed ${results.length} cases${out ? ' (report written)' : ''}`);
}

main().catch((e) => {
  console.error(JSON.stringify({ status: 'STOPPED', error: errName(e) }));
  process.exitCode = 1;
});
