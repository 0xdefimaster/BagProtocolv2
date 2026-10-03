/**
 * scripts/spike/lifi-e2e-execute.ts — REAL-CHAIN LI.FI end-to-end check on
 * Robinhood Chain (4663), for a DISPOSABLE wallet the operator funds with a
 * tiny amount. SPIKE ONLY — never imported by the application.
 *
 * DEFAULT = DRY RUN: quotes with the wallet as fromAddress, validates the
 * returned transaction (chain, target contract, value cap, sender), and
 * simulates it (eth_estimateGas). Nothing is sent.
 *
 * --send additionally broadcasts, and ONLY IF ALL of these are set:
 *   E2E_PRIVATE_KEY      disposable key (read from env, never printed, never written)
 *   E2E_CONFIRM          must equal I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS
 *   E2E_MAX_AMOUNT_WEI   hard cap on the native value sent
 * Native-asset input only (no ERC-20 approval is ever sent by this script).
 *
 * Required: ROBINHOOD_RPC_URL, E2E_TO_TOKEN (0x…), E2E_AMOUNT_WEI.
 * Optional: LIFI_API_KEY, E2E_SLIPPAGE (default 0.005), E2E_RECEIPT_TIMEOUT_MS (default 120000).
 * For a dry run without a key, set E2E_FROM_ADDRESS instead of E2E_PRIVATE_KEY.
 *
 * Output: stdout + reports/lifi-e2e-result.json (no secrets). Every stop has a
 * precise diagnosis (lib/blockchain/lifi-diagnostics.ts) — EGRESS_BLOCKED,
 * RPC_UNREACHABLE, RPC_WRONG_CHAIN, LIFI_UNSUPPORTED_CHAIN/ROUTE, … — never a
 * vague "failed", and never a claimed success that did not happen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { classifyLifiResponse, classifyRpcChainId, type Diagnosis, type RpcOutcome } from '../../lib/blockchain/lifi-diagnostics';

const CHAIN_ID = 4663;
const NATIVE = '0x0000000000000000000000000000000000000000';
const CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS';
const SEND = process.argv.includes('--send');

type Result = { mode: 'DRY_RUN' | 'SEND'; status: 'PASS' | 'FAIL' | 'BLOCKED'; diagnosis: Diagnosis | 'SEND_REFUSED' | 'SIMULATION_FAILED' | 'TX_REVERTED' | 'TX_TIMEOUT' | 'VALIDATION_FAILED'; detail: string; wallet?: string; txHash?: string; at: string; steps: string[] };
const result: Result = { mode: SEND ? 'SEND' : 'DRY_RUN', status: 'BLOCKED', diagnosis: 'ENV_MISSING', detail: '', at: '', steps: [] };
const step = (m: string) => {
  result.steps.push(m);
  console.log(m);
};
function stop(status: Result['status'], diagnosis: Result['diagnosis'], detail: string): never {
  Object.assign(result, { status, diagnosis, detail, at: new Date().toISOString() });
  const out = resolve(process.cwd(), 'reports/lifi-e2e-result.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nFINAL: ${status} (${diagnosis}) — ${detail}\nEvidence: ${out}`);
  process.exit(status === 'PASS' ? 0 : 1);
}

async function rpcRaw(url: string, method: string, params: unknown[]): Promise<RpcOutcome> {
  const o: RpcOutcome = { status: null, headers: null, body: null, rawBody: null, networkError: null, jsonRpcError: null, result: null };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    o.status = res.status;
    o.headers = Object.fromEntries(res.headers.entries());
    o.rawBody = await res.text();
    try {
      const j = JSON.parse(o.rawBody);
      o.body = j;
      o.jsonRpcError = j.error ?? null;
      o.result = j.result ?? null;
    } catch {
      /* raw body kept */
    }
  } catch (e) {
    o.networkError = (e as Error).message;
  }
  return o;
}

