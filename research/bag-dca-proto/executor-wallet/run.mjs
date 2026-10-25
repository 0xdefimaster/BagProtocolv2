// RecurringPurchaseExecutor with a wallet's own signatures, on the isolated Robinhood fork (model A: the USDG stays
// in the signer's address). The wallet SENDS NOTHING; it signs three EIP-712 messages:
//   1. Authorization for the executor at the keyless fork-only address (unusable on 4663: no code, no key)
//   2. USDG EIP-2612 Permit: spender = that executor, value = the total budget, deadline in 1 hour
//   3. Revocation of that authorization
// The fork then runs, with test keys for the keeper, planSigner and relayer:
//   purchase 1 (the permit is used inside execute) → a second try in the same window is refused → next window
//   purchase 2 → the relayer submits the Revocation → next window refused (RevokedAuthorization), allowance left visible.
// The account must be NEW and EMPTY on 4663 (no ETH, no USDG, no transactions, no code); its USDG exists only on the fork.
//
//   node executor-wallet/run.mjs --app <checkout> --signer wallet|test [--out <new dir>] [--url-file <f>] [--keep-open <ms>] [--env-file <f>]
// Exit: 0 every step as expected; 1 fatal; 2 usage, stale build or account not empty; 3 external (RPC); 4 a step failed; 5 rejected in the page.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v, accounts, reasonOf, json, PUBLIC_RPC, CHAIN_ID } from '../lib/fork-env.mjs';
import { startSigningServer } from '../wallet-fork/server.mjs';
import { checkStep, authorizationDisclosures } from './lib/sign-checks.mjs';
import { USDG, QUOTER_V2, EXECUTOR, DEP, DAY, USDG_UNIT, PRUNED_RE, erc20, redact, installNetworkGuard, UsageError, loadBuild, startExecutorFork, bagIdentity, limitsFromRealQuotes, permitTypedData, permitProof } from '../executor-fork/setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SIGNER = arg('--signer', 'test');
if (!['wallet', 'test'].includes(SIGNER)) { console.error('USAGE: --signer wallet|test'); process.exit(2); }
const app = resolve(arg('--app', join(here, '..', '..', '..')));
const SESSION = new Date().toISOString().replaceAll(':', '-').slice(0, 19) + '-' + randomBytes(3).toString('hex');
const out = resolve(arg('--out', join(here, 'out', SESSION)));
if (existsSync(out)) { console.error('USAGE: use a new --out directory'); process.exit(2); }
mkdirSync(out, { recursive: true });
const privateDir = join(here, 'private', SESSION);
let RPC = PUBLIC_RPC;
if (arg('--env-file')) for (const line of readFileSync(resolve(arg('--env-file')), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*ROBINHOOD_RPC_URL\s*=\s*(.*?)\s*$/); if (m && m[1]) RPC = m[1].replace(/^(['"])(.*)\1$/, '$2'); }
const network = installNetworkGuard(RPC);
const errText = e => [reasonOf(e), e?.message].filter(Boolean).join(' | ');
const sha = s => createHash('sha256').update(s).digest('hex');

const report = { schema: 'bag-recurring-executor-wallet/v1', session: SESSION, signer: SIGNER, evidenceClass: SIGNER === 'test' ? 'TEST_KEY' : 'HUMAN_WALLET_SIGNATURE', startedAt: new Date().toISOString(),
  notEvidenceOf: ['a public-network transaction', 'an independent market price reference'], steps: [] };
let env, server, exitCode = 0;
const step = async (id, title, fn) => {
  const s = { id, title };
  try { Object.assign(s, await fn()); } catch (e) { if (e.external || e instanceof UsageError || e.rejected) throw e; s.pass = false; s.error = redact(errText(e)); }
  report.steps.push(s);
  console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${id}  ${s.observed ?? s.error ?? ''}`);
  server?.setStatus(`${s.pass ? '✓' : '✗'} ${title}${s.observed ? ': ' + s.observed : ''}`);
  if (!s.pass) throw Object.assign(new Error(`${id} failed`), { stepFailed: true });
  return s;
};
try {
  const build = await loadBuild(app);
  const { sdk, uni, evm, execArt, BAG1 } = build;
  report.build = build.build;
  if (SIGNER === 'wallet') {
    server = await startSigningServer({ pageDir: join(here, 'page'), libDir: join(here, 'lib') });
    const urlFile = resolve(arg('--url-file', join(privateDir, 'url.txt')));
    mkdirSync(dirname(urlFile), { recursive: true });
    writeFileSync(urlFile, server.url + '\n', { mode: 0o600 });
    console.log(`signing page: ${server.url}\n(url also in ${urlFile})`);
    server.setStatus('Fork hazırlanıyor (gerçek USDG, Uniswap v3, BagFactory, StrategyRegistry)…');
  }
  env = await startExecutorFork({ rpcUrl: RPC, out, label: 'executor-wallet', build, roleNames: ['keeper', 'relayer', ...(SIGNER === 'test' ? ['owner'] : [])] });
  const { client, rpc, read, bal, keys, W, roles, send, fundUsdg, router, remote } = env;
  report.keylessExecutor = env.keyless; report.fork = env.fork; report.deployment = env.deployment;
  console.log(`fork @ ${env.fork.blockNumber}, executor ${EXECUTOR}`);

  // ---- The signer
  let account, signTyped;
  if (SIGNER === 'wallet') {
    account = await Promise.race([server.waitForAccount(), new Promise((_, rej) => setTimeout(() => rej(new Error('no wallet connected within 30 minutes')), 30 * 60_000))]);
    const wc = server.state().walletClient;
    report.walletClient = wc;
    if (wc?.automated) report.evidenceClass = 'TEST_KEY_VIA_SIGNING_PAGE';
    signTyped = async (id, title, kind, typedData, expect, info) => server.requestSignature({ id, title, kind, typedData, expect, info });
  } else {
    account = roles.owner;
    signTyped = async (_id, _t, _k, typedData) => { const { EIP712Domain: _d, ...types } = typedData.types; return keys.owner.signTypedData({ ...typedData, types }); };
  }
  report.account = account;

  await step('P-1', 'Hesap 4663 ana ağında yeni ve boş', async () => {
    const acct = { eth: await remote.getBalance({ address: account }), usdg: await remote.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [account] }), nonce: await remote.getTransactionCount({ address: account }), code: (await remote.getCode({ address: account })) ?? '0x' };
    report.accountOn4663 = acct;
    const empty = acct.eth === 0n && acct.usdg === 0n && acct.nonce === 0 && acct.code === '0x';
    if (SIGNER === 'wallet' && !empty) throw new UsageError(`use a NEW, EMPTY account: on 4663 it has ETH ${acct.eth}, USDG ${acct.usdg}, nonce ${acct.nonce}, code ${acct.code === '0x' ? 'none' : 'yes'}`);
    return { pass: empty, observed: `ETH ${acct.eth}, USDG ${acct.usdg}, nonce ${acct.nonce}, kod ${acct.code === '0x' ? 'yok' : 'VAR'}` };
  });

  // ---- Terms (955df6e0, 3 × 5 USDG, daily) and the fork-only USDG for the signer
  const id1 = await bagIdentity(read, sdk, BAG1);
  const GROSS = 5n * USDG_UNIT, RUNS = 3;
  const limitSources = {};
  const limits = await limitsFromRealQuotes({ remote, sdk, uni, doc: BAG1, amountPerRunRaw: GROSS, bufferBps: 300, sources: limitSources });
  await fundUsdg(account, 20n * USDG_UNIT);
  const startsAt = (await client.getBlock()).timestamp;
  const auth = sdk.buildRecurringAuthorization({ bag: BAG1, owner: account, funding: { kind: 'ALLOWANCE' }, inputToken: USDG, inputTokenDecimals: 6,
    registry: { bagId: id1.bagId, bagVersion: id1.version, compositionHash: id1.compositionHash, strategyId: null }, amountPerRunRaw: GROSS, runs: RUNS, totalBudgetRaw: BigInt(RUNS) * GROSS,
    startsAt, periodSeconds: DAY, maxPriceRaw: limits, route: { router, swapTarget: uni.ROBINHOOD_UNISWAP_V3.swapRouter02 }, nonce: 1n });
  const id = sdk.recurringAuthorizationId(auth, DEP);
  const summary = sdk.summarizeRecurringAuthorization(auth);
  report.terms = { authorizationId: id, summary, priceLimit: { source: 'best real-chain QuoterV2 quote at setup + 300 bps (TEST choice, not a market reference)', sources: limitSources }, bag: id1 };
  const symbols = Object.fromEntries((BAG1.metadata?.assets ?? []).map(m => [m.address.toLowerCase(), m.symbol]));
  // The market price each test limit was taken from (raw USDG per whole token), shown next to the fixed ceiling on the page.
  const marketPriceRaw = Object.fromEntries(BAG1.definition.assets.map(a => {
    const src = limitSources[`${BAG1.ref.strategyId}:${a.address.toLowerCase()}:300`];
    return [a.address.toLowerCase(), src?.realChainQuoteRaw ? (src.legInRaw * 10n ** BigInt(a.decimals) + src.realChainQuoteRaw - 1n) / src.realChainQuoteRaw : null];
  }));
  report.terms.disclosures = authorizationDisclosures({ assets: auth.assets }, marketPriceRaw);
  const wire = x => JSON.parse(json(x));
  const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

  // ---- Three signatures; the runner applies the same checks as the page before using any of them
  const authTd = sdk.recurringAuthorizationTypedData(auth, DEP);
  const permitDeadline = nowSec() + 3600n;
  const permitTd = permitTypedData({ owner: account, value: auth.schedule.totalBudget, nonce: await read(USDG, erc20, 'nonces', [account]), deadline: permitDeadline });
  const revokeTd = sdk.recurringRevocationTypedData(account, id, DEP);
  const requests = [
    { id: 'AUTH', title: '1/3 Yetki: dönemlik BAG alımı', kind: 'authorization', orig: authTd, typedData: wire({ ...authTd, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...authTd.types } }),
      expect: wire({ executor: EXECUTOR, authorization: auth }),
      info: wire({ keyless: `"${env.keyless.label}" → ${EXECUTOR}`, priceLimitSource: 'Kurulumda gerçek zincirdeki en iyi Uniswap v3 QuoterV2 teklifi + %3 (test seçimi; bağımsız piyasa referansı değildir)', assets: summary.assets.map(a => ({ ...a, symbol: symbols[a.asset] })), marketPriceRaw }) },
    { id: 'PERMIT', title: '2/3 USDG izni (EIP-2612, işlem değil)', kind: 'permit', orig: permitTd, typedData: wire({ ...permitTd, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...permitTd.types } }),
      expect: wire({ token: USDG, executor: EXECUTOR, value: auth.schedule.totalBudget, nonce: permitTd.message.nonce }) },
    { id: 'REVOKE', title: '3/3 İptal imzası', kind: 'revocation', orig: revokeTd, typedData: wire({ ...revokeTd, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...revokeTd.types } }),
      expect: wire({ executor: EXECUTOR, authorizationId: id }) },
  ];
  const sigs = {};
  for (const r of requests) {
    await step(`S-${r.id}`, r.title, async () => {
      const { bad } = checkStep(r, account, Number(nowSec()));
      if (bad.length) return { pass: false, observed: 'checks failed before signing: ' + bad.join('; ') };
      let signature;
      try { signature = await signTyped(r.id, r.title, r.kind, r.typedData, r.expect, r.info); } catch (e) { if (/user rejected/.test(e.message)) throw Object.assign(e, { rejected: true }); throw e; }
      const ok = await v.verifyTypedData({ address: account, ...r.orig, signature }); // the bigint original, not the JSON sent to the wallet
      sigs[r.id] = signature;
      return { pass: ok, observed: `imza ${ok ? 'doğrulandı' : 'DOĞRULANAMADI'} (sha256 ${sha(signature).slice(0, 16)}…)`, signatureSha256: sha(signature) };
    });
  }
  if (SIGNER === 'wallet') { mkdirSync(privateDir, { recursive: true }); writeFileSync(join(privateDir, 'signatures.json'), json({ session: SESSION, note: 'PRIVATE: signatures for the fork-only executor and a 1-hour USDG permit. Do not share.', account, items: sigs }), { mode: 0o600 }); }

  // ---- Lifecycle on the fork
  const execAbi = build.CALL_ABI;
  const evidence = evm.withReceiptEvidence(client, { balanceState: 'SINGLE_TRANSACTION_BLOCK' });
  // The fork mines nothing while the person signs; its latest block would be minutes old and a plan quoted from that time
  // would expire before the purchase is mined (QuoteExpired). One fork-only block brings the clock to now.
  const buildRun = async () => { await rpc('evm_mine'); return uni.buildRecurringRunPlan({ client, auth, deployment: DEP, quoter: QUOTER_V2, nowSeconds: (await client.getBlock()).timestamp }); };
  const signPlan = plan => keys.planSigner.signTypedData(uni.routerPlanTypedData(plan, { chainId: CHAIN_ID, router }));
  const xOf = async run => ({ authorizationId: id, window: run.execution.window, quoteDeadline: run.execution.quoteDeadline, plan: run.plan, planSignature: await signPlan(run.plan) });
  const decode = e => { for (let x = e; x; x = x.cause) if (x.data?.errorName) return `${x.data.errorName}(${(x.data.args ?? []).map(String).join(',')})`; return redact(errText(e)).slice(0, 200); };
  const snap = async () => ({ state: await read(EXECUTOR, execArt.abi, 'getState', [account, id]), usdg: await bal(USDG, account), allowance: await read(USDG, erc20, 'allowance', [account, EXECUTOR]),
    transit: [await bal(USDG, EXECUTOR), await bal(USDG, router), ...(await Promise.all(auth.assets.flatMap(a => [bal(a.asset, EXECUTOR), bal(a.asset, router)])))] });
  const execute = async (x, fundingProof = '0x') => {
    let reason = null;
    try { await client.simulateContract({ account: keys.keeper, address: EXECUTOR, abi: execAbi, functionName: 'execute', args: [auth, x, sigs.AUTH, fundingProof] }); } catch (e) { if (PRUNED_RE.test(errText(e))) throw Object.assign(new Error('PRUNED_STATE'), { external: true }); reason = decode(e); }
    let hash = null, status = 'reverted', sendError = null;
    try { hash = await W.keeper.writeContract({ address: EXECUTOR, abi: execAbi, functionName: 'execute', args: [auth, x, sigs.AUTH, fundingProof], gas: 8_000_000n }); status = (await client.waitForTransactionReceipt({ hash })).status; } catch (e) { sendError = decode(e); }
    return { reason, hash, status, sendError };
  };
  const purchase = async (fundingProof) => {
    const before = await snap();
    const run = await buildRun();
    const x = await xOf(run);
    const t = await execute(x, fundingProof);
    if (t.status !== 'success') return { pass: false, observed: `execute failed: simulation ${t.reason ?? 'passed'}, send ${t.sendError ?? 'no error'}` };
    // SDK: the mined call is exactly the prepared one (the wallet's Authorization signature inside), balances transaction-scoped.
    const vr = await sdk.verifyRecurringPurchase({ client: evidence, transactionHash: t.hash, auth, deployment: DEP, intent: { execution: x, ownerSignature: sigs.AUTH, fundingProof: fundingProof ?? '0x' } });
    const after = await snap();
    const ok = vr.status === 'VERIFIED' && vr.transactionBinding === 'PREPARED_INTENT' && vr.evidence === 'TRANSACTION_AND_BALANCE_DELTAS' && vr.source?.debitRaw === before.usdg - after.usdg
      && before.usdg - after.usdg === GROSS && after.transit.every(b => b === 0n) && Number(after.state.executions) === Number(before.state.executions) + 1;
    return { pass: ok, tx: t.hash, sdkVerification: { status: vr.status, binding: vr.transactionBinding, evidence: vr.evidence, balanceScope: vr.balanceScope, source: vr.source }, issues: vr.issues, deliveries: vr.deliveries,
      observed: `${vr.status} (${vr.transactionBinding}, ${vr.balanceScope}); USDG ${before.usdg} → ${after.usdg}; izin ${after.allowance}; alım ${after.state.executions}` };
  };
  const refusedStep = async (expectName) => {
    const before = await snap();
    const run = await buildRun();
    const t = await execute(await xOf(run));
    const after = await snap();
    const unchanged = json(before) === json(after);
    return { pass: t.status !== 'success' && String(t.reason).startsWith(expectName) && unchanged, stateUnchanged: unchanged, observed: `${t.status}: ${t.reason}; durum değişmedi: ${unchanged}` };
  };
  const pf = permitProof(auth.schedule.totalBudget, permitDeadline, sigs.PERMIT);
  await step('H-1', 'Alım 1 (permit execute içinde kullanıldı)', () => purchase(pf.proof));
  await step('H-2', 'Aynı dönemde ikinci deneme reddedildi', () => refusedStep('NotDue'));
  await rpc('evm_increaseTime', [Number(DAY)]); await rpc('evm_mine');
  await step('H-3', 'Sonraki dönemde alım 2', () => purchase('0x'));
  await step('H-4', 'İptal imzası aracı tarafından zincire gönderildi (revokeBySig)', async () => {
    const before = await read(USDG, erc20, 'allowance', [account, EXECUTOR]);
    await send(W.relayer, EXECUTOR, execArt.abi, 'revokeBySig', [account, id, sigs.REVOKE]);
    const st = await read(EXECUTOR, execArt.abi, 'getState', [account, id]);
    const after = await read(USDG, erc20, 'allowance', [account, EXECUTOR]);
    return { pass: st.revoked && after === before, observed: `iptal=${st.revoked}; kalan izin ${after} (iptal izni sıfırlamaz; approve(0) ayrı işlemdir)` };
  });
  await rpc('evm_increaseTime', [Number(DAY)]); await rpc('evm_mine');
  await step('H-5', 'İptalden sonra alım reddedildi; kalan izin görünür', async () => {
    const r = await refusedStep('RevokedAuthorization');
    const allowance = await read(USDG, erc20, 'allowance', [account, EXECUTOR]);
    return { ...r, allowanceLeft: allowance, pass: r.pass && allowance === GROSS, observed: r.observed + `; kalan izin ${allowance}` };
  });
  report.result = { purchases: 2, ownerUsdgOnFork: await bal(USDG, account), fundsStayedInOwnerAddress: true, expected: '2 alım × 5 USDG; ret (aynı dönem); iptal; iptal sonrası ret; 5 USDG izin görünür kaldı' };
  server?.setStatus('Bitti: 2 alım, 2 ret, 1 iptal. Sonuç dosyası yazıldı.');
} catch (e) {
  if (e instanceof UsageError) { report.exit = { code: 2, status: 'USAGE', detail: e.message }; exitCode = 2; }
  else if (e.rejected) { report.exit = { code: 5, status: 'REJECTED_IN_PAGE', detail: e.message }; exitCode = 5; }
  else if (e.stepFailed) { report.exit = { code: 4, status: 'STEP_FAILED', detail: e.message }; exitCode = 4; }
  else if (e.external || PRUNED_RE.test(errText(e))) { report.exit = { code: 3, status: 'EXTERNAL', detail: redact(errText(e)) }; exitCode = 3; }
  else { report.exit = { code: 1, status: 'FATAL', detail: redact(errText(e)), stack: redact(e?.stack ?? '') }; exitCode = 1; }
  console.error(report.exit.status, report.exit.detail);
  server?.setStatus('Hata: ' + report.exit.detail);
} finally {
  report.exit ??= { code: 0, status: 'COMPLETE' };
  report.network = { ...network, relay: env?.relay?.stats, forkLocalTransactions: env?.F?.localTx?.sent, publicWrites: 0, walletTransactions: 0 };
  report.forkChanges = env?.F?.changes;
  report.signaturesInThisFolder = false;
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, 'results.json'), json(report));
  if (json(report).match(/0x[0-9a-fA-F]{130}/)) { console.error('a 65-byte signature reached the shareable report: refusing'); writeFileSync(join(out, 'results.json'), '{"error":"redacted: signature found"}'); exitCode = exitCode || 1; }
  console.log(`exit ${report.exit.code} ${report.exit.status} (${report.evidenceClass}); results: ${join(out, 'results.json')}`);
  try { await server?.close({ keepOpenMs: Number(arg('--keep-open', '0')) }); } catch {}
  try { await env?.F?.close(); } catch {}
  try { await env?.relay?.close(); } catch {}
  process.exit(exitCode);
}
