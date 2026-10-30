#!/usr/bin/env node
// Drives the REAL signing page (wallet-fork/page) in Chromium with an injected EIP-6963 test provider
// that signs with a local TEST key. It exercises page.js end to end: wallet discovery, connect, chain
// check, decoding every request from its typed data, the mismatch gate and eth_signTypedData_v4.
// The provider announces rdns `local.bag.test-key`, so the runner labels the run
// TEST_KEY_VIA_SIGNING_PAGE, never HUMAN_SIGNATURE. Screenshots of each screen go to --shots.
//   node wallet-fork/page-e2e.mjs --url-file <file written by run.mjs --url-file> [--shots <dir>]
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { accounts } from '../lib/fork-env.mjs';

const args = process.argv.slice(2), arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const file = arg('--url-file'), shots = arg('--shots');
if (shots) mkdirSync(shots, { recursive: true });
for (let i = 0; i < 600 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 500));
const url = readFileSync(file, 'utf8').trim();
const { chromium } = createRequire(import.meta.url)('playwright');
const key = accounts.privateKeyToAccount(accounts.generatePrivateKey());
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const signed = [];
page.on('pageerror', e => console.log('page error:', e.message));
await page.exposeFunction('bagTestSignTypedData', async json => { const td = JSON.parse(json); const { EIP712Domain, ...types } = td.types; const s = await key.signTypedData({ ...td, types }); signed.push(td.primaryType); return s; });
await page.addInitScript(address => {
  let chainId = '0x1';
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
    if (method === 'eth_chainId') return chainId;
    if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
    if (method === 'eth_signTypedData_v4') { if (params[0].toLowerCase() !== address.toLowerCase()) throw new Error('wrong account'); return window.bagTestSignTypedData(params[1]); }
    throw new Error('unsupported in test provider: ' + method);
  } };
  const info = { uuid: '00000000-0000-4000-8000-0000000000aa', name: 'BAG test provider (local TEST key)', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'local.bag.test-key' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
}, key.address);
await page.goto(url);
await page.waitForSelector('#wallet option', { state: 'attached' });
if (shots) await page.screenshot({ path: join(shots, '0-connect.png'), fullPage: true });
await page.click('#connectBtn');
console.log('page-e2e connected', key.address);
const seen = new Set();
for (let i = 0; i < 3000; i++) {
  const phase = await page.textContent('#phase');
  if (/^Bitti|^Reddedildi/.test(phase ?? '')) { console.log('page-e2e done:', phase, (await page.$$eval('#status li', l => l.map(x => x.textContent))).at(-1)); break; }
  const visible = await page.isVisible('#step');
  const title = visible ? await page.textContent('#stepTitle') : null;
  if (visible && title && !seen.has(title)) {
    const mismatch = await page.isVisible('#mismatch');
    if (mismatch) { console.log('page-e2e: page REFUSED to ask for a signature:', await page.textContent('#mismatch')); process.exitCode = 1; break; }
    await page.waitForSelector('#signBtn:not([disabled])');
    seen.add(title);
    if (shots) await page.screenshot({ path: join(shots, `${seen.size}-${title.split(':')[0].replace(/[^\w]+/g, '_')}.png`), fullPage: true });
    await page.click('#signBtn');
    console.log('page-e2e signed:', title);
  }
  await page.waitForTimeout(400);
}
if (shots) await page.screenshot({ path: join(shots, '9-done.png'), fullPage: true });
console.log('page-e2e typed data signed:', signed.join(', '));
await browser.close();
