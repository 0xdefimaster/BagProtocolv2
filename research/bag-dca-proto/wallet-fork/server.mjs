// Local signing server for the wallet-fork runner. Loopback only.
// Defences: binds 127.0.0.1; Host must be exactly 127.0.0.1:<port> (DNS rebinding); API calls need
// the random session secret in the X-BAG-Session header (carried in the URL fragment, never sent as a
// query string); POST must come from Origin http://127.0.0.1:<port> with JSON content; bodies are
// capped; a signature is accepted only for the pending step and only if it recovers to the connected
// account over exactly that typed data. No CORS headers are ever sent.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v } from '../lib/fork-env.mjs';
import { stripEip712Domain } from '../lib/typed-data.mjs';

const MAX_BODY = 64 * 1024;
const STATIC = { '/': ['page', 'index.html', 'text/html; charset=utf-8'], '/page.js': ['page', 'page.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['page', 'style.css', 'text/css; charset=utf-8'], '/lib/dca-rules.mjs': ['lib', 'dca-rules.mjs', 'text/javascript; charset=utf-8'],
  '/lib/sign-checks.mjs': ['lib', 'sign-checks.mjs', 'text/javascript; charset=utf-8'] };
const wire = x => JSON.stringify(x, (_k, a) => (typeof a === 'bigint' ? a.toString() : a));

export async function startSigningServer({ port = 0, pageDir, libDir, now = () => Date.now() }) {
  const secret = randomBytes(32).toString('hex');
  const st = { phase: 'AWAITING_ACCOUNT', account: null, pending: null, history: [], status: [], rejected: null };
  let onAccount, onSignature = new Map();
  const accountPromise = new Promise(r => (onAccount = r));
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { ...headers, 'content-type': type }); res.end(typeof body === 'string' ? body : wire(body)); };
  const okSecret = h => { const a = Buffer.from(String(h ?? '')), b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); };
  let actualPort;
  const server = createServer(async (req, res) => {
    try {
      const host = `127.0.0.1:${actualPort}`;
      if (req.headers.host !== host) return send(res, 421, { error: 'host not allowed' });
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, { error: 'origin not allowed' });
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [dir, file, type] = STATIC[url.pathname];
        return send(res, 200, readFileSync(join(dir === 'page' ? pageDir : libDir, file), 'utf8'), type);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!okSecret(req.headers['x-bag-session'])) return send(res, 403, { error: 'session secret missing or wrong' });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { phase: st.phase, account: st.account, pending: st.pending, history: st.history, status: st.status });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (origin !== `http://${host}`) return send(res, 403, { error: 'origin required' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      let body = '', size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: 'body too large' }); body += c; }
      let msg; try { msg = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
      if (url.pathname === '/api/account') {
        if (st.phase !== 'AWAITING_ACCOUNT') return send(res, 409, { error: 'account already set' });
        if (!/^0x[0-9a-fA-F]{40}$/.test(msg.address ?? '')) return send(res, 400, { error: 'bad address' });
        if (Number(msg.chainId) !== 4663) return send(res, 400, { error: 'wallet must be on Robinhood Chain (4663)' });
        st.account = v.getAddress(msg.address); st.phase = 'PREPARING'; st.status.push({ at: now(), text: `Hesap bağlandı: ${st.account}` }); onAccount(st.account);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/signature' || url.pathname === '/api/reject') {
        const p = st.pending;
        if (!p || msg.stepId !== p.id) return send(res, 409, { error: 'no such pending step' });
        if (url.pathname === '/api/reject') { st.rejected = { stepId: p.id, reason: String(msg.reason ?? '').slice(0, 200) }; st.pending = null; st.phase = 'REJECTED'; onSignature.get(p.id)?.reject(new Error('user rejected ' + p.id)); return send(res, 200, { ok: true }); }
        if (!/^0x[0-9a-fA-F]{130}$/.test(msg.signature ?? '')) return send(res, 400, { error: 'signature must be 65 bytes' });
        let recovered; try { recovered = await v.recoverTypedDataAddress({ ...stripEip712Domain(p.typedData), signature: msg.signature }); } catch { return send(res, 400, { error: 'signature does not decode' }); }
        if (recovered !== st.account) return send(res, 400, { error: `signature is from ${recovered}, not the connected account` });
        st.history.push({ id: p.id, title: p.title, signedAt: now() }); st.pending = null; st.phase = 'WORKING';
        onSignature.get(p.id)?.resolve(msg.signature); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: 'internal' }); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}/#${secret}`, port: actualPort, secret,
    waitForAccount: () => accountPromise,
    requestSignature(step) {
      st.pending = JSON.parse(wire(step)); st.phase = 'AWAITING_SIGNATURE';
      return new Promise((resolve, reject) => onSignature.set(step.id, { resolve, reject }));
    },
    setStatus(text) { st.status.push({ at: now(), text }); if (/^Bitti|^Hata/.test(text)) st.phase = 'DONE'; },
    state: () => st,
    close: ({ keepOpenMs = 0 } = {}) => new Promise(r => setTimeout(() => server.close(() => r()), keepOpenMs)),
  };
}
