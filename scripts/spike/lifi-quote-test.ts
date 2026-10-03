/**
 * scripts/spike/lifi-quote-test.ts
 *
 * SPIKE ONLY — not part of BAG production architecture.
 *
 * Purpose: obtain and independently verify ONE FRESH LI.FI quote on
 * Robinhood Chain mainnet (chain 4663), run entirely from your own
 * machine against the real network (no Claude-side web_fetch, no cache,
 * no @lifi/sdk abstraction — plain `fetch` straight to li.quest and to
 * your own RPC).
 *
 * This intentionally does NOT touch:
 *   - lib/blockchain/lifi-*.ts (production LI.FI adapters)
 *   - PurchasePlanner / CapabilityMatrix / BagRouter (do not exist here)
 *   - any multi-asset execution path
 * It is a read-only, single-quote diagnostic. It never signs or sends a
 * transaction.
 *
 * WHY THIS EXISTS: a prior attempt to check LI.FI support for Robinhood
 * Chain went through Claude's own `web_fetch` tool, which only fetches
 * URLs that already appeared in the conversation and may serve cached
 * content — it could not be trusted to prove a *fresh*, *real* API
 * response. This script has none of those constraints: it is a normal
 * Node/tsx process running on YOUR machine, making a normal outbound
 * HTTPS request, which you can independently re-verify (e.g. with curl)
 * if you doubt anything it reports.
 *
 * USAGE
 *   cp .env.example .env.local   # if not already done
 *   # add to .env.local:
 *   #   ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
 *   #   LIFI_API_KEY=            (optional — raises rate limits, not required)
 *   #   LIFI_TEST_ADDRESS=       (optional — any checksummed EVM address;
 *   #                             defaults to a well-known public address.
 *   #                             getQuote never moves funds and does not
 *   #                             require this address to hold a balance.)
 *   npm run spike:lifi-quote
 *
 * OUTPUT
 *   - Human-readable report printed to stdout
 *   - Full machine-readable evidence written to reports/lifi-quote-result.json
 *
 * This script deliberately does NOT proceed to BagRouter integration,
 * atomic composability, or any execution step. It stops after producing
 * one verified (or clearly BLOCKED/FAILED) quote.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  Diagnosis,
  HttpOutcome,
  RpcOutcome,
  classifyLifiResponse,
  classifyRegistryTokens,
  classifyRpcChainId,
} from '../../lib/blockchain/lifi-diagnostics';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_CHAIN_ID_HEX = '0x' + ROBINHOOD_CHAIN_ID.toString(16); // 0x1237

const LIFI_BASE_URL = 'https://li.quest/v1';

// Public, well-known EOA used only as the `fromAddress`/`toAddress` for a
// read-only price quote. LI.FI's /v1/quote endpoint prices a route; it does
// not require this address to hold any balance or to belong to whoever runs
// this script. Override with LIFI_TEST_ADDRESS if you'd rather use your own.
const DEFAULT_TEST_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL;
const LIFI_API_KEY = process.env.LIFI_API_KEY;
const TEST_ADDRESS = process.env.LIFI_TEST_ADDRESS || DEFAULT_TEST_ADDRESS;

// Candidate same-chain pairs to try, in priority order. Symbols only —
// addresses are NEVER hardcoded here. Each candidate is only used if BOTH
// symbols are found, verified canonical/active, in the live registry.
const CANDIDATE_PAIRS: Array<{ from: string; to: string }> = [
  { from: 'ETH', to: 'USDG' },
  { from: 'WETH', to: 'USDG' },
  { from: 'ETH', to: 'USDC' },
  { from: 'WETH', to: 'USDC' },
  { from: 'USDG', to: 'USDC' },
  { from: 'ETH', to: 'USDT' },
  { from: 'WETH', to: 'WBTC' },
];

// Roughly-sane test amount per symbol (kept small — this is a quote, not a
// trade). Falls back to "1 whole token" for anything not listed.
const AMOUNT_BY_SYMBOL: Record<string, number> = {
  ETH: 0.01,
  WETH: 0.01,
  WBTC: 0.001,
  USDG: 10,
  USDC: 10,
  USDT: 10,
  DAI: 10,
};

// -----------------------------------------------------------------------------
// Evidence / report types
// -----------------------------------------------------------------------------

type RawApiCall = {
  label: string;
  method: string;
  url: string;
  queryParams?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  timestampSent: string;
  timestampReceived: string;
  httpStatus: number | null;
  responseHeaders: Record<string, string> | null;
  rawBody: string | null;
  parsedBody: unknown | null;
  networkError: string | null;
};

type FreshnessCheck = {
  requested: {
    sourceUrl: string;
    fromChain: number;
    toChain: number;
    fromToken: string;
    toToken: string;
    amount: string;
    fromAddress: string;
    toAddress: string;
    timestampSent: string;
  };
  received: {
    fromChainId: number | null;
    toChainId: number | null;
    fromTokenAddress: string | null;
    toTokenAddress: string | null;
    fromAmount: string | null;
    timestampReceived: string;
  };
  mismatches: string[];
  fresh: boolean;
};

type Report = {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  reason: string;
  /** Precise failure class (lib/blockchain/lifi-diagnostics.ts) — EGRESS_BLOCKED says nothing about LI.FI or the chain. */
  diagnosis: Diagnosis;
  diagnosisDetail: string;
  chain: { id: number; hex: string };
  testAddressUsed: string;
  rpcCheck: {
    attempted: boolean;
    ok: boolean;
    reportedChainIdHex: string | null;
    error: string | null;
    diagnosis: Diagnosis | null;
  };
  registryCall: RawApiCall | null;
  candidatesConsidered: Array<{
    from: string;
    to: string;
    fromFound: boolean;
    toFound: boolean;
    fromCanonicalOnChain: boolean | null;
    toCanonicalOnChain: boolean | null;
    skippedReason: string | null;
  }>;
  chosenPair: { from: string; to: string } | null;
  quoteCall: RawApiCall | null;
  freshness: FreshnessCheck | null;
  rawApiErrorBody: unknown | null;
  finishedAt: string;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function buildUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function rawFetch(
  label: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  queryParams?: Record<string, string>
): Promise<RawApiCall> {
  const timestampSent = new Date().toISOString();
  const call: RawApiCall = {
    label,
    method: init.method ?? 'GET',
    url,
    queryParams,
    requestHeaders: init.headers,
    requestBody: init.body,
    timestampSent,
    timestampReceived: '',
    httpStatus: null,
    responseHeaders: null,
    rawBody: null,
    parsedBody: null,
    networkError: null,
  };

  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const rawBody = await res.text();
    call.timestampReceived = new Date().toISOString();
    call.httpStatus = res.status;
    call.responseHeaders = headersToObject(res.headers);
    call.rawBody = rawBody;
    try {
      call.parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      call.parsedBody = null; // not JSON — rawBody above still preserves everything
    }
  } catch (err) {
    call.timestampReceived = new Date().toISOString();
    call.networkError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return call;
}

