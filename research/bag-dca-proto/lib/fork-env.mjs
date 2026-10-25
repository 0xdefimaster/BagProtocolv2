// Isolated Robinhood Chain fork behind a read-only relay. Shared by wallet-fork/run.mjs and
// shadow/measure.ts. Nothing here can reach a public network with a write: every upstream request
// (single or batch) must use an allowlisted read method, otherwise the whole request is refused and
// counted. Local fork transactions are counted separately and never leave the process.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const protoRequire = createRequire(join(here, '..', 'package.json'));
export const v = protoRequire('viem');
export const accounts = protoRequire('viem/accounts');
export const aa = protoRequire('viem/account-abstraction');
export const kit = protoRequire('@metamask/smart-accounts-kit');
const solc = protoRequire('solc');

export const READ_METHODS = Object.freeze(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode',
  'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getProof']);
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const CHAIN_ID = 4663;

/** Starts the relay. `stats` records every forwarded method, every refused request and retries. */
export async function startRelay(rpcUrl) {
  const allowed = new Set(READ_METHODS);
  const stats = { allowlist: READ_METHODS, forwardedRequests: 0, forwardedByMethod: {}, refusedRequests: 0, refusedMethods: {}, retries: 0, upstreamErrors: {}, failures: 0 };
  let inflight = 0; const waiters = [];
  const acquire = async () => { while (inflight >= 4) await new Promise(r => waiters.push(r)); inflight++; };
  const release = () => { inflight--; waiters.shift()?.(); };
  async function upstream(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
        const text = await r.text();
        const transient = r.status === 429 || r.status >= 500 || (/rate limit|too many requests/i.test(text) && !/execution reverted/i.test(text));
        if (!transient || attempt >= 5) { if (transient) stats.failures++; return { status: r.status, text }; }
        stats.upstreamErrors[String(r.status)] = (stats.upstreamErrors[String(r.status)] ?? 0) + 1;
      } catch (e) {
        stats.upstreamErrors.network = (stats.upstreamErrors.network ?? 0) + 1;
        if (attempt >= 5) { stats.failures++; throw e; }
      }
      stats.retries++; await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const c of req) { body += c; if (body.length > 2_000_000) throw new Error('too large'); }
      const calls = [].concat(JSON.parse(body));
      // A batch with ANY non-read method is refused as a whole.
      if (calls.length === 0 || calls.some(c => !allowed.has(c?.method))) {
        stats.refusedRequests++; for (const c of calls) stats.refusedMethods[String(c?.method)] = (stats.refusedMethods[String(c?.method)] ?? 0) + 1;
        res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"read-only relay"}}'); return;
      }
      stats.forwardedRequests++; for (const c of calls) stats.forwardedByMethod[c.method] = (stats.forwardedByMethod[c.method] ?? 0) + 1;
      await acquire();
      try { const r = await upstream(body); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text); } finally { release(); }
    } catch { res.writeHead(502); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream unavailable"}}'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  // Self-test: writes (single and in a batch) are refused before anything else runs.
  const single = await fetch(url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}' });
  const batch = await fetch(url, { method: 'POST', body: '[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_sendTransaction","params":[{}]}]' });
  if (single.status !== 403 || batch.status !== 403) throw new Error('relay self-test failed: write method was not refused');
  stats.selfTest = { singleWriteRefused: true, batchWithWriteRefused: true };
  stats.refusedRequests = 0; stats.refusedMethods = {};
  return { url, stats, close: () => new Promise(r => server.close(r)) };
}

