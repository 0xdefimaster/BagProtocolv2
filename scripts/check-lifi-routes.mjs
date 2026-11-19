// Checks, read-only, whether LI.FI knows a token on Base, Arbitrum or Ethereum and can
// route a USDC buy and sell for it. Sends no transaction and needs no key.
//
// Usage (PowerShell, from the repo root):
//   node scripts/check-lifi-routes.mjs 0xADDR1 0xADDR2 ...
//   node scripts/check-lifi-routes.mjs --file=cas.txt          # one address per line
//   node scripts/check-lifi-routes.mjs --usd=100,1000 0xADDR   # test sizes (default 100,1000)
//   node scripts/check-lifi-routes.mjs --chain=arbitrum 0xADDR # Arbitrum One or ethereum (default: base)
// Optional: set LIFI_API_KEY in the environment for a higher rate limit.

import { readFileSync } from 'node:fs';

const CHAINS = {
  base: { id: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  arbitrum: { id: 42161, usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  ethereum: { id: 1, usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
};
const chainName = (process.argv.find((a) => a.startsWith('--chain=')) || '--chain=base').slice(8);
if (!CHAINS[chainName]) {
  console.error(`Unknown --chain=${chainName}. Use base, arbitrum or ethereum.`);
  process.exit(1);
}
const CHAIN = CHAINS[chainName].id;
const USDC = CHAINS[chainName].usdc;
// Quotes need a sender; this one is only used for simulation, nothing is sent.
const FROM = process.env.QUOTE_FROM || '0x000000000000000000000000000000000000dEaD';
const API = 'https://li.quest/v1';
const HEADERS = process.env.LIFI_API_KEY ? { 'x-lifi-api-key': process.env.LIFI_API_KEY } : {};

const args = process.argv.slice(2);
let sizes = [100, 1000];
const addrs = [];
let coinbase = false;
for (const a of args) {
  if (a.startsWith('--usd=')) sizes = a.slice(6).split(',').map(Number).filter((n) => n > 0);
  else if (a.startsWith('--file=')) addrs.push(...readFileSync(a.slice(7), 'utf8').split(/\s+/));
  else if (a === '--coinbase') coinbase = true;
  else if (a.startsWith('--chain=')) continue;
  else addrs.push(a);
}

// --coinbase: take the token list from Coinbase's official, keyless
// Tokenized Stocks API (docs.base.org/sdks/tokenized-stocks), so no address
// is typed by hand. Prints the issuer's own data next to LI.FI's view.
const official = new Map();
if (coinbase && chainName !== 'base') {
  console.error('--coinbase lists Coinbase tokenized stocks on Base only.');
  process.exit(1);
}
if (coinbase) {
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500', ...(pageToken ? { page_token: pageToken } : {}) });
    const res = await fetch(`https://api.coinbase.com/v1/tokenized-stocks?${q}`);
    if (!res.ok) {
      console.error(`Coinbase Tokenized Stocks API: HTTP ${res.status}`);
      process.exit(1);
    }
    const body = await res.json();
    for (const t of body.tokens || []) {
      official.set(t.contract_address.toLowerCase(), t);
      addrs.push(t.contract_address);
    }
    pageToken = body.next_page_token;
  } while (pageToken);
  console.log(`Coinbase official list: ${official.size} tokenized stock(s) on Base`);
}
const list = [...new Set(addrs.map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s)))];
if (list.length === 0) {
  console.error('No valid 0x addresses given.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }
  return { ok: false, status: 429, body: { message: 'rate limited' } };
}

async function quote(fromToken, toToken, fromAmount) {
  const r = await get('/quote', {
    fromChain: CHAIN, toChain: CHAIN, fromToken, toToken, fromAmount,
    fromAddress: FROM, slippage: '0.03', order: 'CHEAPEST',
  });
  if (!r.ok) return { error: r.body?.message || `HTTP ${r.status}` };
  const e = r.body.estimate || {};
  const fromUSD = Number(e.fromAmountUSD), toUSD = Number(e.toAmountUSD);
  const gasUSD = (e.gasCosts || []).reduce((s, g) => s + Number(g.amountUSD || 0), 0);
  return {
    toAmount: e.toAmount,
    fromUSD, toUSD, gasUSD,
    loss: fromUSD > 0 && toUSD > 0 ? 1 - toUSD / fromUSD : null,
    tool: r.body.toolDetails?.name || r.body.tool,
  };
}

const pct = (x) => (x == null || Number.isNaN(x) ? '   ?  ' : `${(x * 100).toFixed(2).padStart(5)}%`);
const rows = [];

for (const addr of list) {
  const t = await get('/token', { chain: CHAIN, token: addr });
  if (!t.ok) {
    const sym = official.get(addr.toLowerCase())?.symbol || '?';
    console.log(`\n${sym}  ${addr}\n  LI.FI does not know this token on ${chainName} (${t.body?.message || t.status}) -> NO ROUTE`);
    rows.push({ addr, symbol: sym, verdict: 'UNKNOWN' });
    continue;
  }
  const tok = t.body;
  const off = official.get(addr.toLowerCase());
  console.log(`\n${tok.symbol}  ${tok.name}  ${addr}`);
  if (off) {
    console.log(`  Coinbase: ${off.symbol} "${off.name}"  NAV $${off.nav_price ?? '?'} (${off.nav_price_updated_at ?? '?'})  multiplier ${off.multiplier ?? 1}  supply ${off.total_supply ?? 0}  paused ${JSON.stringify(off.paused_features || [])}`);
  }
  console.log(`  LI.FI price $${tok.priceUSD ?? '?'}  verification: ${tok.verificationStatus ?? 'n/a'}  tags: ${(tok.tags || []).join(',') || '-'}`);

  let worst = 0, anyFail = false;
  for (const usd of sizes) {
    const buy = await quote(USDC, addr, String(Math.round(usd * 1e6)));
    if (buy.error) {
      console.log(`  $${usd} buy : NO ROUTE (${buy.error})`);
      anyFail = true;
      continue;
    }
    const sell = await quote(addr, USDC, buy.toAmount);
    const roundTrip = sell.error ? null : 1 - sell.toUSD / buy.fromUSD;
    console.log(`  $${usd} buy : loss ${pct(buy.loss)}  gas $${buy.gasUSD.toFixed(3)}  via ${buy.tool}`);
    console.log(`  $${usd} sell: ${sell.error ? `NO ROUTE (${sell.error})` : `loss ${pct(sell.loss)}  via ${sell.tool}  round trip ${pct(roundTrip)}`}`);
    if (sell.error) anyFail = true;
    else worst = Math.max(worst, roundTrip ?? 0);
  }
  const verdict = anyFail ? 'NO ROUTE' : worst <= 0.02 ? 'OK' : worst <= 0.06 ? 'THIN' : 'ILLIQUID';
  rows.push({ addr, symbol: tok.symbol, verified: tok.verificationStatus, verdict, worst });
  await sleep(300);
}

console.log('\n=== Summary (round trip = buy then sell back to USDC, largest tested size) ===');
for (const r of rows) {
  console.log(`${(r.symbol || '?').padEnd(10)} ${r.addr}  ${(r.verified || '-').padEnd(10)}  ${r.verdict.padEnd(8)} ${r.worst != null ? pct(r.worst) : ''}`);
}
console.log('OK <= 2% round trip, THIN <= 6%, ILLIQUID above. Prices outside US market hours may be wider.');