/** JSON-RPC call returning the FULL outcome (transport error / HTTP status / JSON-RPC error / result) — never collapsed to null. */
async function rpcRaw(rpcUrl: string, method: string, params: unknown[]): Promise<RpcOutcome> {
  const out: RpcOutcome = { status: null, headers: null, body: null, rawBody: null, networkError: null, jsonRpcError: null, result: null };
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    out.status = res.status;
    out.headers = headersToObject(res.headers);
    out.rawBody = await res.text();
    try {
      const json = JSON.parse(out.rawBody) as { result?: unknown; error?: unknown };
      out.body = json;
      out.jsonRpcError = json.error ?? null;
      out.result = json.result ?? null;
    } catch {
      /* non-JSON body — kept in rawBody */
    }
  } catch (err) {
    out.networkError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return out;
}

/** Back-compat helper: the result, or null on ANY failure (use rpcRaw when the failure class matters). */
async function rpcCall<T = unknown>(rpcUrl: string, method: string, params: unknown[]): Promise<T | null> {
  const o = await rpcRaw(rpcUrl, method, params);
  return o.status === 200 && !o.jsonRpcError ? ((o.result as T) ?? null) : null;
}

const asHttp = (c: RawApiCall): HttpOutcome => ({ status: c.httpStatus, headers: c.responseHeaders, body: c.parsedBody, rawBody: c.rawBody, networkError: c.networkError });

