// RESEARCH PROTOTYPE: models A and B against the real LI.FI Composer program on an isolated
// Robinhood Chain fork. The plan contract is the Composer signer. Never submits to a public
// network: the upstream relay forwards read-only methods only.
//
//   node run.mjs --repo <BagProtocolv2 checkout @ e6bdd10, SDK built> --mode live   --env-file <repo>/.env.local
//   node run.mjs --repo <...> --mode replay --rpc <url>     (no key: recorded program, see below)
//
// live:   fresh Composer compilations (LIFI_API_KEY and ROBINHOOD_RPC_URL read from --env-file).
// replay: the recorded program in scripts/research/dca-trial/fixtures, re-addressed to each
//         signer by substituting ONLY the slots the signer-dependence analysis identified. It is
//         NOT a Composer response and its quotes are stale; it exercises everything but the API.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const repo = resolve(arg('--repo') ?? '');
const mode = arg('--mode', 'live');
if (!['live', 'replay'].includes(mode)) throw new Error('--mode live|replay');
const out = resolve(arg('--out', join(here, 'out', mode + '-' + new Date().toISOString().replaceAll(':', '-'))));
if (existsSync(out)) throw new Error('Use a new --out directory.');
mkdirSync(out, { recursive: true });
// MetaMask Smart Accounts Kit sends usage analytics unless DO_NOT_TRACK is set.
process.env.DO_NOT_TRACK ??= '1';
const protoRequire = createRequire(join(here, '..', 'package.json'));
const v = protoRequire('viem');
const { privateKeyToAccount, generatePrivateKey } = protoRequire('viem/accounts');
const kit = protoRequire('@metamask/smart-accounts-kit');
const solc = protoRequire('solc');
const { createHardhatRuntimeEnvironment } = await import(pathToFileURL(protoRequire.resolve('hardhat/hre')));
// --sdk selects the built SDK package (default: the one in --repo). A checkout with the opt-in
// forwarded-delivery mode adds a separate SDK verdict; the unchanged-mode verdict is always recorded.
const sdkDir = resolve(arg('--sdk', join(repo, 'packages/bag-sdk')));
const sdk = await import(pathToFileURL(join(sdkDir, 'dist/index.js')));
const { lifiComposer, resolveLifiComposerAccount } = await import(pathToFileURL(join(sdkDir, 'dist/adapters/lifi.js')));
const { withReceiptEvidence } = await import(pathToFileURL(join(sdkDir, 'dist/adapters/evm.js')));
const sdkSupportsDelivery = readFileSync(join(sdkDir, 'dist/receipt.js'), 'utf8').includes('DELIVERY_AUTHORIZATION_MISMATCH');
const { basketWire } = await import(pathToFileURL(join(repo, 'scripts/research/dca-trial/basket-wire.mjs')));
const wire = basketWire(v);

// Secrets are read from the env file only; never from the command line and never written out.
let cfg;
if (mode === 'live') {
  const { settings } = await import(pathToFileURL(join(repo, 'scripts/research/usdg-composer/settings.mjs')));
  cfg = settings(arg('--env-file'));
} else {
  cfg = { rpcUrl: arg('--rpc') ?? 'https://rpc.mainnet.chain.robinhood.com', apiKey: null, redact: x => String(x).replace(/https?:\/\/[^\s"'<>]+/g, '<url>').slice(0, 1600) };
}
const json = x => JSON.stringify(x, (_k, a) => (typeof a === 'bigint' ? String(a) : a), 2);
const sha = x => createHash('sha256').update(x).digest('hex');

const BAG_ID = arg('--bag', '955df6e0-b6ea-44ba-a5eb-1288a80c0a06');
const fixture = JSON.parse(readFileSync(join(repo, 'scripts/research/dca-trial/fixtures', BAG_ID + '.probe-compiled.json'), 'utf8'));
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', USDG_HOLDER = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const FACTORY = '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae';
const deployment = { chainId: 4663, factory: FACTORY, factoryCodeHash: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5' };
const ROOT_AUTHORITY = '0x' + 'f'.repeat(64);
const GROSS = 5_000_000n, RUNS = 3n, PERIOD = 120n;

const cases = [];
async function check(id, name, fn) {
  try { const details = await fn(); cases.push({ id, name, status: 'PASS', details }); console.log(`PASS ${id} ${name}`); return details; }
  catch (e) { const m = cfg.redact(e?.shortMessage ?? e?.message ?? e); cases.push({ id, name, status: 'FAIL', error: m }); console.log(`FAIL ${id} ${name}: ${m.slice(0, 400)}`); return null; }
}
const reasonOf = e => { const p = []; for (let x = e; x; x = x.cause) p.push(x.shortMessage, x.details, x.data?.errorName, x.reason, x.signature, x.raw); return p.filter(Boolean).join(' | '); };
async function reverts(fn) { try { await fn(); } catch (e) { return { reverted: true, reason: cfg.redact(reasonOf(e)).slice(0, 200) }; } throw new Error('expected a revert, call succeeded'); }

// ---- Read-only relay, fork, ArbSys read model -----------------------------------------------
const allowed = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getProof']);
const rejected = [];
const relay = createServer(async (req, res) => {
  try {
    let body = ''; for await (const c of req) body += c;
    const calls = [].concat(JSON.parse(body));
    if (calls.some(c => !allowed.has(c.method))) { rejected.push(...calls.map(c => c.method)); res.writeHead(403); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"read-only relay"}}'); return; }
    const r = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
  } catch { res.writeHead(502); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream unavailable"}}'); }
});
await new Promise(r => relay.listen(0, '127.0.0.1', r));
const relayUrl = 'http://127.0.0.1:' + relay.address().port;
assert.equal((await fetch(relayUrl, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}' })).status, 403);
const chain = v.defineChain({ id: 4663, name: 'ISOLATED Robinhood fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [relayUrl] } } });
const remote = v.createPublicClient({ chain, transport: v.http(relayUrl) });
const forkBlock = await remote.getBlock();
const hre = await createHardhatRuntimeEnvironment({ paths: { cache: join(out, 'cache') }, chainDescriptors: { 4663: { name: 'Robinhood fork (research)', chainType: 'l1', hardforkHistory: { cancun: { blockNumber: 0 } } } },
  networks: { fork: { type: 'edr-simulated', chainId: 4663, chainType: 'l1', hardfork: 'cancun', forking: { url: relayUrl, blockNumber: Number(forkBlock.number) }, throwOnTransactionFailures: true } } });
const connection = await hre.network.connect('fork');
const transport = v.custom({ request: x => connection.provider.request(x) });
const client = v.createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 10 });
const rpc = (method, params = []) => client.request({ method, params });

const sources = Object.fromEntries(['DcaComposerPlan.sol', 'LocalArbSysRead.sol', 'ForkOnlyPaymaster.sol'].map(f => [f, { content: readFileSync(join(here, 'contracts', f), 'utf8') }]));
const settingsSolc = { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
const compiledSol = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: settingsSolc })));
const solErr = (compiledSol.errors ?? []).filter(e => e.severity === 'error'); if (solErr.length) throw new Error(solErr.map(e => e.formattedMessage).join('\n'));
const art = n => { for (const f of Object.values(compiledSol.contracts)) if (f[n]) return { abi: f[n].abi, bytecode: '0x' + f[n].evm.bytecode.object, runtime: '0x' + f[n].evm.deployedBytecode.object }; throw new Error(n); };
const planAbi = art('DcaComposerPlan').abi, factoryAbi = art('DcaComposerPlanFactory').abi;

const report = { scope: 'ISOLATED_ROBINHOOD_FORK_REAL_COMPOSER_AUTHORIZATION_PROTOTYPE', mode,
  programSource: mode === 'live' ? 'FRESH_LIVE_COMPOSER_COMPILATION' : 'RECORDED_PROGRAM_READDRESSED_NOT_A_COMPOSER_RESPONSE',
  fork: { blockNumber: forkBlock.number, blockHash: forkBlock.hash, timestamp: forkBlock.timestamp },
  bag: { id: BAG_ID, definitionHash: fixture.bag.definitionHash }, publicTransactions: 0,
  runtime: { node: process.version, solc: solc.version(), solcSettings: settingsSolc },
  sourceHashes: { 'DcaComposerPlan.sol': sha(sources['DcaComposerPlan.sol'].content), 'run.mjs': sha(readFileSync(fileURLToPath(import.meta.url))),
    'basket-wire.mjs': sha(readFileSync(join(repo, 'scripts/research/dca-trial/basket-wire.mjs'))), 'sdk/dist/receipt.js': sha(readFileSync(join(sdkDir, 'dist/receipt.js'))) },
  planRuntimeBytes: (art('DcaComposerPlan').runtime.length - 2) / 2, purchases: [], sdkVerdicts: [], sdkForwardedVerdicts: [], sdk: { dir: '<sdk>', supportsForwardedDelivery: sdkSupportsDelivery }, cases };

await check('F-0', 'ArbSys arbBlockNumber() read model installed (only the getter; everything else reverts)', async () => {
  const native = await remote.readContract({ address: '0x0000000000000000000000000000000000000064', abi: v.parseAbi(['function arbBlockNumber() view returns (uint256)']), functionName: 'arbBlockNumber', blockNumber: forkBlock.number });
  assert.equal(native, forkBlock.number);
  await rpc('hardhat_setCode', ['0x0000000000000000000000000000000000000064', art('LocalArbSysRead').runtime]); await rpc('evm_mine');
  return { nativeAtFork: native };
});
await check('F-1', 'Composer factory bytecode matches the research pin', async () => { assert.equal(v.keccak256(await client.getCode({ address: FACTORY })), deployment.factoryCodeHash); });

// ---- Accounts, funding ----------------------------------------------------------------------
const user = privateKeyToAccount(generatePrivateKey()), keeper = privateKeyToAccount(generatePrivateKey());
for (const a of [user, keeper]) await rpc('hardhat_setBalance', [a.address, v.toHex(v.parseEther('10'))]);
const W = { user: v.createWalletClient({ account: user, chain, transport }), keeper: v.createWalletClient({ account: keeper, chain, transport }) };
const erc20 = v.parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)',
  'function nonces(address) view returns (uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function name() view returns (string)', 'function version() view returns (string)']);
