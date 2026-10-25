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

const sources = Object.fromEntries(['DcaComposerPlan.sol', 'LocalArbSysRead.sol'].map(f => [f, { content: readFileSync(join(here, 'contracts', f), 'utf8') }]));
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
  planRuntimeBytes: (art('DcaComposerPlan').runtime.length - 2) / 2, quoteAttempts: [], sdkVerdicts: [], sdkForwardedVerdicts: [], sdk: { dir: '<sdk>', supportsForwardedDelivery: sdkSupportsDelivery }, cases };

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

async function compileFor(signer) {
  if (mode === 'live') {
    const account = await resolveLifiComposerAccount({ chainId: 4663, signer, deployment, client: remote });
    const attempt = { signer, capturedAt: new Date().toISOString(), responses: [] };
    report.quoteAttempts.push(attempt);
    const captureFetch = async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'error' });
      let body; try { body = await response.clone().json(); } catch { body = null; }
      const pi = body?.data?.priceImpact ?? body?.priceImpact;
      attempt.responses.push({ path: new URL(url).pathname, status: response.status,
        composerVersion: response.headers.get('x-lifi-composer-version'), revision: response.headers.get('x-revision'),
        priceImpact: pi ? { inputValueUsd: pi.inputValueUsd, outputValueUsd: pi.outputValueUsd,
          impactBps: pi.impactBps, unpricedInputs: pi.unpricedInputs, unpricedOutputs: pi.unpricedOutputs } : null });
      return response;
    };
    const provider = lifiComposer({ apiKey: cfg.apiKey, baseUrl: 'https://composer.li.quest', account, timeoutMs: 60000, fetch: captureFetch });
    try {
      const compiled = await sdk.compileBag(parsed.bag, { inputToken: USDG, amountRaw: GROSS, inputTokenDecimals: 6, signer }, { provider, trust: account.trust });
      attempt.status = 'ACCEPTED'; attempt.priceImpactBps = compiled.quote.priceImpactBps;
      attempt.priceImpactUsd = compiled.quote.priceImpactUsd;
      attempt.compiledProgramHash = v.keccak256(compiled.transaction.data);
      console.log('QUOTE impactBps=' + compiled.quote.priceImpactBps);
      return compiled;
    } catch (e) {
      attempt.status = 'REJECTED'; attempt.error = cfg.redact(e?.message ?? e); throw e;
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
    report.sdkForwardedVerdicts.push({ id, status: r.status, issues: r.issues, delivery: r.delivery, priceImpactBps: compiled.quote.priceImpactBps, priceImpactUsd: compiled.quote.priceImpactUsd });
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

async function model(label, terms, nonce, setup, permissionContextFor, extra) {
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
      return { transactionHash: hash, gasUsed: r.gasUsed, swapAmount: swap, priceImpactBps: c.quote.priceImpactBps, priceImpactUsd: c.quote.priceImpactUsd };
    });
    if (hash) await sdkChecks(id, c, hash, P, terms.source);
  };
  await runOnce(label + '-4', 1);
  const now = (await client.getBlock()).timestamp, last = await read(P, planAbi, 'lastExecution');
  if (last + PERIOD > now) await rpc('evm_setNextBlockTimestamp', [Number(last + PERIOD)]), await rpc('evm_mine');
  if (mode === 'live') compiled = await compileFor(P);
  await failureCase(label + '-5', P, compiled, TD, permissionContext, extra && (() => extra(P)));
  await runOnce(label + '-6', 2);
}

