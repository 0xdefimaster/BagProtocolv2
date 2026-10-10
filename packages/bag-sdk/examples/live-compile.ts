// -----------------------------------------------------------------------------
// LIVE test of examples/compile-purchase.ts against the real LI.FI Composer API
// and a real RPC. Quote and compile only: the output is an UNSIGNED transaction.
// Nothing is signed or sent, and no key other than your LI.FI API key is used.
//
// This is not part of `vitest run`: a mocked network proves nothing about the
// live API. Run it yourself, with your own credentials from YOUR environment
// (never printed, never logged):
//
//   LIFI_API_KEY=...  RPC_URL=...  COMPOSER_TRUSTED_TARGETS=0x<Composer contract>  [COMPOSER_TRUSTED_SPENDERS=0x...]  \
//   [COMPOSER_URL=...]  npx tsx packages/bag-sdk/examples/live-compile.ts \
//     <bag.json path|URL> <inputToken | 0x0000000000000000000000000000000000000000 for ETH> <amountRaw> <signer>
//
// The signer is only the address the transaction is built for; it needs no key
// here and, for a quote, no balance (simulation then reports it).
//
// Exit code: 0 PASS, 1 FAIL, 2 usage, 3 BLOCKED (credentials missing or network unreachable).
// -----------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { isNativeToken, normalizeAddress, type ContractReader, type SimulationClient } from '../src/index';
import { lifiComposer } from '../src/adapters/lifi';
import { run } from './compile-purchase';
import { safeError, type Verdict } from './verify-registry';

type Report = Awaited<ReturnType<typeof run>>;

const NETWORK_MESSAGE = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i;

/** True when an error (or one of its causes) is the network refusing, not the API answering. */
export function isNetworkBlock(e: unknown): boolean {
  for (let cur = e as Record<string, unknown> | undefined, depth = 0; cur && depth < 8; cur = cur.cause as Record<string, unknown> | undefined, depth++) {
    if (cur.code === 'NETWORK_ERROR') return true;
    if (cur.name === 'HttpRequestError' || cur.name === 'TimeoutError') return true;
    // A 403/407 with no LI.FI error kind is a proxy or network policy, not LI.FI rejecting the request.
    if ((cur.status === 407 || cur.status === 403) && !cur.kind) return true;
    if (typeof cur.message === 'string' && (NETWORK_MESSAGE.test(cur.message) || /answered 40[37]\b/.test(cur.message))) return true;
  }
  return false;
}

/** Assertions on a live report: what a correct unsigned purchase must look like. */
export function checkLiveReport(report: Report, o: { chainId: number; inputToken: string; amountRaw: bigint; trustedTargets: string[]; trustedSpenders: string[] }) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add('PARSE', report.parse === 'ok', String(report.parse === 'ok' ? 'ok' : JSON.stringify(report.parse)));
  add('VALIDATE', report.validate === 'ok', String(report.validate === 'ok' ? 'ok' : JSON.stringify(report.validate)));
  const tx = report.unsignedTransaction as { to: string; data: string; value: string; chainId: number } | undefined;
  if (!tx) return checks;
  const native = isNativeToken(o.inputToken);
  add('TX_CHAIN_ID', tx.chainId === o.chainId, `tx ${tx.chainId}, bag chain ${o.chainId}`);
  add('TX_TARGET_TRUSTED', o.trustedTargets.map(normalizeAddress).includes(normalizeAddress(tx.to)), `to ${tx.to}`);
  add('TX_HAS_CALLDATA', /^0x[0-9a-fA-F]{8,}$/.test(tx.data), `${Math.max(0, (tx.data.length - 2) / 2)} bytes`);
  add('TX_VALUE', tx.value === (native ? String(o.amountRaw) : '0'), `value ${tx.value} wei (${native ? 'native: must equal the amount' : 'ERC-20: must be 0'})`);
  const approvals = (report.approvals ?? []) as { token: string; spender: string; amountRaw: string }[];
  if (native) add('NO_APPROVAL_FOR_NATIVE', approvals.length === 0, `${approvals.length} approval(s)`);
  else add('APPROVALS_TRUSTED', approvals.every((a) => o.trustedSpenders.map(normalizeAddress).includes(normalizeAddress(a.spender))), approvals.map((a) => a.spender).join(', ') || 'none');
  const q = report.quote as { slippageBps: number; legs: { token: string; expectedOutRaw: string; minOutRaw: string }[] } | undefined;
  const legsOk = !!q && q.legs.length > 0 && q.legs.every((l) => BigInt(l.minOutRaw) > BigInt(0) && BigInt(l.minOutRaw) <= BigInt(l.expectedOutRaw));
  add('LEGS_MIN_OUTPUT', legsOk, q ? q.legs.map((l) => `${l.token}: min ${l.minOutRaw} ≤ expected ${l.expectedOutRaw}`).join('; ') : 'no quote');
  return checks;
}

async function main() {
  const [source, inputToken, amountRaw, signer] = process.argv.slice(2);
  if (!source || !inputToken || !amountRaw || !signer) {
    console.error('Usage: LIFI_API_KEY=... RPC_URL=... COMPOSER_TRUSTED_TARGETS=0x... npx tsx live-compile.ts <bag.json path|URL> <inputToken|0x00…00 for ETH> <amountRaw> <signer>');
    process.exit(2);
  }
  const apiKey = process.env.LIFI_API_KEY;
  const rpcUrl = process.env.RPC_URL;
  const trustedTargets = (process.env.COMPOSER_TRUSTED_TARGETS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const trustedSpenders = (process.env.COMPOSER_TRUSTED_SPENDERS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const missing = [!apiKey && 'LIFI_API_KEY', !rpcUrl && 'RPC_URL', trustedTargets.length === 0 && 'COMPOSER_TRUSTED_TARGETS'].filter(Boolean);
  if (missing.length > 0) {
    console.log(`BLOCKED  not set in this environment: ${missing.join(', ')}`);
    console.log('VERDICT BLOCKED');
    process.exit(3);
  }
  // LI.FI's production Composer API (docs.li.fi quickstart; what BAG uses). Override with COMPOSER_URL.
  const baseUrl = process.env.COMPOSER_URL ?? 'https://composer.li.quest';
  const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as SimulationClient & ContractReader;

  let verdict: Verdict;
  try {
    const chainId = await client.getChainId();
    const report = await run({ source, inputToken, amountRaw: BigInt(amountRaw), signer, provider: lifiComposer({ apiKey: apiKey!, baseUrl }), allowedTransactionTargets: trustedTargets, allowedApprovalSpenders: trustedSpenders, client });
    const checks = checkLiveReport(report, { chainId, inputToken, amountRaw: BigInt(amountRaw), trustedTargets, trustedSpenders });
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
    console.log(`INFO  simulate ${JSON.stringify(report.simulate, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    verdict = checks.length > 2 && checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  } catch (e) {
    verdict = isNetworkBlock(e) ? 'BLOCKED' : 'FAIL';
    console.log(`${verdict}  ${safeError(e)}`);
  }
  console.log(`VERDICT ${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'BLOCKED' ? 3 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(safeError(e));
    process.exit(1);
  });
}