const read = (address, abi, functionName, a = []) => client.readContract({ address, abi, functionName, args: a });
const bal = (t, a) => read(t, erc20, 'balanceOf', [a]);
async function send(who, address, abi, functionName, a = []) {
  const hash = await W[who].writeContract({ address, abi, functionName, args: a, gas: 25_000_000n });
  const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(functionName + ' failed'); return r;
}
await rpc('hardhat_impersonateAccount', [USDG_HOLDER]); await rpc('hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))]);
await client.waitForTransactionReceipt({ hash: await v.createWalletClient({ account: USDG_HOLDER, chain, transport }).writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [user.address, 100_000_000n], gas: 500000n }) });
await rpc('hardhat_stopImpersonatingAccount', [USDG_HOLDER]);
const factoryAddr = (await client.waitForTransactionReceipt({ hash: await W.keeper.deployContract({ abi: factoryAbi, bytecode: art('DcaComposerPlanFactory').bytecode, gas: 25_000_000n }) })).contractAddress;

// ---- BAG and Composer compilation ------------------------------------------------------------
const parsed = sdk.parseBag(fixture.bag); assert(parsed.ok); assert(sdk.validateBag(parsed.bag).valid);
assert.equal(sdk.hashBag(parsed.bag), fixture.bag.definitionHash);
assert.equal(parsed.bag.definition.rules.performanceFeeBps, 0);
const legTokens = parsed.bag.definition.assets.map(a => a.address.toLowerCase()).filter(a => a !== USDG);
const predictProxy = signer => read(FACTORY, v.parseAbi(['function predictProxyAddress(address) view returns (address)']), 'predictProxyAddress', [signer]);
const planFor = signer => sdk.planPurchase(parsed.bag, { inputToken: USDG, amountRaw: GROSS, inputTokenDecimals: 6, signer });