export function chainFor(url) {
  return v.defineChain({ id: CHAIN_ID, name: 'ISOLATED Robinhood fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
}

/**
 * Creates a fork at `blockNumber` (default: latest). Fork-only state edits made through `edit`
 * are recorded in `changes`, so the report lists every setCode/setBalance/impersonation.
 */
export async function createFork({ relayUrl, out, blockNumber, label }) {
  const chain = chainFor(relayUrl);
  const remote = v.createPublicClient({ chain, transport: v.http(relayUrl) });
  // Load-balanced RPC nodes can disagree on "latest" by a block or two; fork a few blocks back.
  const latest = blockNumber === undefined ? (await remote.getBlock()).number - 3n : BigInt(blockNumber);
  const block = await remote.getBlock({ blockNumber: latest });
  const { createHardhatRuntimeEnvironment } = await import(pathToFileURL(protoRequire.resolve('hardhat/hre')).href);
  const hre = await createHardhatRuntimeEnvironment({ paths: { cache: join(out, 'cache') }, chainDescriptors: { [CHAIN_ID]: { name: 'Robinhood fork (research)', chainType: 'l1', hardforkHistory: { cancun: { blockNumber: 0 } } } },
    networks: { fork: { type: 'edr-simulated', chainId: CHAIN_ID, chainType: 'l1', hardfork: 'cancun', forking: { url: relayUrl, blockNumber: Number(block.number) }, throwOnTransactionFailures: true } } });
  const connection = await hre.network.connect('fork');
  const transport = v.custom({ request: x => connection.provider.request(x) });
  const client = v.createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 10 });
  const rpc = (method, params = []) => client.request({ method, params });
  const changes = [], localTx = { sent: 0 };
  const edit = async (kind, method, params, note) => { changes.push({ kind, method, target: params[0], note, at: changes.length }); return rpc(method, params); };
  const wallet = account => {
    const w = v.createWalletClient({ account, chain, transport });
    return new Proxy(w, { get: (t, k) => (['sendTransaction', 'writeContract', 'deployContract'].includes(k) ? async (...a) => { localTx.sent++; return t[k](...a); } : t[k]) });
  };
  return { label, chain, remote, client, rpc, edit, changes, localTx, wallet, transport,
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, close: () => connection.close?.() };
}

/** A plain local EDR chain (no fork, no RPC): for contract unit tests. */
export async function createLocalChain({ out }) {
  const { createHardhatRuntimeEnvironment } = await import(pathToFileURL(protoRequire.resolve('hardhat/hre')).href);
  const hre = await createHardhatRuntimeEnvironment({ paths: { cache: join(out, 'cache') },
    networks: { local: { type: 'edr-simulated', chainId: 31337, chainType: 'l1', hardfork: 'cancun', throwOnTransactionFailures: true } } });
  const connection = await hre.network.connect('local');
  const chain = v.defineChain({ id: 31337, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
  const transport = v.custom({ request: x => connection.provider.request(x) });
  const client = v.createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 10 });
  const rpc = (method, params = []) => client.request({ method, params });
  const wallet = async () => { const a = accounts.privateKeyToAccount(accounts.generatePrivateKey()); await rpc('hardhat_setBalance', [a.address, v.toHex(v.parseEther('10'))]); return v.createWalletClient({ account: a, chain, transport }); };
  return { client, rpc, wallet, close: () => connection.close?.() };
}

/** Compiles the research contracts (same settings as composer/run.mjs). `keepPaths` keys sources by
 *  their relative path so relative imports resolve. */
export function compileProto(files, { keepPaths = false } = {}) {
  const sources = Object.fromEntries(files.map(f => [keepPaths ? f : f.split('/').pop(), { content: readFileSync(join(here, '..', f), 'utf8') }]));
  const settings = { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
  const o = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings })));
  const errs = (o.errors ?? []).filter(e => e.severity === 'error'); if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
  const art = n => { for (const f of Object.values(o.contracts)) if (f[n]) return { abi: f[n].abi, bytecode: '0x' + f[n].evm.bytecode.object, runtime: '0x' + f[n].evm.deployedBytecode.object }; throw new Error(n); };
  return { art, solcVersion: solc.version(), settings };
}

/** Collects revert text from a viem error chain (decoded name, reason, raw data). */
export const reasonOf = e => { const p = []; for (let x = e; x; x = x.cause) p.push(x.shortMessage, x.details, x.data?.errorName, x.reason, x.signature, x.raw); return p.filter(Boolean).join(' | '); };
export const revertIs = (reason, name) => reason.includes(name) || (/^[A-Z]\w*$/.test(name) && reason.includes(v.toFunctionSelector(name + '()')));
export const json = x => JSON.stringify(x, (_k, a) => (typeof a === 'bigint' ? a.toString() : a), 2);
