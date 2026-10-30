import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSigningServer } from '../wallet-fork/server.mjs';
import { v, accounts } from '../lib/fork-env.mjs';
import { delegationTypedData, stripEip712Domain, toWire } from '../lib/typed-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raw = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers })); });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('loopback signing server: host, origin, secret, size, step binding and signer checks', async () => {
  const s = await startSigningServer({ port: 0, pageDir: join(here, '..', 'wallet-fork/page'), libDir: join(here, '..', 'lib') });
  const host = `127.0.0.1:${s.port}`, origin = `http://${host}`, H = { host, 'x-bag-session': s.secret };
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{64}$/);
    assert.equal((await raw(s.port, { headers: { host } })).status, 200);
    const page = await raw(s.port, { headers: { host } }); assert.match(page.headers['content-security-policy'], /default-src 'self'/); assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.equal((await raw(s.port, { headers: { host: 'evil.example:80' } })).status, 421, 'DNS-rebinding host refused');
    assert.equal((await raw(s.port, { path: '/../package.json', headers: { host } })).status, 404, 'no path traversal / arbitrary files');
    assert.equal((await raw(s.port, { path: '/api/state', headers: { host } })).status, 403, 'secret required');
    assert.equal((await raw(s.port, { path: '/api/state', headers: { host, 'x-bag-session': 'f'.repeat(64) } })).status, 403, 'wrong secret');
    assert.equal((await raw(s.port, { path: '/api/state', headers: { ...H, origin: 'https://evil.example' } })).status, 403, 'foreign origin refused');
    const post = (path, obj, extra = {}) => raw(s.port, { method: 'POST', path, headers: { ...H, origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(obj) });
    assert.equal((await raw(s.port, { method: 'POST', path: '/api/account', headers: { ...H, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'POST without origin refused');
    assert.equal((await raw(s.port, { method: 'POST', path: '/api/account', headers: { ...H, origin, 'content-type': 'text/plain' }, body: '{}' })).status, 415, 'non-JSON refused (no simple form posts)');
    assert.equal((await post('/api/account', { pad: 'x'.repeat(70000) })).status, 413, 'body cap');
    assert.equal((await post('/api/account', { address: '0x12', chainId: 4663 })).status, 400);
    const user = accounts.privateKeyToAccount(accounts.generatePrivateKey()), other = accounts.privateKeyToAccount(accounts.generatePrivateKey());
    assert.equal((await post('/api/account', { address: user.address, chainId: 1 })).status, 400, 'wrong chain refused');
    const acc = s.waitForAccount();
    assert.equal((await post('/api/account', { address: user.address, chainId: 4663, wallet: 'MetaMask (io.metamask)<script>' + 'x'.repeat(100) })).status, 200); assert.equal(await acc, user.address);
    assert.deepEqual(s.state().walletClient, { name: ('MetaMask (io.metamask)script' + 'x'.repeat(100)).slice(0, 64), automated: false }, 'wallet name sanitized and capped; not automated unless declared');
    assert.equal((await post('/api/account', { address: other.address, chainId: 4663 })).status, 409, 'account cannot be replaced');
    const td = delegationTypedData({ delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', delegate: other.address, delegator: user.address, caveats: [], salt: 1n });
    const signed = s.requestSignature({ id: 'D1', kind: 'delegation', title: 't', typedData: toWire(td) });
    assert.equal((await post('/api/signature', { stepId: 'D2', signature: '0x' + '1'.repeat(130) })).status, 409, 'only the pending step');
    const wrongSigner = await other.signTypedData(stripEip712Domain(td));
    assert.match((await post('/api/signature', { stepId: 'D1', signature: wrongSigner })).body, /not the connected account/);
    const otherData = await user.signTypedData(stripEip712Domain({ ...td, message: { ...td.message, salt: 2n } }));
    assert.equal((await post('/api/signature', { stepId: 'D1', signature: otherData })).status, 400, 'signature over different data refused');
    const good = await user.signTypedData(stripEip712Domain(td));
    assert.equal((await post('/api/signature', { stepId: 'D1', signature: good })).status, 200); assert.equal(await signed, good);
    assert.equal((await post('/api/signature', { stepId: 'D1', signature: good })).status, 409, 'no replay of a completed step');
    const state = JSON.parse((await raw(s.port, { path: '/api/state', headers: H })).body);
    assert.equal(state.history.length, 1); assert.equal(state.pending, null);
  } finally { await s.close(); }
});