// --compile-retries N (default 0) / --retry-delay seconds (default 20): when the unchanged SDK
// guard refuses a quote as PRICE_IMPACT_INVALID (negative impactBps), ask for a fresh quote. The
// guard is never changed; every refused quote is recorded with its raw USD values in quoteAttempts.
const compileRetries = Number(arg('--compile-retries', '0')), retryDelayMs = Number(arg('--retry-delay', '20')) * 1000;
if (!Number.isSafeInteger(compileRetries) || compileRetries < 0 || compileRetries > 50 || !(retryDelayMs >= 0)) throw new Error('--compile-retries 0..50, --retry-delay >= 0');
report.quoteAttempts = [];
let blocked = false;
async function compileFor(signer) {
  if (mode === 'live') {
    for (let attempt = 0; ; attempt++) {
      const account = await resolveLifiComposerAccount({ chainId: 4663, signer, deployment, client: remote });
      let priceImpact = null;
      const capture = async (url, init) => {
        const response = await fetch(url, init);
        try { const body = await response.clone().json(); priceImpact = body?.data?.priceImpact ?? priceImpact; } catch {}
        return response;
      };
      const provider = lifiComposer({ apiKey: cfg.apiKey, baseUrl: 'https://composer.li.quest', account, fetch: capture, timeoutMs: 60000 });
      try {
        const c = await sdk.compileBag(parsed.bag, { inputToken: USDG, amountRaw: GROSS, inputTokenDecimals: 6, signer }, { provider, trust: account.trust });
        report.quoteAttempts.push({ signer, attempt, at: new Date().toISOString(), priceImpact, accepted: true,
          sdkQuoteImpactBps: c.quote.priceImpactBps, sdkQuoteImpactUsd: c.quote.priceImpactUsd ?? null });
        return c;
      } catch (e) {
        // Retry ONLY the known refusal: the unchanged guard rejecting a reported, negative, integer
        // impactBps. A missing impact, any other code or any other validation failure stops the run.
        const negativeImpactRefusal = e?.code === 'PRICE_IMPACT_INVALID' && Number.isSafeInteger(priceImpact?.impactBps) && priceImpact.impactBps < 0 &&
          String(e?.message ?? '').includes(`malformed price impact ${priceImpact.impactBps} bps`);
        report.quoteAttempts.push({ signer, attempt, at: new Date().toISOString(), priceImpact, accepted: false, code: e?.code ?? null,
          negativeImpactRefusal, message: cfg.redact(e?.message ?? e) });
        if (!negativeImpactRefusal) throw e;
        if (attempt >= compileRetries) { blocked = true; throw new Error(`BLOCKED: ${attempt + 1} quote(s), every one refused for negative impactBps by the unchanged guard`); }
        console.log(`quote refused (${e.code}, impactBps=${priceImpact?.impactBps}); retry ${attempt + 1}/${compileRetries} in ${retryDelayMs / 1000}s`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  // Replay: re-address the recorded program. Only slot 0 (signer), slot 1 (balanceOf(proxy)) and the
  // swap receivers change; analyze-signer-dependence.mjs shows nothing else names the signer.
  const recorded = fixture.plan.signer, x = wire.decode(fixture.compiled.transaction.data);
  assert.equal(x.state[0], v.encodeAbiParameters([{ type: 'address' }], [recorded]));
  const proxy = await predictProxy(signer);
  x.state[0] = v.encodeAbiParameters([{ type: 'address' }], [signer]);
  x.state[1] = wire.body(v.encodeFunctionData({ abi: v.parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [proxy] }));
  for (let i = 0; i < x.state.length; i++) { let a; try { a = wire.swap(x.state[i]); } catch { continue; } a[3] = proxy; x.state[i] = wire.swapBody(a); }
  return { transaction: { chainId: 4663, to: FACTORY, data: wire.encode(x), value: 0n }, quote: { plan: planFor(signer), legs: fixture.compiled.quote.legs } };
}

// Signer-independent template: derived slots are emptied, so the CREATE2 init code cannot name the plan.
async function template(compiled, signer) {
  const plan = compiled.quote.plan ?? planFor(signer);
  const p = wire.profile(compiled, plan, sdk.simulatePartition(plan.swapAmountRaw, plan.legs.map(l => l.legBps)), parsed.bag.definition);
  const proxy = (await predictProxy(signer)).toLowerCase();
  const signerWord = v.encodeAbiParameters([{ type: 'address' }], [signer]).toLowerCase();
  const proxyBalance = wire.body(v.encodeFunctionData({ abi: v.parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [proxy] })).toLowerCase();
  const signerSlot = p.state.findIndex(s => s.toLowerCase() === signerWord), proxyBalanceSlot = p.state.findIndex(s => s.toLowerCase() === proxyBalance);
  assert(signerSlot >= 0 && proxyBalanceSlot >= 0, 'signer or proxy-balance slot not found');
  const legSlots = new Set(p.legs.map(l => Number(l.slot)));
  const state = p.state.map((s, i) => (i === signerSlot || i === proxyBalanceSlot || i === Number(p.contextSlot) || legSlots.has(i) ? '0x' : s));
  const leaks = state.map((s, i) => [i, s.toLowerCase()]).filter(([, s]) => s.includes(signer.slice(2).toLowerCase()) || s.includes(proxy.slice(2)));
  assert.equal(leaks.length, 0, 'signer-dependent data outside the derived slots: ' + leaks.map(([i]) => i));
  return { instructions: p.instructions, state, signerSlot: BigInt(signerSlot), proxyBalanceSlot: BigInt(proxyBalanceSlot), contextSlot: p.contextSlot, amountSlot: p.amountSlot,
    legs: p.legs.map(l => ({ token: l.token, weightBps: l.weightBps, input: l.input, net: l.net, minimum: l.minimum, slot: l.slot, feeHash: l.feeHash })), commandsHash: p.commandsHash };
}
const comparable = t => json({ ...t, legs: t.legs.map(({ minimum, ...l }) => l) });
const asProfile = t => ({ instructions: t.instructions.map(([opcode, operand]) => ({ opcode, operand })), state: t.state, signerSlot: t.signerSlot, proxyBalanceSlot: t.proxyBalanceSlot, contextSlot: t.contextSlot, amountSlot: t.amountSlot, legs: t.legs });
// Program for the plan: context set to the plan's own, factory envelope only while its proxy is undeployed.
async function forPlan(compiled, plan, t) {
  const proxy = await read(plan, planAbi, 'proxy'), deployed = (await client.getCode({ address: proxy }))?.length > 2;
  const data = wire.normalize(compiled.transaction.data, await read(plan, planAbi, 'context'), deployed, { commandsHash: t.commandsHash, state: t.state, contextSlot: t.contextSlot });
  return { ...compiled, transaction: { ...compiled.transaction, to: deployed ? proxy : FACTORY, data, value: 0n } };
}

// =============================================================================================
const D = privateKeyToAccount(generatePrivateKey()).address;  // never deployed, never funded
let compiledD;
await check('T-1', 'compile the selected BAG for an unrelated placeholder signer', async () => {
  compiledD = await compileFor(D); writeFileSync(join(out, 'compiled-placeholder.json'), json(compiledD)); return { signer: D, programHash: v.keccak256(compiledD.transaction.data) };
});
const TD = compiledD && await check('T-2', 'derive the signer-independent template (no signer/proxy bytes remain)', async () => template(compiledD, D));
report.template = TD && { commandsHash: TD.commandsHash, signerSlot: TD.signerSlot, proxyBalanceSlot: TD.proxyBalanceSlot, contextSlot: TD.contextSlot, amountSlot: TD.amountSlot,
  derivedSlots: TD.state.map((s, i) => (s === '0x' ? i : null)).filter(x => x !== null), legs: TD.legs };

const floorsOf = t => t.legs.map(l => ({ token: l.token, amountRaw: l.minimum }));
async function snapshot(plan, extra) {
  const s = { runs: await read(plan, planAbi, 'runs'), lastExecution: await read(plan, planAbi, 'lastExecution'), userUsdg: await bal(USDG, user.address), planUsdg: await bal(USDG, plan),
    proxyAllowance: await read(USDG, erc20, 'allowance', [plan, await read(plan, planAbi, 'proxy')]) };
  for (const t of legTokens) { s['user:' + t] = await bal(t, user.address); s['plan:' + t] = await bal(t, plan); }
  return { ...s, ...(extra ? await extra() : {}) };
}
async function sdkChecks(id, compiled, txHash, plan, source) {
  const floors = floorsOf(TD);
  await check(id + '-sdk-binding', 'SDK verifyPurchaseReceipt binds the inner compiled Composer call (CALL_TRACE); its overall verdict is recorded, not asserted', async () => {
    const r = await sdk.verifyPurchaseReceipt(compiled, { client: withReceiptEvidence(client), transactionHash: txHash, minimumReceived: floors, confirmations: 1 });
    writeFileSync(join(out, id + '-sdk-verify.json'), json(r));
    assert.equal(r.transactionBinding, 'CALL_TRACE', 'SDK did not bind the inner compiled call: ' + json(r.issues));
    report.sdkVerdicts.push({ id, status: r.status, issues: r.issues });
    return { sdkOverallStatus: r.status, transactionBinding: r.transactionBinding, issues: r.issues };
  });
  await check(id + '-delivery', 'SDK transaction-scoped balance evidence: source debit = swap amount, recipient >= floors, plan residue 0', async () => {
    const ev = withReceiptEvidence(client), rc = await client.getTransactionReceipt({ hash: txHash });
    const ctx = { transactionHash: txHash, blockHash: rc.blockHash, blockNumber: rc.blockNumber };
    const tokens = [...legTokens, USDG];
    const at = async owner => Object.fromEntries((await ev.getPurchaseBalanceChanges({ ...ctx, owner, tokens })).balances.map(b => [b.token.toLowerCase(), b.afterRaw - b.beforeRaw]));
    const [u, s, p] = [await at(user.address), source === user.address ? null : await at(source), await at(plan)];
    const swap = await read(plan, planAbi, 'swapAmount');
    assert.equal((s ?? u)[USDG], -swap);
    for (const f of floors) assert(u[f.token.toLowerCase()] >= f.amountRaw, 'below floor ' + f.token);
    for (const t of tokens) assert.equal(p[t], 0n, 'plan residue ' + t);
    return { userDeltas: u, sourceDeltas: s, planDeltas: p };
  });
  if (!sdkSupportsDelivery) return;
  const forwarded = (recipient) => sdk.verifyPurchaseReceipt(compiled, { client: withReceiptEvidence(client, { deliveryAuthorization: 'BAG_DCA_PLAN_V1' }),
    transactionHash: txHash, minimumReceived: floors, confirmations: 1, delivery: { caller: plan, fundingSource: source, recipient } });
  await check(id + '-sdk-forwarded', 'SDK forwarded-delivery mode VERIFIES inner call, funding-source debit, recipient minimums and net-zero caller', async () => {
    const r = await forwarded(user.address);
    writeFileSync(join(out, id + '-sdk-forwarded.json'), json(r));
    report.sdkForwardedVerdicts.push({ id, transactionHash: txHash, status: r.status, issues: r.issues, delivery: r.delivery,
      priceImpactBps: compiled.quote.priceImpactBps, priceImpactUsd: compiled.quote.priceImpactUsd ?? null });
    assert.equal(r.status, 'VERIFIED', json(r.issues));
    assert.equal(r.transactionBinding, 'CALL_TRACE'); assert.equal(r.delivery.authorization, 'ON_CHAIN_PLAN_READ'); assert.equal(r.delivery.callerNetZero, true);
    return { status: r.status, spentInputRaw: r.spentInputRaw, delivery: r.delivery };
  });
  await check(id + '-sdk-forwarded-binding', 'SDK forwarded-delivery mode rejects a recipient the plan did not authorize', async () => {
    const r = await forwarded(keeper.address);
    assert.equal(r.status, 'FAILED'); assert.equal(r.issues[0].code, 'DELIVERY_AUTHORIZATION_MISMATCH');
    return { status: r.status, code: r.issues[0].code };
  });
}
async function failureCase(id, plan, compiled, t, permissionContext, extra) {
  return check(id, 'a failing Composer swap reverts funding, approvals, plan counters' + (extra ? ' and enforcer counters' : ''), async () => {
    const good = await forPlan(compiled, plan, t);
    // Keep the router selector (so validation passes) and corrupt the route payload: the router call fails.
    const bad = wire.mutateSwap(good.transaction.data, Number(t.legs[0].slot), a => { const cd = a[5][1].callData; a[5][1].callData = v.concat([v.slice(cd, 0, 4), '0x' + 'ff'.repeat((cd.length - 10) / 2)]); });
    await read(plan, planAbi, 'validate', [good.transaction.to, bad]);
    const before = await snapshot(plan, extra);
    const r = await reverts(() => send('keeper', plan, planAbi, 'run', [good.transaction.to, bad, permissionContext]));
    assert.deepEqual(await snapshot(plan, extra), before);
    return { ...r, stateUnchanged: true };
  });
}

async function model(label, terms, nonce, setup, permissionContextFor, extra, lifecycle) {
  const P = await read(factoryAddr, factoryAbi, 'predict', [terms, asProfile(TD), nonce]);
  await check(label + '-1', 'predict the CREATE2 plan address before any Composer data for it exists', async () => ({ predicted: P,
    initCodeHash: await read(factoryAddr, factoryAbi, 'initCodeHash', [terms, asProfile(TD)]) }));
  let compiled;
  await check(label + '-2', 'compile for the predicted plan: template identical to the placeholder template (no address cycle)', async () => {
    compiled = await compileFor(P);
    const TP = await template(compiled, P);
    assert.equal(comparable(TP), comparable(TD), 'template depends on the signer');
    return { commandsHashEqual: TP.commandsHash === TD.commandsHash, fixedSlotsEqual: true, derivedSlotsOnly: report.template.derivedSlots };
  });
  await setup(P);
  await check(label + '-3', 'deployed address equals the prediction; owner = user', async () => {
    assert((await client.getCode({ address: P }))?.length > 2); assert.equal(await read(P, planAbi, 'owner'), user.address); return { plan: P };
  });
  const permissionContext = permissionContextFor(P);
  const runOnce = async (id, round) => {
    if (round > 1) compiled = await compileFor(P);
    const c = await forPlan(compiled, P, TD);
    const start = await read(P, planAbi, 'start'), last = await read(P, planAbi, 'lastExecution'), now = (await client.getBlock()).timestamp;
    const due = round === 1 ? start : last + PERIOD; if (due > now) { await rpc('evm_setNextBlockTimestamp', [Number(due)]); }
    let hash;
    await check(id, `run ${round}: funding, Composer purchase and delivery to the user in one transaction`, async () => {
      const before = await snapshot(P);
      const r = await send('keeper', P, planAbi, 'run', [c.transaction.to, c.transaction.data, permissionContext]); hash = r.transactionHash;
      const after = await snapshot(P), swap = await read(P, planAbi, 'swapAmount');
      assert.equal(after.runs, before.runs + 1n); assert.equal(after.planUsdg, 0n); assert.equal(after.proxyAllowance, 0n);
      for (const f of floorsOf(TD)) { assert(after['user:' + f.token.toLowerCase()] - before['user:' + f.token.toLowerCase()] >= f.amountRaw); assert.equal(after['plan:' + f.token.toLowerCase()], 0n); }
      writeFileSync(join(out, id + '-trace.json'), json(await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }])));
      report.purchases.push({ id, transactionHash: hash, priceImpactBps: c.quote.priceImpactBps, priceImpactUsd: c.quote.priceImpactUsd ?? null });
      return { transactionHash: hash, gasUsed: r.gasUsed, swapAmount: swap, priceImpactBps: c.quote.priceImpactBps, priceImpactUsd: c.quote.priceImpactUsd ?? null };
    });
    if (hash) await sdkChecks(id, c, hash, P, terms.source);
  };
  await runOnce(label + '-4', 1);
  const now = (await client.getBlock()).timestamp, last = await read(P, planAbi, 'lastExecution');
  if (last + PERIOD > now) await rpc('evm_setNextBlockTimestamp', [Number(last + PERIOD)]), await rpc('evm_mine');
  if (mode === 'live') compiled = await compileFor(P);
  await failureCase(label + '-5', P, compiled, TD, permissionContext, extra && (() => extra(P)));
  await runOnce(label + '-6', 2);
  if (lifecycle) await lifecycle(P, permissionContext, {
    runOnce, program: async () => forPlan(mode === 'live' ? (compiled = await compileFor(P)) : compiled, P, TD),
    snap: () => snapshot(P, extra && (() => extra(P))) });
}

// ---- Lifecycle helpers: every refused run must leave all balances, approvals and counters unchanged.
const now = async () => (await client.getBlock()).timestamp;
async function atTime(t) { if (t > await now()) { await rpc('evm_setNextBlockTimestamp', [Number(t)]); await rpc('evm_mine'); } }
const atDue = async P => atTime((await read(P, planAbi, 'lastExecution')) + PERIOD);
// The fork returns raw custom-error data; match either the decoded name or its 4-byte selector.
const revertIs = (reason, name) => reason.includes(name) || (/^[A-Z]\w*$/.test(name) && reason.includes(v.toFunctionSelector(name + '()')));
async function refused(id, name, P, h, ctx, expect, snap = h.snap) {
  return check(id, name, async () => {
    const c = await h.program(), before = await snap();
    const r = await reverts(() => send('keeper', P, planAbi, 'run', [c.transaction.to, c.transaction.data, ctx]));
    assert(revertIs(r.reason, expect), `expected ${expect}, got: ${r.reason}`);
    assert.deepEqual(await snap(), before);
    return { ...r, stateUnchanged: true, before };
  });
}

if (TD) {
  // Independent A/B experiments start from the same fork state. This never rewinds
  // successful purchases within the same delegation-consumption lifecycle.
  const beforeIndependentModels = await rpc('evm_snapshot');
  report.modelIsolation = { enabled: true, kind: 'A_AND_B_FROM_SAME_FORK_BASE',
    note: 'A results are collected before reverting to the common base for B. Existing B-17 branch isolation remains unchanged.' };
  // ---- Model A ----------------------------------------------------------------------------
  let t0 = (await client.getBlock()).timestamp;
  const termsA = { funding: 1, owner: user.address, source: user.address, recipient: user.address, delegationManager: v.zeroAddress, definitionHash: fixture.bag.definitionHash,
    grossPerRun: GROSS, maxRuns: RUNS, start: t0 + 60n, period: PERIOD, expiry: t0 + 60n + PERIOD * (RUNS + 2n), cashBps: 0n };
  const usdgName = await read(USDG, erc20, 'name'), usdgVersion = await read(USDG, erc20, 'version').catch(() => '1'); // no version(); '1' reproduces DOMAIN_SEPARATOR (fork test A-0)
  await model('A', termsA, 1n, async P => {
    await check('A-setup', 'user signs one USDG permit; keeper deploys the plan and submits it', async () => {
      const nonce = await read(USDG, erc20, 'nonces', [user.address]), value = TD.legs.reduce((a, l) => a + l.input, 0n) * RUNS, deadline = t0 + 3600n;
      const sig = await user.signTypedData({ domain: { name: usdgName, version: usdgVersion, chainId: 4663, verifyingContract: USDG }, primaryType: 'Permit',
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { owner: user.address, spender: P, value, nonce, deadline } });
      const s = v.parseSignature(sig);
      await send('keeper', factoryAddr, factoryAbi, 'deployWithPermit', [termsA, asProfile(TD), 1n, { value, deadline, v: Number(s.v), r: s.r, s: s.s }]);
      return { userSignatures: 1, userTransactions: 0, allowance: await read(USDG, erc20, 'allowance', [user.address, P]) };
    });
  }, () => '0x', null, async (P, ctx, h) => {
    await refused('A-7', 'early: a second run in the same period is refused (NotDue)', P, h, ctx, 'NotDue');
    await h.runOnce('A-8', 3);
    await atDue(P);
    await check('A-9', 'limit: after maxRuns the plan refuses (Inactive); allowance fully consumed, total debit = maxRuns x swap', async () => {
      const before = await h.snap(), swap = await read(P, planAbi, 'swapAmount');
      assert.equal(await read(USDG, erc20, 'allowance', [user.address, P]), 0n);
      const c = await h.program();
      const r = await reverts(() => send('keeper', P, planAbi, 'run', [c.transaction.to, c.transaction.data, ctx]));
      assert(revertIs(r.reason, 'Inactive'), r.reason); assert.deepEqual(await h.snap(), before);
      assert.equal(before.runs, RUNS);
      return { ...r, runs: before.runs, totalSwapped: swap * RUNS };
    });
  });

  // A cancellation: a second plan, cancelled by the user while its allowance is still unused.
  t0 = (await client.getBlock()).timestamp;
  const termsA2 = { ...termsA, start: t0 + 60n, expiry: t0 + 60n + PERIOD * (RUNS + 2n) };
  const PA2 = await read(factoryAddr, factoryAbi, 'predict', [termsA2, asProfile(TD), 3n]);
  await check('A-10', 'cancel: the user cancels a funded plan; a due run is refused (Inactive) although its allowance is unused', async () => {
    const compiled2 = await compileFor(PA2);
    const nonce = await read(USDG, erc20, 'nonces', [user.address]), value = TD.legs.reduce((a, l) => a + l.input, 0n) * RUNS, deadline = t0 + 3600n;
    const sig = await user.signTypedData({ domain: { name: usdgName, version: usdgVersion, chainId: 4663, verifyingContract: USDG }, primaryType: 'Permit',
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      message: { owner: user.address, spender: PA2, value, nonce, deadline } });
    const s = v.parseSignature(sig);
    await send('keeper', factoryAddr, factoryAbi, 'deployWithPermit', [termsA2, asProfile(TD), 3n, { value, deadline, v: Number(s.v), r: s.r, s: s.s }]);
    await send('user', PA2, planAbi, 'cancel');
    await atTime(termsA2.start);
    const c = await forPlan(compiled2, PA2, TD), userBefore = await bal(USDG, user.address);
    const r = await reverts(() => send('keeper', PA2, planAbi, 'run', [c.transaction.to, c.transaction.data, '0x']));
    assert(revertIs(r.reason, 'Inactive'), r.reason);
    const allowance = await read(USDG, erc20, 'allowance', [user.address, PA2]);
    assert.equal(allowance, value); assert.equal(await bal(USDG, user.address), userBefore); assert.equal(await read(PA2, planAbi, 'runs'), 0n);
    return { ...r, unusedAllowance: allowance, note: 'cancel() blocks the plan; approve(PA2, 0) is a separate, optional transaction' };
  });

  // ---- Model B ----------------------------------------------------------------------------
  assert.equal(await rpc('evm_revert', [beforeIndependentModels]), true, 'Could not restore independent B base state');
  console.log('ISOLATION restored initial fork state before independent model B');
  const env = kit.getSmartAccountsEnvironment(4663), E = env.caveatEnforcers, DM = env.DelegationManager;
  const sa = await kit.toMetaMaskSmartAccount({ client, implementation: kit.Implementation.MultiSig, deployParams: [[user.address], 1n], deploySalt: '0x', signer: [{ account: user }] });
  const { factory: saFactory, factoryData } = await sa.getFactoryArgs();
  await client.waitForTransactionReceipt({ hash: await W.keeper.sendTransaction({ to: saFactory, data: factoryData, gas: 3_000_000n }) });
  await send('user', USDG, erc20, 'transfer', [sa.address, 50_000_000n]);
  t0 = (await client.getBlock()).timestamp;
  const termsB = { ...termsA, funding: 2, source: sa.address, delegationManager: DM, start: t0 + 60n, expiry: t0 + 60n + PERIOD * (RUNS + 2n) };
  const swap = TD.legs.reduce((a, l) => a + l.input, 0n);
  const delegationType = { type: 'tuple[]', components: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] };
  let delegation, delegationHash;
  const signPlanDelegation = async (P, salt, perPeriod, total, o = {}) => {
    const { start = termsB.start, expiry = termsB.expiry, period = PERIOD, calls = RUNS } = o;
    const caveats = [
      { enforcer: E.ERC20PeriodTransferEnforcer, terms: v.encodePacked(['address', 'uint256', 'uint256', 'uint256'], [USDG, perPeriod, period, start]), args: '0x' },
      { enforcer: E.ERC20TransferAmountEnforcer, terms: v.encodePacked(['address', 'uint256'], [USDG, total]), args: '0x' },
      { enforcer: E.LimitedCallsEnforcer, terms: v.encodePacked(['uint256'], [calls]), args: '0x' },
      { enforcer: E.TimestampEnforcer, terms: v.encodePacked(['uint128', 'uint128'], [start - 1n, expiry]), args: '0x' },
      { enforcer: E.RedeemerEnforcer, terms: P, args: '0x' },
      { enforcer: E.AllowedCalldataEnforcer, terms: v.concat([v.toHex(4n, { size: 32 }), v.pad(P, { size: 32 })]), args: '0x' }];
    const d = { delegate: P, delegator: sa.address, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
    return { ...d, signature: await sa.signDelegation({ delegation: d }) };
  };
  const dmAbi = v.parseAbi(['function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)) pure returns (bytes32)',
    'function disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))', 'function disabledDelegations(bytes32) view returns (bool)']);
  const asTuple = d => [d.delegate, d.delegator, d.authority, d.caveats.map(c => [c.enforcer, c.terms, c.args]), d.salt, d.signature];
  const hashOf = d => read(DM, dmAbi, 'getDelegationHash', [asTuple(d)]);
  const ctxOf = d => v.encodeAbiParameters([delegationType], [[d]]);
  // User operations, signed by the account owner and submitted by the keeper through EntryPoint.handleOps.
  const aa = protoRequire('viem/account-abstraction');
  const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  async function userOp(calls, label) {
    const nonce = await read(EP, v.parseAbi(['function getNonce(address,uint192) view returns (uint256)']), 'getNonce', [sa.address, 0n]), block = await client.getBlock();
    const op = { sender: sa.address, nonce, callData: await sa.encodeCalls(calls), callGasLimit: 500_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n,
      maxFeePerGas: (block.baseFeePerGas ?? 1n) * 2n + 1n, maxPriorityFeePerGas: 1n, signature: '0x' };
    op.signature = await sa.signUserOperation({ ...op, chainId: 4663 });
    const r = await client.waitForTransactionReceipt({ hash: await W.keeper.writeContract({ address: EP, abi: aa.entryPoint07Abi, functionName: 'handleOps', args: [[aa.toPackedUserOperation(op)], keeper.address], gas: 3_000_000n }) });
    const ev = v.parseEventLogs({ abi: aa.entryPoint07Abi, logs: r.logs, eventName: 'UserOperationEvent' })[0];
    if (!ev?.args.success) throw new Error(label + ': user operation failed');
    return { actualGasCost: ev.args.actualGasCost };
  }
  // Enforcer counters of ONE delegation (by hash): period spent, total spent, call count.
  const countersOf = async hash => ({
    period: (await read(E.ERC20PeriodTransferEnforcer, v.parseAbi(['function periodicAllowances(address,bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), 'periodicAllowances', [DM, hash]))[4],
    spent: await read(E.ERC20TransferAmountEnforcer, v.parseAbi(['function spentMap(address,bytes32) view returns (uint256)']), 'spentMap', [DM, hash]),
    calls: await read(E.LimitedCallsEnforcer, v.parseAbi(['function callCounts(address,bytes32) view returns (uint256)']), 'callCounts', [DM, hash]) });
  const enforcers = async () => ({ ...(await countersOf(delegationHash)), accountUsdg: await bal(USDG, sa.address) });
  // Snapshot for a refused run that presents delegation d: plan state, the main delegation AND d's own counters.
  const snapWith = (h, d) => async () => ({ ...(await h.snap()), used: await countersOf(await hashOf(d)) });
  await model('B', termsB, 2n, async P => {
    await check('B-setup', 'keeper deploys the plan; user signs one delegation bounded by the enforcers', async () => {
      await send('keeper', factoryAddr, factoryAbi, 'deploy', [termsB, asProfile(TD), 2n]);
      delegation = await signPlanDelegation(P, 1n, swap, swap * RUNS);
      delegationHash = await hashOf(delegation);
      return { account: sa.address, implementation: 'MultiSigDeleGator v1.3.0 (bytecode verified)', userSignatures: 1, userTransactions: 1, delegationHash };
    });
  }, () => ctxOf(delegation), enforcers, async (P, ctx, h) => {
    await refused('B-7', 'early: a second run in the same period is refused by the plan (NotDue)', P, h, ctx, 'NotDue');
    await atDue(P);
    // Enforcer-only limits: the plan would run, the delegation's own caveats refuse the transfer.
    const dPeriod = await signPlanDelegation(P, 2n, swap - 1n, swap * RUNS);
    await refused('B-8', 'limit (enforcer): a separate delegation whose per-period cap is below the swap amount refuses the due run; its own counters unchanged', P, h, ctxOf(dPeriod), 'transfer-amount-exceeded', snapWith(h, dPeriod));
    const dTotal = await signPlanDelegation(P, 3n, swap, swap - 1n);
    await refused('B-9', 'limit (enforcer): a separate delegation whose total is below the swap amount refuses the due run; its own counters unchanged', P, h, ctxOf(dTotal), 'allowance-exceeded', snapWith(h, dTotal));
    await rpc('hardhat_setBalance', [sa.address, v.toHex(v.parseEther('0.01'))]);
    await check('B-10', 'cancel: user-signed userOp disables the delegation; the due run is refused (CannotUseADisabledDelegation), budget left in the account', async () => {
      const g = await userOp([{ to: DM, data: v.encodeFunctionData({ abi: dmAbi, functionName: 'disableDelegation', args: [asTuple(delegation)] }) }], 'disable');
      assert.equal(await read(DM, dmAbi, 'disabledDelegations', [delegationHash]), true);
      const c = await h.program(), before = await h.snap();
      const r = await reverts(() => send('keeper', P, planAbi, 'run', [c.transaction.to, c.transaction.data, ctx]));
      assert(r.reason.includes('0x05baa052') || r.reason.includes('CannotUseADisabledDelegation'), r.reason);
      assert.deepEqual(await h.snap(), before);
      return { ...r, userOpGasCostWei: g.actualGasCost, accountUsdgLeft: before.accountUsdg };
    });
    await check('B-11', 'withdraw: user-signed userOp returns the remaining USDG from the account to the user EOA', async () => {
      const left = await bal(USDG, sa.address), e0 = await bal(USDG, user.address);
      await userOp([{ to: USDG, data: v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [user.address, left] }) }], 'withdraw');
      assert.equal(await bal(USDG, sa.address), 0n); assert.equal(await bal(USDG, user.address) - e0, left);
      return { withdrawnRaw: left };
    });
  });

  // ---- B, one delegation consumed cumulatively ---------------------------------------------
  // A second plan whose own period is HALF the delegation's, so the plan allows runs the delegation
  // must refuse: every refusal below comes from the enforcers of the same, partly used delegation.
  {
    await send('user', USDG, erc20, 'transfer', [sa.address, 50_000_000n]);
    t0 = (await client.getBlock()).timestamp;
    const half = PERIOD / 2n, startC = t0 + 60n, expiryC = startC + PERIOD * 10n;
    const termsC = { ...termsB, start: startC, period: half, maxRuns: 10n, expiry: expiryC };
    const PC = await read(factoryAddr, factoryAbi, 'predict', [termsC, asProfile(TD), 4n]);
    let compiledC, dC, hC, dCalls, hCalls, snapC0;
    await check('B-12', 'setup: plan C (own period = half the delegation period, maxRuns 10); ONE delegation: per period 1 swap, total 2 swaps, calls 10', async () => {
      compiledC = await compileFor(PC);
      assert.equal(comparable(await template(compiledC, PC)), comparable(TD));
      await send('keeper', factoryAddr, factoryAbi, 'deploy', [termsC, asProfile(TD), 4n]);
      dC = await signPlanDelegation(PC, 10n, swap, swap * 2n, { start: startC, expiry: expiryC, period: PERIOD, calls: 10n }); hC = await hashOf(dC);
      return { plan: PC, delegationHash: hC, planPeriod: half, delegationPeriod: PERIOD, perPeriod: swap, total: swap * 2n };
    });
    const programC = async () => forPlan(mode === 'live' ? (compiledC = await compileFor(PC)) : compiledC, PC, TD);
    const snapC = hash => async () => ({ ...(await snapshot(PC)), counters: await countersOf(hash), accountUsdg: await bal(USDG, sa.address) });
    const hC_ = { program: programC };
    // Never earlier than the plan's own next due time, so the plan is never the refusing party.
    const runC = (id, name, d, hash, at, expect) => (async () => {
      const last = await read(PC, planAbi, 'lastExecution');
      await atTime(last && last + half > at ? last + half : at);
      if (expect) return refused(id, name, PC, { ...hC_, snap: snapC(hash) }, ctxOf(d), expect);
      return check(id, name, async () => {
        const c = await programC(), before = await snapC(hash)();
        const runData = v.encodeFunctionData({ abi: planAbi, functionName: 'run', args: [c.transaction.to, c.transaction.data, ctxOf(d)] });
        const r = await send('keeper', PC, planAbi, 'run', [c.transaction.to, c.transaction.data, ctxOf(d)]).catch(async e => {
          // Locate the reverting frame (deepest call with an error) for the report.
          const t = await rpc('debug_traceCall', [{ from: keeper.address, to: PC, data: runData, gas: v.toHex(25_000_000n) }, 'latest', { tracer: 'callTracer' }]).catch(x => ({ traceError: String(x?.message ?? x).slice(0, 200) }));
          const deep = f => { for (const k of f?.calls ?? []) { const x = deep(k); if (x) return x; } return f?.error ? { to: f.to, input: f.input?.slice(0, 10), error: f.error, output: f.output } : null; };
          throw new Error(cfg.redact(reasonOf(e)).slice(0, 200) + ' | revert site: ' + JSON.stringify(t.traceError ? t : deep(t)));
        });
        const after = await snapC(hash)();
        assert.equal(after.runs, before.runs + 1n); assert.equal(before.accountUsdg - after.accountUsdg, swap);
        assert.equal(after.counters.spent, before.counters.spent + swap); assert.equal(after.counters.calls, before.counters.calls + 1n);
        report.purchases.push({ id, transactionHash: r.transactionHash, priceImpactBps: c.quote.priceImpactBps, priceImpactUsd: c.quote.priceImpactUsd ?? null });
        await sdkChecks(id, c, r.transactionHash, PC, sa.address);
        return { transactionHash: r.transactionHash, counters: after.counters };
      });
    })();
    if (dC) {
      snapC0 = await rpc('evm_snapshot');
      await runC('B-13', 'delegation period 0: first run with the delegation passes (period spent 1 swap, total 1 swap, calls 1)', dC, hC, startC);
      await runC('B-14', 'same delegation period, plan due again: the SAME delegation refuses (period cap reached), its counters unchanged', dC, hC, startC + half, 'transfer-amount-exceeded');
      await runC('B-15', 'next delegation period: the same delegation passes again (total now 2 swaps = budget)', dC, hC, startC + PERIOD);
      await runC('B-16', 'next period, budget consumed: the same delegation refuses (total), its counters unchanged', dC, hC, startC + 2n * PERIOD, 'allowance-exceeded');
      // Call-count limit on one delegation: calls 1, generous amounts. The fork is first restored to
      // the state before B-13: in replay the recorded program's leg minimums are fixed, and each purchase
      // on the fork moves the pools (B-17 as the 8th purchase in a row reverted inside the swap).
      await rpc('evm_revert', [snapC0]);
      dCalls = await signPlanDelegation(PC, 11n, swap, swap * 10n, { start: startC, expiry: expiryC, period: PERIOD, calls: 1n }); hCalls = await hashOf(dCalls);
      await runC('B-17', 'call-count delegation (calls 1): first run passes', dCalls, hCalls, startC + 3n * PERIOD);
      await runC('B-18', 'call-count delegation, next period: refused (LimitedCallsEnforcer), its counters unchanged', dCalls, hCalls, startC + 4n * PERIOD, 'limit-exceeded');

      // ---- Fork-only user operations: cancel and withdraw bound to a keyless research paymaster ----
      // paymasterAndData is part of the owner-signed hash. PM is keccak256(label)[12:]: no key and no
      // deployer exist for it, so on Robinhood Chain it can never hold code and the signed operation
      // can never validate there. On the fork its code is placed with hardhat_setCode.
      const PM = v.getAddress('0x' + v.keccak256(v.toBytes('BAG-DCA fork-only paymaster v1')).slice(-40));
      const epAbi = [...aa.entryPoint07Abi, ...v.parseAbi(['function depositTo(address) payable'])];
      const epNonce = () => read(EP, v.parseAbi(['function getNonce(address,uint192) view returns (uint256)']), 'getNonce', [sa.address, 0n]);
      const deposit = () => read(EP, v.parseAbi(['function balanceOf(address) view returns (uint256)']), 'balanceOf', [PM]);
      const pmCode = art('ForkOnlyPaymaster').runtime;
      async function pmOp(calls, validUntil, validAfter = 0n) {
        const block = await client.getBlock();
        const op = { sender: sa.address, nonce: await epNonce(), callData: await sa.encodeCalls(calls), callGasLimit: 500_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n,
          maxFeePerGas: (block.baseFeePerGas ?? 1n) * 2n + 1n, maxPriorityFeePerGas: 1n,
          paymaster: PM, paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 0n, paymasterData: v.encodePacked(['uint48', 'uint48'], [validUntil, validAfter]), signature: '0x' };
        return { ...op, signature: await sa.signUserOperation({ ...op, chainId: 4663 }) };
      }
      async function handle(op) {
        const hash = await W.keeper.writeContract({ address: EP, abi: epAbi, functionName: 'handleOps', args: [[aa.toPackedUserOperation(op)], keeper.address], gas: 3_000_000n }).catch(e => {
          // The fork returns EntryPoint's FailedOp/FailedOpWithRevert undecoded; decode it so the AAxx code is visible.
          const full = [e?.message, e?.cause?.message, e?.details].join(' '), raw = full.match(/return data: (0x[0-9a-fA-F]+)/)?.[1];
          let decoded = null; if (raw) try { const d = v.decodeErrorResult({ abi: aa.entryPoint07Abi, data: raw }); decoded = `${d.errorName}(${d.args.map(String).join(', ')})`; } catch {}
          const msg = decoded ? 'EntryPoint ' + decoded : cfg.redact(reasonOf(e) || String(e?.message ?? e)).slice(0, 300);
          throw Object.assign(new Error(msg), { shortMessage: msg });
        });
        const r = await client.waitForTransactionReceipt({ hash });
        const ev = v.parseEventLogs({ abi: aa.entryPoint07Abi, logs: r.logs, eventName: 'UserOperationEvent' })[0];
        if (!ev?.args.success) throw new Error('user operation failed'); return ev.args;
      }
      // Effects that must not move when an operation is refused.
      const effects = async hash => ({ nonce: await epNonce(), accountEth: await client.getBalance({ address: sa.address }), accountUsdg: await bal(USDG, sa.address),
        disabled: await read(DM, dmAbi, 'disabledDelegations', [hash]), deposit: await deposit() });
      const dPM = await signPlanDelegation(PC, 30n, swap, swap * 3n, { start: startC, expiry: expiryC, period: PERIOD, calls: 3n }), hPM = await hashOf(dPM);
      let cancelOp;
      await check('PM-0', 'keyless paymaster: no code on Robinhood Chain (read-only); code placed on the fork only; fork deposit', async () => {
        const mainnet = { code: (await remote.getCode({ address: PM })) ?? '0x', nonce: await remote.getTransactionCount({ address: PM }), balance: await remote.getBalance({ address: PM }) };
        assert.equal(mainnet.code, '0x'); assert.equal(mainnet.nonce, 0);
        await rpc('hardhat_setCode', [PM, pmCode]);
        await client.waitForTransactionReceipt({ hash: await W.keeper.writeContract({ address: EP, abi: epAbi, functionName: 'depositTo', args: [PM], value: v.parseEther('0.1'), gas: 200_000n }) });
        return { paymaster: PM, label: 'BAG-DCA fork-only paymaster v1', mainnetAtLatest: mainnet, forkDeposit: await deposit() };
      });
      await runC('PM-1', 'a purchase with a fresh delegation (budget 3 swaps): 1 swap spent, 2 remain', dPM, hPM, startC + 5n * PERIOD);
      await rpc('hardhat_setBalance', [sa.address, '0x0']);
      await check('PM-2', 'mainnet condition (paymaster has no code, deposit present, account funded): the signed cancel cannot execute; nonce, balances and delegation unchanged', async () => {
        cancelOp = await pmOp([{ to: DM, data: v.encodeFunctionData({ abi: dmAbi, functionName: 'disableDelegation', args: [asTuple(dPM)] }) }], (await now()) + 3600n);
        await rpc('hardhat_setCode', [PM, '0x']); await rpc('hardhat_setBalance', [sa.address, v.toHex(v.parseEther('1'))]);
        try {
          const before = await effects(hPM);
          const r = await reverts(() => handle(cancelOp));
          assert.deepEqual(await effects(hPM), before);
          return { ...r, unchanged: Object.keys(before) };
        } finally { await rpc('hardhat_setCode', [PM, pmCode]); await rpc('hardhat_setBalance', [sa.address, '0x0']); }
      });
      await check('PM-3', 'paymaster stripped from the signed operation (account funded): signature no longer matches (AA24); nothing changes', async () => {
        const stripped = { ...cancelOp, paymaster: undefined, paymasterVerificationGasLimit: undefined, paymasterPostOpGasLimit: undefined, paymasterData: undefined };
        await rpc('hardhat_setBalance', [sa.address, v.toHex(v.parseEther('1'))]);
        try {
          const before = await effects(hPM);
          const r = await reverts(() => handle(stripped));
          assert(r.reason.includes('AA24'), r.reason);
          assert.deepEqual(await effects(hPM), before);
          return r;
        } finally { await rpc('hardhat_setBalance', [sa.address, '0x0']); }
      });
      await check('PM-4', 'the same signed cancel executes on the fork; the account pays no gas (paymaster deposit does); delegation disabled', async () => {
        const before = await effects(hPM);
        const ev = await handle(cancelOp);
        const after = await effects(hPM);
        assert.equal(after.disabled, true); assert.equal(after.accountEth, 0n); assert.equal(after.nonce, before.nonce + 1n);
        assert.equal(before.deposit - after.deposit, ev.actualGasCost);
        return { paidByPaymaster: ev.actualGasCost, nonce: after.nonce };
      });
      await check('PM-5', 'cancel with budget remaining: the due run is refused (CannotUseADisabledDelegation); 2 swaps of budget were still unspent', async () => {
        await atTime((await read(PC, planAbi, 'lastExecution')) + PERIOD);
        const c = await programC(), before = await snapC(hPM)();
        assert.equal(before.counters.spent, swap); assert(before.counters.spent < swap * 3n);
        const r = await reverts(() => send('keeper', PC, planAbi, 'run', [c.transaction.to, c.transaction.data, ctxOf(dPM)]));
        assert(revertIs(r.reason, 'CannotUseADisabledDelegation') || r.reason.includes('0x05baa052'), r.reason);
        assert.deepEqual(await snapC(hPM)(), before);
        return { ...r, unspentBudget: swap * 3n - before.counters.spent };
      });
      const withdrawCall = async () => [{ to: USDG, data: v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [user.address, await bal(USDG, sa.address)] }) }];
      await check('PM-6', 'expiry: a withdraw signed with validUntil = now + 60 is refused after it (AA32); nothing changes', async () => {
        const op = await pmOp(await withdrawCall(), (await now()) + 60n);
        await atTime((await now()) + 120n);
        const before = await effects(hPM);
        const r = await reverts(() => handle(op));
        assert(r.reason.includes('AA32'), r.reason);
        assert.deepEqual(await effects(hPM), before);
        return r;
      });
      await check('PM-7', 'withdraw within its window: the remaining USDG returns to the owner EOA; the account pays no gas', async () => {
        const left = await bal(USDG, sa.address), e0 = await bal(USDG, user.address);
        const ev = await handle(await pmOp(await withdrawCall(), (await now()) + 3600n));
        assert.equal(await bal(USDG, sa.address), 0n); assert.equal(await bal(USDG, user.address) - e0, left);
        assert.equal(await client.getBalance({ address: sa.address }), 0n);
        return { withdrawnRaw: left, paidByPaymaster: ev.actualGasCost };
      });
      report.forkOnlyPaymaster = { address: PM, label: 'BAG-DCA fork-only paymaster v1' };
    }
  }
}

// ---- Real wallet signatures (from wallet/sign-test.html exports) against the deployed account ----
// --wallet-results a.json,b.json. The signatures are deliberately unusable (expired Timestamp caveat,
// delegate 0x…dEaD, zero gas); this checks only that the account accepts the wallet's signature format.
const walletFiles = (arg('--wallet-results') ?? '').split(',').filter(Boolean);
report.walletSignatureChecks = [];
if (walletFiles.length) {
  const env = kit.getSmartAccountsEnvironment(4663), DM = env.DelegationManager;
  const erc1271 = v.parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
  const deployed = new Set();
  for (const file of walletFiles) {
    const exp = JSON.parse(readFileSync(resolve(file), 'utf8'));
    assert.equal(exp.kind, 'WALLET_SIGNING_RESULTS_NOT_FORK_RESULTS');
    for (const [i, r] of exp.results.entries()) {
      if (r.outcome !== 'SIGNED' || !['W-DELEGATION-SA', 'W-USEROP'].includes(r.test)) continue;
      const id = `W-${r.wallet.rdns}-${r.test}-${i}`;
      await check(id, `${r.wallet.name} ${r.test}: the owner's wallet signature is valid for the deployed MultiSig account (ERC-1271); a changed message is not`, async () => {
        const owner = v.getAddress(r.account);
        const acct = await kit.toMetaMaskSmartAccount({ client, implementation: kit.Implementation.MultiSig, deployParams: [[owner], 1n], deploySalt: '0x',
          signer: [{ account: privateKeyToAccount(generatePrivateKey()) }] });  // signer unused: address comes from deployParams
        const expected = r.test === 'W-DELEGATION-SA' ? r.typedData.message.delegator : r.typedData.message.sender;
        assert.equal(acct.address.toLowerCase(), expected.toLowerCase(), 'derived account differs from the signed one');
        if (!deployed.has(acct.address)) {
          const { factory, factoryData } = await acct.getFactoryArgs();
          await client.waitForTransactionReceipt({ hash: await W.keeper.sendTransaction({ to: factory, data: factoryData, gas: 3_000_000n }) });
          deployed.add(acct.address);
        }
        const { EIP712Domain, ...types } = r.typedData.types;
        const td = { ...r.typedData, types };
        const ok = await read(acct.address, erc1271, 'isValidSignature', [v.hashTypedData(td), r.signature]);
        assert.equal(ok, '0x1626ba7e');
        const field = r.test === 'W-DELEGATION-SA' ? 'salt' : 'nonce';
        const tampered = await read(acct.address, erc1271, 'isValidSignature', [v.hashTypedData({ ...td, message: { ...td.message, [field]: BigInt(td.message[field]) + 1n } }), r.signature]);
        assert.notEqual(tampered, '0x1626ba7e');
        let redeem = null;
        if (r.test === 'W-DELEGATION-SA') {
          // Redeem as the named delegate (fork-only impersonation): the signature must pass and the
          // expired Timestamp caveat must be what refuses it.
          const m = r.typedData.message, dead = m.delegate;
          const d = { delegate: dead, delegator: m.delegator, authority: m.authority, caveats: m.caveats.map(c => ({ ...c, args: '0x' })), salt: BigInt(m.salt), signature: r.signature };
          const ctx = v.encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
            { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }], [[d]]);
          const exec = v.encodePacked(['address', 'uint256', 'bytes'], [USDG, 0n, v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [dead, 0n] })]);
          await rpc('hardhat_impersonateAccount', [dead]); await rpc('hardhat_setBalance', [dead, v.toHex(v.parseEther('1'))]);
          const dw = v.createWalletClient({ account: dead, chain, transport });
          redeem = await reverts(async () => {
            const h = await dw.writeContract({ address: DM, abi: v.parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])']), functionName: 'redeemDelegations', args: [[ctx], ['0x' + '0'.repeat(64)], [exec]], gas: 3_000_000n });
            const rc = await client.waitForTransactionReceipt({ hash: h }); if (rc.status !== 'success') throw new Error('redeem failed');
          });
          await rpc('hardhat_stopImpersonatingAccount', [dead]);
          assert(/expired|Timestamp/i.test(redeem.reason) && !/InvalidERC1271Signature|InvalidSignature/i.test(redeem.reason), 'unexpected refusal: ' + redeem.reason);
        }
        const res = { wallet: r.wallet.rdns, test: r.test, account: acct.address, erc1271: ok, tamperedRejected: true, redeem };
        report.walletSignatureChecks.push(res);
        return res;
      });
    }
  }
}

