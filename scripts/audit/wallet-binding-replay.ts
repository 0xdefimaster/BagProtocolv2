/**
 * Read-only replay of the exact smart-account binding (BAG_WALLET_BATCH_BINDING, M2) against mined transactions,
 * before shadow or enforce mode is switched on anywhere.
 *
 *   npx tsx scripts/audit/wallet-binding-replay.ts cases.json [--out evidence/smart-account/replay.json]
 *
 * cases.json: [{ "chain": "robinhood", "txHash": "0x…", "wallet": "0x…",
 *                "expected": { "to": "0x…", "data": "0x…", "value": "0" },
 *                "approvals": [{ "token": "0x…", "spender": "0x…", "amountRaw": "…" }], "label": "optional" }]
 * The expected call and approvals are the intent's stored composerTransaction (and its approvals); see
 * docs/runbooks/WALLET_BATCH_BINDING_SHADOW.md for the read-only query that exports them.
 *
 * Prints, per case: the envelope kind or the refusal code, and the decoded executions (targets and selectors).
 * Never signs or sends; reads the transaction, its receipt, and the wallet's code and nonce at the previous block.
 * RPC: <CHAIN>_RPC_URL from the environment if set (never printed), else the public endpoint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, type Hex } from 'viem';
import { bindWalletEnvelope, chainIdOf, checkWalletExecutionState, isBagChain, type BagChain } from '../../packages/bag-sdk/src/index';

const PUBLIC_RPC: Record<BagChain, string> = {
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  ethereum: 'https://ethereum-rpc.publicnode.com',
};

interface ReplayCase {
  chain: string;
  txHash: Hex;
  wallet: Hex;
  expected: { to: Hex; data: Hex; value: string };
  approvals?: { token: Hex; spender: Hex; amountRaw: string }[];
  label?: string;
}

const errName = (e: unknown) => (e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : 'Error');

async function replay(c: ReplayCase) {
  if (!isBagChain(c.chain)) return { label: c.label, txHash: c.txHash, verdict: 'ERROR', code: 'UNKNOWN_CHAIN' };
  const chain = c.chain;
  const rpc = process.env[`${chain.toUpperCase()}_RPC_URL`] || PUBLIC_RPC[chain];
  const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: c.txHash }), client.getTransactionReceipt({ hash: c.txHash })]);
  const expectation = {
    chainId: chainIdOf(chain),
    wallet: c.wallet,
    call: { to: c.expected.to, data: c.expected.data, value: BigInt(c.expected.value || '0') },
    approvals: (c.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, maxAmountRaw: BigInt(a.amountRaw) })),
  };
  const bound = bindWalletEnvelope({ from: tx.from, to: tx.to ?? null, input: tx.input, value: tx.value }, expectation);
  const base = { label: c.label, chain, txHash: c.txHash, receiptStatus: receipt.status, txTo: tx.to, selector: tx.input.slice(0, 10) };
  if (!bound.ok) return { ...base, verdict: 'REFUSED', code: bound.code, detail: bound.detail };
  const state = await checkWalletExecutionState(client as never, {
    from: tx.from, to: tx.to ?? null, input: tx.input, value: tx.value, nonce: tx.nonce, type: tx.type,
    authorizationList: (tx as { authorizationList?: readonly unknown[] }).authorizationList ?? null, blockNumber: receipt.blockNumber,
  }, bound);
  const executions = bound.executions.map((e) => ({ target: e.target, selector: e.callData.slice(0, 10), value: String(e.value) }));
  if (!state.ok) return { ...base, verdict: state.code === 'STATE_UNAVAILABLE' ? 'INDETERMINATE' : 'REFUSED', code: state.code, detail: state.detail, envelope: bound.envelope, executions };
  return { ...base, verdict: 'BOUND', envelope: bound.envelope, smartAccount: state.smartAccount?.name ?? null, executions };
}

async function main() {
  const [file, flag, out] = process.argv.slice(2);
  if (!file) throw new Error('usage: wallet-binding-replay.ts cases.json [--out file]');
  const cases = JSON.parse(readFileSync(file, 'utf8')) as ReplayCase[];
  const results = [];
  for (const c of cases) {
    try { results.push(await replay(c)); } catch (e) { results.push({ label: c.label, txHash: c.txHash, verdict: 'ERROR', code: errName(e) }); }
  }
  const report = { schema: 'bag-wallet-binding-replay/v1', createdAt: new Date().toISOString(), readOnly: true, results };
  if (flag === '--out' && out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ status: 'STOPPED', error: errName(e) }));
  process.exitCode = 1;
});