function printSection(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const report: Report = {
    status: 'BLOCKED',
    reason: 'Not started',
    diagnosis: 'ENV_MISSING',
    diagnosisDetail: '',
    chain: { id: ROBINHOOD_CHAIN_ID, hex: ROBINHOOD_CHAIN_ID_HEX },
    testAddressUsed: TEST_ADDRESS,
    rpcCheck: { attempted: false, ok: false, reportedChainIdHex: null, error: null, diagnosis: null },
    registryCall: null,
    candidatesConsidered: [],
    chosenPair: null,
    quoteCall: null,
    freshness: null,
    rawApiErrorBody: null,
    finishedAt: '',
  };

  printSection('STEP 0 — Environment check');
  if (!ROBINHOOD_RPC_URL) {
    report.status = 'BLOCKED';
    report.diagnosis = 'ENV_MISSING';
    report.diagnosisDetail = 'ROBINHOOD_RPC_URL';
    report.reason =
      'ROBINHOOD_RPC_URL is not set. This script refuses to guess an RPC endpoint — set ' +
      'ROBINHOOD_RPC_URL in your environment (e.g. .env.local) and re-run.';
    console.log('BLOCKED: ' + report.reason);
    finish(report);
    return;
  }
  console.log('ROBINHOOD_RPC_URL: set');
  console.log('LIFI_API_KEY: ' + (LIFI_API_KEY ? 'set' : 'not set (unauthenticated request — should still work)'));
  console.log('Test address (fromAddress/toAddress for quote pricing only): ' + TEST_ADDRESS);

  // ---- STEP 1: independently confirm the RPC actually answers as chain 4663
  printSection('STEP 1 — Confirm ROBINHOOD_RPC_URL reports chain id 4663');
  report.rpcCheck.attempted = true;
  const chainIdOutcome = await rpcRaw(ROBINHOOD_RPC_URL, 'eth_chainId', []);
  const rpcClass = classifyRpcChainId(chainIdOutcome, ROBINHOOD_CHAIN_ID);
  report.rpcCheck.diagnosis = rpcClass.diagnosis;
  const chainIdHex = typeof chainIdOutcome.result === 'string' ? chainIdOutcome.result : null;
  report.rpcCheck.reportedChainIdHex = chainIdHex;
  console.log(`RPC diagnosis: ${rpcClass.diagnosis} — ${rpcClass.detail}`);
  if (rpcClass.diagnosis !== 'OK' && rpcClass.diagnosis !== 'RPC_WRONG_CHAIN') {
    report.rpcCheck.ok = false;
    report.rpcCheck.error = `${rpcClass.diagnosis}: ${rpcClass.detail}`;
    console.log('BLOCKED-risk: could not reach ROBINHOOD_RPC_URL for eth_chainId. Continuing to LI.FI checks, but on-chain canonical verification will be skipped.');
  } else if (rpcClass.diagnosis === 'RPC_WRONG_CHAIN') {
    report.rpcCheck.ok = false;
    report.rpcCheck.error = `RPC reported chain id ${chainIdHex}, expected ${ROBINHOOD_CHAIN_ID_HEX} (4663).`;
    report.status = 'BLOCKED';
    report.diagnosis = 'RPC_WRONG_CHAIN';
    report.diagnosisDetail = rpcClass.detail;
    report.reason = report.rpcCheck.error;
    console.log('BLOCKED: ' + report.reason);
    finish(report);
    return;
  } else {
    report.rpcCheck.ok = true;
    console.log(`RPC confirms chain id ${chainIdHex} = ${ROBINHOOD_CHAIN_ID} decimal. OK.`);
  }

  // ---- STEP 2: fetch LI.FI's own token registry for chain 4663 (no assumptions)
  printSection('STEP 2 — Fetch LI.FI token registry for chain 4663');
  const registryUrl = buildUrl(`${LIFI_BASE_URL}/tokens`, { chains: String(ROBINHOOD_CHAIN_ID) });
  const registryHeaders: Record<string, string> = { accept: 'application/json' };
  if (LIFI_API_KEY) registryHeaders['x-lifi-api-key'] = LIFI_API_KEY;

  const registryCall = await rawFetch('registry', registryUrl, { headers: registryHeaders }, {
    chains: String(ROBINHOOD_CHAIN_ID),
  });
  report.registryCall = registryCall;

  const registryClass = classifyLifiResponse(asHttp(registryCall), 'registry');
  report.diagnosis = registryClass.diagnosis;
  report.diagnosisDetail = registryClass.detail;
  console.log(`LI.FI registry diagnosis: ${registryClass.diagnosis} — ${registryClass.detail}`);
  if (registryClass.diagnosis === 'EGRESS_BLOCKED') {
    report.status = 'BLOCKED';
    report.reason = `An egress proxy refused li.quest before it was reached (${registryClass.detail}). This says NOTHING about LI.FI or chain 4663 — run from a machine with normal internet access.`;
    console.log('BLOCKED: ' + report.reason);
    finish(report);
    return;
  }
  if (registryCall.networkError) {
    report.status = 'BLOCKED';
    report.reason = `Network error reaching li.quest token registry: ${registryCall.networkError}`;
    console.log('BLOCKED: ' + report.reason);
    finish(report);
    return;
  }
  if (registryCall.httpStatus !== 200) {
    report.status = 'FAIL';
    report.reason = `LI.FI token registry returned HTTP ${registryCall.httpStatus}.`;
    report.rawApiErrorBody = registryCall.parsedBody ?? registryCall.rawBody;
    console.log('FAIL: ' + report.reason);
    console.log('RAW ERROR BODY:');
    console.log(registryCall.rawBody);
    finish(report);
    return;
  }

  const registryBody = registryCall.parsedBody as { tokens?: Record<string, Array<{
    address: string; symbol: string; decimals: number; chainId: number; name?: string; priceUSD?: string;
  }>> } | null;

  const tokensForChain = registryBody?.tokens?.[String(ROBINHOOD_CHAIN_ID)] ?? [];
  console.log(`Registry returned ${tokensForChain.length} token(s) for chain ${ROBINHOOD_CHAIN_ID}.`);
  if (tokensForChain.length === 0) {
    report.status = 'FAIL';
    report.diagnosis = classifyRegistryTokens(0).diagnosis;
    report.diagnosisDetail = classifyRegistryTokens(0).detail;
    report.reason = 'LI.FI token registry returned zero tokens for chain 4663 — LI.FI does not currently list any assets on this chain.';
    console.log('FAIL: ' + report.reason);
    finish(report);
    return;
  }

  const findToken = (symbol: string) =>
    tokensForChain.find((t) => t.symbol?.toUpperCase() === symbol.toUpperCase() && t.chainId === ROBINHOOD_CHAIN_ID);

  // ---- STEP 3: pick a candidate pair, verifying each leg independently
  printSection('STEP 3 — Select a candidate pair (registry + on-chain canonical check)');
  let chosen: { from: string; to: string; fromToken: NonNullable<ReturnType<typeof findToken>>; toToken: NonNullable<ReturnType<typeof findToken>> } | null = null;

  for (const candidate of CANDIDATE_PAIRS) {
    const fromToken = findToken(candidate.from);
    const toToken = findToken(candidate.to);
    const entry = {
      from: candidate.from,
      to: candidate.to,
      fromFound: !!fromToken,
      toFound: !!toToken,
      fromCanonicalOnChain: null as boolean | null,
      toCanonicalOnChain: null as boolean | null,
      skippedReason: null as string | null,
    };

    if (!fromToken || !toToken) {
      entry.skippedReason = `${!fromToken ? candidate.from : candidate.to} not found in LI.FI registry for chain 4663.`;
      report.candidatesConsidered.push(entry);
      console.log(`  ${candidate.from}->${candidate.to}: SKIP (${entry.skippedReason})`);
      continue;
    }

    // Independently verify each non-native token address has deployed code
    // on-chain, via the user's own RPC — do not just trust LI.FI's list.
    const checkCanonical = async (addr: string): Promise<boolean | null> => {
      const isNativePlaceholder = addr.toLowerCase() === '0x0000000000000000000000000000000000000000' || addr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      if (isNativePlaceholder) return true; // native asset, no contract code expected
      if (!report.rpcCheck.ok) return null; // RPC unavailable — cannot verify, not a false pass
      const code = await rpcCall<string>(ROBINHOOD_RPC_URL, 'eth_getCode', [addr, 'latest']);
      if (code === null) return null;
      return code !== '0x' && code !== '0x0';
    };

    entry.fromCanonicalOnChain = await checkCanonical(fromToken.address);
    entry.toCanonicalOnChain = await checkCanonical(toToken.address);

    const fromOk = entry.fromCanonicalOnChain !== false;
    const toOk = entry.toCanonicalOnChain !== false;

    if (!fromOk || !toOk) {
      entry.skippedReason = 'On-chain eth_getCode check found no contract at the registry-listed address (not canonical).';
      report.candidatesConsidered.push(entry);
      console.log(`  ${candidate.from}->${candidate.to}: SKIP (${entry.skippedReason})`);
      continue;
    }

    report.candidatesConsidered.push(entry);
    console.log(
      `  ${candidate.from}->${candidate.to}: candidate accepted ` +
        `(from=${fromToken.address}, to=${toToken.address}, canonical-verified=${entry.fromCanonicalOnChain}/${entry.toCanonicalOnChain})`
    );
    chosen = { from: candidate.from, to: candidate.to, fromToken, toToken };
    break;
  }

  if (!chosen) {
    report.status = 'FAIL';
    report.reason = 'No candidate pair passed both LI.FI-registry-presence and on-chain canonical verification. See candidatesConsidered for details.';
    console.log('FAIL: ' + report.reason);
    finish(report);
    return;
  }

  report.chosenPair = { from: chosen.from, to: chosen.to };

  // ---- STEP 4: request ONE fresh quote for the chosen pair
  printSection(`STEP 4 — Request fresh LI.FI quote: ${chosen.from} -> ${chosen.to} (same chain 4663)`);
  const amountTokens = AMOUNT_BY_SYMBOL[chosen.from.toUpperCase()] ?? 1;
  const fromAmount = BigInt(Math.round(amountTokens * 10 ** chosen.fromToken.decimals)).toString();

  const quoteParams: Record<string, string> = {
    fromChain: String(ROBINHOOD_CHAIN_ID),
    toChain: String(ROBINHOOD_CHAIN_ID),
    fromToken: chosen.fromToken.address,
    toToken: chosen.toToken.address,
    fromAmount,
    fromAddress: TEST_ADDRESS,
    toAddress: TEST_ADDRESS,
  };
  const quoteUrl = buildUrl(`${LIFI_BASE_URL}/quote`, quoteParams);
  const quoteHeaders: Record<string, string> = { accept: 'application/json' };
  if (LIFI_API_KEY) quoteHeaders['x-lifi-api-key'] = LIFI_API_KEY;

  console.log('Requesting:', quoteUrl);
  const quoteCall = await rawFetch('quote', quoteUrl, { headers: quoteHeaders }, quoteParams);
  report.quoteCall = quoteCall;

  const quoteClass = classifyLifiResponse(asHttp(quoteCall), 'quote');
  report.diagnosis = quoteClass.diagnosis;
  report.diagnosisDetail = quoteClass.detail;
  console.log(`LI.FI quote diagnosis: ${quoteClass.diagnosis} — ${quoteClass.detail}`);
  if (quoteCall.networkError || quoteClass.diagnosis === 'EGRESS_BLOCKED') {
    report.status = 'BLOCKED';
    report.reason = `Network error reaching li.quest /v1/quote: ${quoteCall.networkError}`;
    console.log('BLOCKED: ' + report.reason);
    finish(report);
    return;
  }

  if (quoteCall.httpStatus !== 200) {
    report.status = 'FAIL';
    report.reason = `LI.FI /v1/quote returned HTTP ${quoteCall.httpStatus}.`;
    report.rawApiErrorBody = quoteCall.parsedBody ?? quoteCall.rawBody;
    console.log('FAIL: ' + report.reason);
    console.log('COMPLETE RAW API ERROR BODY:');
    console.log(quoteCall.rawBody);
    finish(report);
    return;
  }

  // ---- STEP 5: freshness check — response must match THIS exact request
  printSection('STEP 5 — Freshness / identity check');
  const quoteBody = quoteCall.parsedBody as {
    action?: { fromChainId?: number; toChainId?: number; fromToken?: { address?: string }; toToken?: { address?: string } };
    estimate?: { fromAmount?: string };
  } | null;

  const freshness: FreshnessCheck = {
    requested: {
      sourceUrl: quoteUrl,
      fromChain: ROBINHOOD_CHAIN_ID,
      toChain: ROBINHOOD_CHAIN_ID,
      fromToken: chosen.fromToken.address,
      toToken: chosen.toToken.address,
      amount: fromAmount,
      fromAddress: TEST_ADDRESS,
      toAddress: TEST_ADDRESS,
      timestampSent: quoteCall.timestampSent,
    },
    received: {
      fromChainId: quoteBody?.action?.fromChainId ?? null,
      toChainId: quoteBody?.action?.toChainId ?? null,
      fromTokenAddress: quoteBody?.action?.fromToken?.address ?? null,
      toTokenAddress: quoteBody?.action?.toToken?.address ?? null,
      fromAmount: quoteBody?.estimate?.fromAmount ?? null,
      timestampReceived: quoteCall.timestampReceived,
    },
    mismatches: [],
    fresh: false,
  };

  const eqAddr = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

  if (freshness.received.fromChainId !== ROBINHOOD_CHAIN_ID) {
    freshness.mismatches.push(`fromChainId mismatch: requested ${ROBINHOOD_CHAIN_ID}, received ${freshness.received.fromChainId}`);
  }
  if (freshness.received.toChainId !== ROBINHOOD_CHAIN_ID) {
    freshness.mismatches.push(`toChainId mismatch: requested ${ROBINHOOD_CHAIN_ID}, received ${freshness.received.toChainId}`);
  }
  if (!eqAddr(freshness.received.fromTokenAddress, chosen.fromToken.address)) {
    freshness.mismatches.push(`fromToken mismatch: requested ${chosen.fromToken.address}, received ${freshness.received.fromTokenAddress}`);
  }
  if (!eqAddr(freshness.received.toTokenAddress, chosen.toToken.address)) {
    freshness.mismatches.push(`toToken mismatch: requested ${chosen.toToken.address}, received ${freshness.received.toTokenAddress}`);
  }
  if (freshness.received.fromAmount !== fromAmount) {
    freshness.mismatches.push(`fromAmount mismatch: requested ${fromAmount}, received ${freshness.received.fromAmount}`);
  }

  freshness.fresh = freshness.mismatches.length === 0;
  report.freshness = freshness;

  if (!freshness.fresh) {
    report.status = 'FAIL';
    report.diagnosis = 'LIFI_RESPONSE_MISMATCH';
    report.diagnosisDetail = freshness.mismatches.join('; ');
    report.reason = 'Response failed the freshness/identity check — it does not correspond to the exact request sent. Rejected (this is the stale/cached-response failure mode this check exists to catch).';
    console.log('FAIL: ' + report.reason);
    freshness.mismatches.forEach((m) => console.log('  - ' + m));
    finish(report);
    return;
  }

  console.log('Freshness check PASSED — response matches request on chain, tokens, and amount.');
  console.log(`  Requested at: ${freshness.requested.timestampSent}`);
  console.log(`  Received at:  ${freshness.received.timestampReceived}`);

  // ---- STEP 6: PASS
  report.status = 'PASS';
  report.diagnosis = 'OK';
  report.reason = `Fresh, verified LI.FI quote obtained for ${chosen.from}->${chosen.to} on Robinhood Chain (4663).`;
  printSection('RESULT: PASS');
  console.log(report.reason);
  console.log(`fromAmount: ${fromAmount} ${chosen.from} -> toAmount: ${quoteBody?.estimate ? (quoteBody as any).estimate.toAmount : '(see JSON)'} ${chosen.to}`);

  finish(report);
}

function finish(report: Report) {
  report.finishedAt = new Date().toISOString();
  const outPath = resolve(process.cwd(), 'reports/lifi-quote-result.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  printSection(`FINAL STATUS: ${report.status}  (diagnosis: ${report.diagnosis})`);
  console.log(report.reason);
  if (report.diagnosisDetail) console.log(`detail: ${report.diagnosisDetail}`);
  console.log(`Full evidence written to: ${outPath}`);

  if (report.status !== 'PASS') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('UNEXPECTED SCRIPT ERROR (not a LI.FI/BLOCKED/FAIL classification — the script itself threw):');
  console.error(err);
  process.exitCode = 2;
});