if (TD) {
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
  }, () => '0x', null);

  // ---- Model B ----------------------------------------------------------------------------
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
  const enforcers = async () => ({
    period: (await read(E.ERC20PeriodTransferEnforcer, v.parseAbi(['function periodicAllowances(address,bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), 'periodicAllowances', [DM, delegationHash]))[4],
    spent: await read(E.ERC20TransferAmountEnforcer, v.parseAbi(['function spentMap(address,bytes32) view returns (uint256)']), 'spentMap', [DM, delegationHash]),
    calls: await read(E.LimitedCallsEnforcer, v.parseAbi(['function callCounts(address,bytes32) view returns (uint256)']), 'callCounts', [DM, delegationHash]),
    accountUsdg: await bal(USDG, sa.address) });
  await model('B', termsB, 2n, async P => {
    await check('B-setup', 'keeper deploys the plan; user signs one delegation bounded by the enforcers', async () => {
      await send('keeper', factoryAddr, factoryAbi, 'deploy', [termsB, asProfile(TD), 2n]);
      const caveats = [
        { enforcer: E.ERC20PeriodTransferEnforcer, terms: v.encodePacked(['address', 'uint256', 'uint256', 'uint256'], [USDG, swap, PERIOD, termsB.start]), args: '0x' },
        { enforcer: E.ERC20TransferAmountEnforcer, terms: v.encodePacked(['address', 'uint256'], [USDG, swap * RUNS]), args: '0x' },
        { enforcer: E.LimitedCallsEnforcer, terms: v.encodePacked(['uint256'], [RUNS]), args: '0x' },
        { enforcer: E.TimestampEnforcer, terms: v.encodePacked(['uint128', 'uint128'], [termsB.start - 1n, termsB.expiry]), args: '0x' },
        { enforcer: E.RedeemerEnforcer, terms: P, args: '0x' },
        { enforcer: E.AllowedCalldataEnforcer, terms: v.concat([v.toHex(4n, { size: 32 }), v.pad(P, { size: 32 })]), args: '0x' }];
      const d = { delegate: P, delegator: sa.address, authority: ROOT_AUTHORITY, caveats, salt: 1n, signature: '0x' };
      delegation = { ...d, signature: await sa.signDelegation({ delegation: d }) };
      delegationHash = await read(DM, v.parseAbi(['function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)) pure returns (bytes32)']), 'getDelegationHash',
        [[delegation.delegate, delegation.delegator, delegation.authority, delegation.caveats.map(c => [c.enforcer, c.terms, c.args]), delegation.salt, delegation.signature]]);
      return { account: sa.address, implementation: 'MultiSigDeleGator v1.3.0 (bytecode verified)', userSignatures: 1, userTransactions: 1, delegationHash };
    });
  }, () => v.encodeAbiParameters([delegationType], [[delegation]]), enforcers);
}

report.relayRejectedMethods = [...new Set(rejected)];
// Acceptance criterion "inner Composer call AND delivery pass SDK verification": the unchanged SDK
// measures the signer (the plan), which forwards delivery, so its overall verdict cannot be VERIFIED.
report.acceptance = { sdkFullVerification: report.sdkVerdicts.length && report.sdkVerdicts.every(x => x.status === 'VERIFIED') ? 'MET' : 'NOT_MET_UNCHANGED_SDK_MEASURES_FORWARDING_SIGNER',
  sdkVerdicts: report.sdkVerdicts,
  sdkForwardedDeliveryVerification: !sdkSupportsDelivery ? 'NOT_RUN_SDK_WITHOUT_FORWARDED_MODE'
    : report.sdkForwardedVerdicts.length === 4 && report.sdkForwardedVerdicts.every(x => x.status === 'VERIFIED') ? 'MET' : 'NOT_MET' };
report.negativeImpact = {
  acceptedQuotes: report.quoteAttempts.filter(q => q.status === 'ACCEPTED' && q.priceImpactBps < 0).length,
  verifiedPurchaseIds: report.sdkForwardedVerdicts.filter(q => q.status === 'VERIFIED' && q.priceImpactBps < 0).map(q => q.id),
  negativeQuotesUsed: report.sdkForwardedVerdicts.filter(q => q.status === 'VERIFIED' && q.priceImpactBps < 0).length
};
report.summary = { pass: cases.filter(c => c.status === 'PASS').length, fail: cases.filter(c => c.status === 'FAIL').length };
writeFileSync(join(out, 'results.json'), json(report));
console.log(`\nSUMMARY mode=${mode} pass=${report.summary.pass} fail=${report.summary.fail} sdkFullVerification=${report.acceptance.sdkFullVerification} sdkForwarded=${report.acceptance.sdkForwardedDeliveryVerification}  -> ${out}`);
relay.close(); await connection.close?.();
process.exit(report.summary.fail ? 1 : 0);