report.relayRejectedMethods = [...new Set(rejected)];
// Acceptance criterion "inner Composer call AND delivery pass SDK verification": the unchanged SDK
// measures the signer (the plan), which forwards delivery, so its overall verdict cannot be VERIFIED.
report.acceptance = { sdkFullVerification: report.sdkVerdicts.length && report.sdkVerdicts.every(x => x.status === 'VERIFIED') ? 'MET' : 'NOT_MET_UNCHANGED_SDK_MEASURES_FORWARDING_SIGNER',
  sdkVerdicts: report.sdkVerdicts,
  sdkForwardedDeliveryVerification: !sdkSupportsDelivery ? 'NOT_RUN_SDK_WITHOUT_FORWARDED_MODE'
    : report.sdkForwardedVerdicts.length === report.purchases.length && report.purchases.length >= 4 && report.sdkForwardedVerdicts.every(x => x.status === 'VERIFIED') ? 'MET' : 'NOT_MET' };
report.summary = { pass: cases.filter(c => c.status === 'PASS').length, fail: cases.filter(c => c.status === 'FAIL').length };
// Every retry used the same BAG, amount and SDK limits; only the quote changed.
report.quotePolicy = { retriesAllowed: compileRetries, retryDelaySeconds: retryDelayMs / 1000, retriedRefusal: 'PRICE_IMPACT_INVALID with reported negative impactBps only',
  bag: fixture.bag.definitionHash, amountRaw: GROSS, guardChanged: false };