async function main() {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const toToken = process.env.E2E_TO_TOKEN;
  const amount = process.env.E2E_AMOUNT_WEI;
  if (!rpcUrl || !toToken || !amount) stop('BLOCKED', 'ENV_MISSING', 'Set ROBINHOOD_RPC_URL, E2E_TO_TOKEN and E2E_AMOUNT_WEI.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(toToken) || !/^\d+$/.test(amount)) stop('BLOCKED', 'ENV_MISSING', 'E2E_TO_TOKEN must be an address, E2E_AMOUNT_WEI an integer.');

  const key = process.env.E2E_PRIVATE_KEY as Hex | undefined;
  const account = key ? privateKeyToAccount(key) : null;
  const wallet = (account?.address ?? process.env.E2E_FROM_ADDRESS) as Hex | undefined;
  if (!wallet) stop('BLOCKED', 'ENV_MISSING', 'Set E2E_PRIVATE_KEY (disposable) or, for a dry run only, E2E_FROM_ADDRESS.');
  result.wallet = wallet;

  if (SEND) {
    if (!account) stop('BLOCKED', 'SEND_REFUSED', '--send requires E2E_PRIVATE_KEY.');
    if (process.env.E2E_CONFIRM !== CONFIRM_PHRASE) stop('BLOCKED', 'SEND_REFUSED', `--send requires E2E_CONFIRM=${CONFIRM_PHRASE}.`);
    const cap = process.env.E2E_MAX_AMOUNT_WEI;
    if (!cap || !/^\d+$/.test(cap)) stop('BLOCKED', 'SEND_REFUSED', '--send requires E2E_MAX_AMOUNT_WEI.');
    if (BigInt(amount) > BigInt(cap)) stop('BLOCKED', 'SEND_REFUSED', `E2E_AMOUNT_WEI ${amount} exceeds E2E_MAX_AMOUNT_WEI ${cap}.`);
  }

  step('1. RPC chain id');
  const cid = classifyRpcChainId(await rpcRaw(rpcUrl, 'eth_chainId', []), CHAIN_ID);
  step(`   ${cid.diagnosis}: ${cid.detail}`);
  if (cid.diagnosis !== 'OK') stop('BLOCKED', cid.diagnosis, cid.detail);

  const chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const balance = await pub.getBalance({ address: wallet });
  step(`2. wallet ${wallet} native balance ${balance}`);
  if (balance < BigInt(amount)) stop('FAIL', 'VALIDATION_FAILED', `balance ${balance} < amount ${amount}`);

  step('3. LI.FI quote (fromAddress = this wallet)');
  const params = new URLSearchParams({
    fromChain: String(CHAIN_ID),
    toChain: String(CHAIN_ID),
    fromToken: NATIVE,
    toToken,
    fromAmount: amount,
    fromAddress: wallet,
    toAddress: wallet,
    slippage: process.env.E2E_SLIPPAGE ?? '0.005',
  });
  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;
  let status: number | null = null;
  let rawBody: string | null = null;
  let body: unknown = null;
  let hdrs: Record<string, string> | null = null;
  let networkError: string | null = null;
  try {
    const res = await fetch(`https://li.quest/v1/quote?${params}`, { headers });
    status = res.status;
    hdrs = Object.fromEntries(res.headers.entries());
    rawBody = await res.text();
    try {
      body = JSON.parse(rawBody);
    } catch {
      /* raw */
    }
  } catch (e) {
    networkError = (e as Error).message;
  }
  const q = classifyLifiResponse({ status, headers: hdrs, body, rawBody, networkError }, 'quote');
  step(`   ${q.diagnosis}: ${q.detail}`);
  if (q.diagnosis !== 'OK') stop(q.diagnosis === 'EGRESS_BLOCKED' || q.diagnosis === 'LIFI_UNREACHABLE' ? 'BLOCKED' : 'FAIL', q.diagnosis, q.detail);

  const quote = body as {
    action?: { fromChainId?: number; toChainId?: number; fromToken?: { address?: string }; toToken?: { address?: string } };
    estimate?: { fromAmount?: string; toAmount?: string; toAmountMin?: string };
    transactionRequest?: { to?: Hex; data?: Hex; value?: string; chainId?: number; from?: string; gasLimit?: string };
  };
  step('4. validate the returned transaction');
  const tx = quote.transactionRequest;
  const problems: string[] = [];
  if (quote.action?.fromChainId !== CHAIN_ID || quote.action?.toChainId !== CHAIN_ID) problems.push('response chain ids differ from the request');
  if ((quote.action?.toToken?.address ?? '').toLowerCase() !== toToken.toLowerCase()) problems.push('response toToken differs from the request');
  if (quote.estimate?.fromAmount !== amount) problems.push('response fromAmount differs from the request');
  if (!tx?.to || !tx.data) problems.push('no transactionRequest');
  if (tx?.chainId !== undefined && Number(tx.chainId) !== CHAIN_ID) problems.push(`transactionRequest.chainId ${tx.chainId} is not ${CHAIN_ID}`);
  if (tx?.from && tx.from.toLowerCase() !== wallet.toLowerCase()) problems.push('transactionRequest.from is not this wallet');
  const value = BigInt(tx?.value ?? '0');
  if (value > BigInt(amount)) problems.push(`transaction value ${value} exceeds requested amount ${amount}`);
  if (tx?.to && (await pub.getCode({ address: tx.to }))?.length ? false : true) problems.push(`target ${tx?.to} has no contract code`);
  if (problems.length) stop('FAIL', 'LIFI_RESPONSE_MISMATCH', problems.join('; '));
  step(`   OK: to ${tx!.to}, value ${value}, expected out ${quote.estimate?.toAmount} (min ${quote.estimate?.toAmountMin})`);

  step('5. simulate (eth_estimateGas)');
  let gas: bigint;
  try {
    gas = await pub.estimateGas({ account: wallet, to: tx!.to!, data: tx!.data!, value });
  } catch (e) {
    stop('FAIL', 'SIMULATION_FAILED', (e as Error).message.split('\n')[0]);
  }
  step(`   gas ${gas}`);
  if (!SEND) stop('PASS', 'OK', 'DRY RUN only — quote validated and simulated; nothing was sent. Re-run with --send (see header) to broadcast.');

  step('6. SEND (real funds, disposable wallet)');
  const wc = createWalletClient({ account: account!, chain, transport: http(rpcUrl) });
  const hash = await wc.sendTransaction({ to: tx!.to!, data: tx!.data!, value, gas: (gas * BigInt(12)) / BigInt(10) });
  result.txHash = hash;
  step(`   sent ${hash}`);
  let receipt;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash, timeout: Number(process.env.E2E_RECEIPT_TIMEOUT_MS ?? 120_000) });
  } catch (e) {
    stop('FAIL', 'TX_TIMEOUT', `no receipt yet for ${hash}: ${(e as Error).message.split('\n')[0]} — check it on the explorer; do not assume success.`);
  }
  if (receipt.status !== 'success') stop('FAIL', 'TX_REVERTED', `${hash} reverted in block ${receipt.blockNumber}`);
  stop('PASS', 'OK', `${hash} succeeded in block ${receipt.blockNumber}`);
}

main().catch((e) => stop('FAIL', 'VALIDATION_FAILED', `script error: ${(e as Error).message}`));
