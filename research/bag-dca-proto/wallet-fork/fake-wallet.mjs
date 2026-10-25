#!/usr/bin/env node
// Automated stand-in for the signing page, for testing the human-signature mode end to end without a
// browser: it talks to the local server exactly like page.js (same headers, same lib/sign-checks.mjs),
// refuses on any mismatch, and signs with a local TEST key. Its signatures are TEST_KEY evidence, never
// a substitute for a MetaMask/Rabby signature.
//   node wallet-fork/fake-wallet.mjs --url-file <file written by run.mjs --url-file>
import { readFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { accounts } from '../lib/fork-env.mjs';
import { stripEip712Domain } from '../lib/typed-data.mjs';
import { checkDelegationStep, checkUserOpStep } from '../lib/sign-checks.mjs';

const args = process.argv.slice(2), arg = n => args[args.indexOf(n) + 1];
const file = arg('--url-file');
for (let i = 0; i < 600 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 500));
const url = new URL(readFileSync(file, 'utf8').trim()), secret = url.hash.slice(1), host = url.host, origin = `http://${host}`;
const call = (method, path, body) => new Promise((resolve, reject) => {
  const req = request({ host: url.hostname, port: url.port, method, path, headers: { host, origin, 'x-bag-session': secret, ...(body ? { 'content-type': 'application/json' } : {}) } },
    res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => (res.statusCode < 300 ? resolve(JSON.parse(d)) : reject(new Error(`${res.statusCode} ${d}`)))); });
  req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
});
const key = accounts.privateKeyToAccount(accounts.generatePrivateKey());
await call('POST', '/api/account', { address: key.address, chainId: 4663 });
console.log('fake-wallet connected', key.address);
const seen = new Set();
for (;;) {
  const s = await call('GET', '/api/state');
  if (s.phase === 'DONE' || s.phase === 'REJECTED') { console.log('fake-wallet done:', s.phase, s.status.at(-1)?.text); break; }
  const p = s.pending;
  if (p && !seen.has(p.id)) {
    seen.add(p.id);
    const { bad } = p.kind === 'delegation' ? checkDelegationStep(p) : checkUserOpStep(p);
    if (bad.length) { console.log('fake-wallet REFUSES', p.id, bad); await call('POST', '/api/reject', { stepId: p.id, reason: bad.join('; ') }); process.exit(1); }
    const signature = await key.signTypedData(stripEip712Domain(p.typedData));
    await call('POST', '/api/signature', { stepId: p.id, signature });
    console.log('fake-wallet signed', p.id);
  }
  await new Promise(r => setTimeout(r, 300));
}