report.status = blocked ? 'BLOCKED_NO_ACCEPTED_QUOTE' : report.summary.fail ? 'FAILED' : 'PASSED';
// Whether a negative (favorable) quote was actually accepted and executed in this run.
// Negative-path evidence counts only: negative quote -> executed purchase -> VERIFIED forwarded
// receipt for that same transaction. Accepted negative compiles that were not executed (e.g. the
// placeholder or template compiles) are reported separately and never counted as used.
const negativeCompiles = report.quoteAttempts.filter(a => a.accepted && Number.isSafeInteger(a.sdkQuoteImpactBps) && a.sdkQuoteImpactBps < 0);
const negativePurchases = report.purchases.filter(p => Number.isSafeInteger(p.priceImpactBps) && p.priceImpactBps < 0);
const negativeVerified = negativePurchases.filter(p => report.sdkForwardedVerdicts.some(v => v.transactionHash === p.transactionHash && v.status === 'VERIFIED'));
report.negativeImpact = {
  negativeQuotesUsed: negativeVerified.length,
  verifiedPurchases: negativeVerified.map(p => ({ id: p.id, transactionHash: p.transactionHash, impactBps: p.priceImpactBps, usd: p.priceImpactUsd })),
  executedButNotVerified: negativePurchases.filter(p => !negativeVerified.includes(p)).map(p => p.id),
  acceptedNegativeCompiles: negativeCompiles.length,
  note: negativeVerified.length ? 'negative quote(s) executed on the fork and their forwarded receipts VERIFIED'
    : 'no executed purchase used a negative quote with a VERIFIED receipt; the negative live path was not exercised',
};
writeFileSync(join(out, 'results.json'), json(report));
console.log(`\nSUMMARY status=${report.status} negativeQuotesUsed=${report.negativeImpact.negativeQuotesUsed} mode=${mode} pass=${report.summary.pass} fail=${report.summary.fail} sdkFullVerification=${report.acceptance.sdkFullVerification} sdkForwarded=${report.acceptance.sdkForwardedDeliveryVerification}  -> ${out}`);
relay.close(); await connection.close?.();
process.exit(report.summary.fail ? 1 : 0);
