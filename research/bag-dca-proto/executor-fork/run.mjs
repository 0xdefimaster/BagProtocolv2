// RecurringPurchaseExecutor (app: contracts/dca/) on an isolated Robinhood Chain fork, against the REAL
// USDG, Uniswap v3 SwapRouter02/QuoterV2, BagFactory and StrategyRegistry. Composer-free: every quote is a
// QuoterV2 eth_call through the SDK's `@bagprotocol/sdk/uniswap-v3` run builder; no HTTP API is reachable.
//
// Nothing reaches a public network with a write: the fork reads state through the read-only relay
// (lib/fork-env.mjs), every JS fetch is limited to that relay's upstream RPC, and every signature comes from
// a key generated in this process (TEST KEY evidence; not a wallet, not a human). The executor runs at a
// keyless address derived from a fixed string, so an authorization signed here cannot be used on 4663.
//
// Scenario kinds (reported separately, never summed):
//   LIFECYCLE            honest runs; verified with the SDK's verifyRecurringPurchase against the call prepared
//                        here (byte for byte) with transaction-scoped balances, and cross-checked with the
//                        runner's own fork balance reads
//   REAL_FAULT           a wrong transaction actually sent and mined on the fork (bad plan, moved market,
//                        stale BAG version, another asset list, revoked/exhausted/expired authorization);
//                        state must not change
//   SDK_REFUSAL          the SDK refuses to build (no route, price limit not met, list not the BAG's content)
//   ALTERED_EXPECTATION  the SDK verifier given a deliberately wrong expectation for a mined transaction
//   EVIDENCE_SCOPE       the balance reader refuses what it cannot prove (a busy block → INDETERMINATE)
//
// Usage (from the app checkout, after `hardhat build` and the SDK build):
//   node research/bag-dca-proto/executor-fork/run.mjs --app . --out <new dir> [--env-file <file with ROBINHOOD_RPC_URL>]
// Exit: 0 all scenarios as expected; 2 usage/stale build; 3 external (RPC/pruned state); 4 a scenario failed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { v, accounts, reasonOf, json, PUBLIC_RPC, CHAIN_ID } from '../lib/fork-env.mjs';
import { USDG, SWAP_ROUTER02, QUOTER_V2, UNIVERSAL_ROUTER, EXECUTOR, DEP, DAY, USDG_UNIT, PRUNED_RE, CHAIN_LABEL, erc20, redact, installNetworkGuard, UsageError, loadBuild, startExecutorFork, bagIdentity, limitsFromRealQuotes } from './setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const usage = m => { console.error('USAGE: ' + m); process.exit(2); };
const app = resolve(arg('--app', join(here, '..', '..', '..')));
const out = resolve(arg('--out', join(here, 'out', new Date().toISOString().replaceAll(':', '-'))));
if (existsSync(out)) usage('use a new --out directory');
mkdirSync(out, { recursive: true });
let RPC = PUBLIC_RPC;
if (arg('--env-file')) for (const line of readFileSync(resolve(arg('--env-file')), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*ROBINHOOD_RPC_URL\s*=\s*(.*?)\s*$/); if (m && m[1]) RPC = m[1].replace(/^(['"])(.*)\1$/, '$2');
}
const errText = e => [reasonOf(e), e?.message].filter(Boolean).join(' | ');

// Network guard (setup.mjs): only the relay and its upstream RPC host; Composer/LI.FI is counted and refused.
const network = installNetworkGuard(RPC);
/** BagFactory `BagCreated`/`BagVersionRecorded` history of a3caff05, read from the chain on 25.10.2026. */
const A3_V1 = { version: 1n, compositionHash: '0x6a291ac1a42642f58fee439e1d34627dfd94815e2f9a1278d02e162c8c34753a', block: 92213308 };

const report = { schema: 'bag-recurring-executor-fork/v1', evidenceClass: 'TEST_KEY_FORK', startedAt: new Date().toISOString(), args: args.filter(a => !/https?:|[A-Za-z0-9_-]{32,}/.test(a)),
  notEvidenceOf: ['a wallet (MetaMask/Rabby) signature', 'a human signature', 'a public-network transaction', 'an independent market price reference'] };
const scenarios = [];
let relay, F, exitCode = 0;
const quoteDiagnostics = { nonRevertErrors: [] };
try {
  // ---- App build, relay, keyless check, fork, fork-only edits and deployment: setup.mjs (shared with executor-wallet/)
  const build = await loadBuild(app);
  const { execArt, routerArt, sdk, uni, evm, BAG1, BAG2, ERROR_ABI, CALL_ABI } = build;
  report.build = build.build;
  const EXEC_ABI = execArt.abi, ROUTER_ABI = routerArt.abi;
  const env = await startExecutorFork({ rpcUrl: RPC, out, label: 'executor-fork', build, roleNames: ['owner', 'keeper', 'attacker', 'relayer'], fund: { owner: 100n * USDG_UNIT, attacker: 50_000n * USDG_UNIT } });
  relay = env.relay; F = env.F;
  const { remote, client, rpc, read, bal, keys, W, roles, send, router } = env;
  report.keylessExecutor = env.keyless; report.fork = env.fork; report.deployment = env.deployment;
  report.testAccounts = { ...roles, note: 'keys generated in this process and discarded at exit; none is a user wallet' };
  // Purchase evidence: the SDK's reader over the fork RPC. SINGLE_TRANSACTION_BLOCK reads balanceOf at the parent block and at the
  // purchase block, so it is only valid (and only accepted) when the purchase is the block's only transaction (automine here).
  const evidence = evm.withReceiptEvidence(client, { balanceState: 'SINGLE_TRANSACTION_BLOCK' });
  report.purchaseVerification = { sdk: 'verifyRecurringPurchase', binding: 'PREPARED_INTENT (the exact execute calldata prepared by this runner)', balanceReader: 'SINGLE_TRANSACTION_BLOCK',
    crossCheck: 'the runner\'s own latest-state balance snapshots before/after each run', realChainReader: 'not exercised here: Robinhood Chain needs ROBINHOOD_NITRO_TRANSACTION_INDEX on the qualified Nitro build' };
  const intents = new Map();
  console.log(`fork @ ${F.block.number} (${F.block.hash.slice(0, 10)}…), executor ${EXECUTOR}`);

  // ---- On-chain BAG identity (real BagFactory, Bag and StrategyRegistry on the fork)
  const id1 = await bagIdentity(read, sdk, BAG1), id2 = await bagIdentity(read, sdk, BAG2);
  report.bags = { [BAG1.ref.strategyId]: id1, [BAG2.ref.strategyId]: id2 };
  if (id1.compositionHash !== id1.sdkCompositionHash || id2.compositionHash !== id2.sdkCompositionHash) throw new Error('SDK composition hash does not reproduce the on-chain Bag');

  // ---- Helpers: authorization, plan, execution, state
  const now = async () => (await client.getBlock()).timestamp;
  const terms = (doc, idn, over = {}) => ({ bag: doc, owner: roles.owner, funding: { kind: 'ALLOWANCE' }, inputToken: USDG,
    registry: { bagId: idn.bagId, bagVersion: idn.version, compositionHash: idn.compositionHash, strategyId: idn.registered ? idn.strategyId : null, strategyVersion: idn.registered ? doc.ref.version : null },
    route: { router, swapTarget: SWAP_ROUTER02 }, ...over });
  const ownerSign = auth => keys.owner.signTypedData(sdk.recurringAuthorizationTypedData(auth, DEP));
  const signPlan = plan => keys.planSigner.signTypedData(uni.routerPlanTypedData(plan, { chainId: CHAIN_ID, router }));
  // The builder sees the fork through this client; a non-revert failure is kept (redacted) so RPC_READ_FAILED is diagnosable.
  const quoteClient = { simulateContract: async a => { try { return await client.simulateContract(a); } catch (e) {
    let revert = false; for (let x = e; x; x = x.cause) if (x?.name === 'ContractFunctionRevertedError') revert = true;
    if (!revert) { quoteDiagnostics.nonRevertErrors.push(redact(errText(e))); if (PRUNED_RE.test(errText(e))) throw Object.assign(new Error('PRUNED_STATE'), { external: true }); }
    throw e; } } };
  const buildRun = async (auth, o = {}) => uni.buildRecurringRunPlan({ client: quoteClient, auth, deployment: DEP, quoter: QUOTER_V2, nowSeconds: (await now()) + 1n, ...o });
  const xOf = (run, planSignature, over = {}) => ({ authorizationId: run.execution.authorizationId, window: run.execution.window, quoteDeadline: run.execution.quoteDeadline, plan: run.plan, planSignature, ...over });
  /** Owner limit for this TEST: the best real-chain QuoterV2 quote (latest block, read-only relay) for one run's leg, plus
   *  `bufferBps`. A test convenience, not a market reference. An asset without any quote gets a far fallback (recorded). */
  const limitSources = {};
  const limitsFromQuotes = (doc, amountPerRunRaw, bufferBps) => limitsFromRealQuotes({ remote, sdk, uni, doc, amountPerRunRaw, bufferBps, sources: limitSources });
  const decodeErr = e => {
    for (let x = e; x; x = x.cause) if (x.data?.errorName) return { name: x.data.errorName, args: (x.data.args ?? []).map(a => String(a)) };
    for (let x = e; x; x = x.cause) if (x.reason) return { name: 'Error', args: [x.reason] };
    for (const raw of errText(e).match(/0x[0-9a-fA-F]{8,}/g) ?? []) { try { const d = v.decodeErrorResult({ abi: [...ERROR_ABI, { type: 'error', name: 'Error', inputs: [{ type: 'string' }] }], data: raw }); return { name: d.errorName, args: (d.args ?? []).map(String) }; } catch {} }
    return { name: 'UNDECODED', text: redact(errText(e)) };
  };
  async function snapshot(auth) {
    const id = sdk.recurringAuthorizationId(auth, DEP);
    const st = await read(EXECUTOR, EXEC_ABI, 'getState', [auth.owner, id]);
    const tokens = [USDG, ...auth.assets.map(a => a.asset)];
    const holders = { owner: auth.owner, recipient: auth.recipient, executor: EXECUTOR, router };
    const balances = {};
    for (const [k, h] of Object.entries(holders)) balances[k] = Object.fromEntries(await Promise.all(tokens.map(async t => [t.toLowerCase(), await bal(t, h)])));
    return { state: { executions: st.executions, grossUsed: st.grossUsed, lastWindow: st.lastWindow, lastExecutionAt: st.lastExecutionAt, revoked: st.revoked }, balances,
      ownerAllowanceToExecutor: await read(USDG, erc20, 'allowance', [auth.owner, EXECUTOR]), executorAllowanceToRouter: await read(USDG, erc20, 'allowance', [EXECUTOR, router]),
      routerAllowanceToSwapRouter: await read(USDG, erc20, 'allowance', [router, SWAP_ROUTER02]) };
  }
  /** Sends `execute` for real (fixed gas, so it is mined even when it reverts) after decoding the reason with eth_call. */
  async function sendExecute(a, x, ownerSignature, fundingProof = '0x', from = 'keeper') {
    const callArgs = [a, x, ownerSignature, fundingProof];
    let simulated;
    try { await client.simulateContract({ account: keys[from], address: EXECUTOR, abi: CALL_ABI, functionName: 'execute', args: callArgs }); simulated = { ok: true }; }
    catch (e) { if (PRUNED_RE.test(errText(e))) throw Object.assign(new Error('PRUNED_STATE'), { external: true }); simulated = { ok: false, error: decodeErr(e) }; }
    const nonceBefore = await client.getTransactionCount({ address: keys[from].address });
    let hash, receipt, sendError;
    try { hash = await W[from].writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: 'execute', args: callArgs, gas: 8_000_000n }); receipt = await client.waitForTransactionReceipt({ hash }); }
    catch (e) { sendError = decodeErr(e); }
    const nonceAfter = await client.getTransactionCount({ address: keys[from].address });
    // EDR answers a mined revert with an error instead of the hash: find the mined transaction by sender and nonce.
    if (!hash && nonceAfter === nonceBefore + 1) {
      const blk = await client.getBlock({ includeTransactions: true });
      hash = blk.transactions.find(x => x.from.toLowerCase() === keys[from].address.toLowerCase() && x.nonce === nonceBefore)?.hash;
      if (hash) receipt = await client.getTransactionReceipt({ hash });
    }
    return { simulated, hash, status: receipt?.status ?? 'reverted', gasUsed: receipt?.gasUsed, mined: nonceAfter === nonceBefore + 1, sendError };
  }
  const same = (a, b) => json(a) === json(b);
  async function scenario(id, meta, fn) {
    const s = { id, ...meta };
    try { Object.assign(s, await fn()); }
    catch (e) { if (e.external) throw e; s.pass = false; s.error = redact(errText(e)); }
    scenarios.push(s);
    console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${id}  ${s.kind}  ${s.observed ?? s.error ?? ''}`);
    return s;
  }
  /** A refused transaction: the decoded reason must match and nothing observable may change. */
  async function refused(auth, x, ownerSignature, expectName, { fundingProof = '0x', expectArgs, from } = {}) {
    const before = await snapshot(auth);
    const t = await sendExecute(auth, x, ownerSignature, fundingProof, from);
    const after = await snapshot(auth);
    const reason = t.simulated.error;
    const reasonOk = !t.simulated.ok && (expectName === null ? reason !== undefined : Array.isArray(expectName) ? expectName.includes(reason?.name) : reason?.name === expectName) && (!expectArgs || expectArgs.every((v_, i) => v_ === undefined || String(reason.args?.[i]) === String(v_)));
    return { observed: `${t.status}${t.mined ? ' (mined)' : ''}: ${reason ? reason.name + '(' + (reason.args ?? []).join(',') + ')' : 'no revert'}`, reason, tx: t.hash, mined: t.mined, stateUnchanged: same(before, after),
      pass: reasonOk && t.status !== 'success' && same(before, after) };
  }
  /** An honest run: SDK plan, planSigner signature, execute, SDK receipt verification and absolute fork balances. */
  async function honest(auth, ownerSignature, { fundingProof = '0x', expectedAllowanceAfter } = {}) {
    const before = await snapshot(auth);
    const run = await buildRun(auth);
    const x = xOf(run, await signPlan(run.plan));
    const t = await sendExecute(auth, x, ownerSignature, fundingProof);
    if (t.status !== 'success') {
      if (t.sendError && PRUNED_RE.test(json(t.sendError))) throw Object.assign(new Error('PRUNED_STATE during execute'), { external: true });
      return { pass: false, observed: `execute failed: simulation ${json(t.simulated)}, send ${json(t.sendError ?? null)}` };
    }
    const intent = { execution: x, ownerSignature, fundingProof };
    intents.set(t.hash, intent);
    const verify = await sdk.verifyRecurringPurchase({ client: evidence, transactionHash: t.hash, auth, deployment: DEP, intent });
    const after = await snapshot(auth);
    const lc = x => x.toLowerCase(), gross = auth.schedule.grossAmountPerRun;
    const checks = {
      sdkVerified: verify.status === 'VERIFIED' && verify.transactionBinding === 'PREPARED_INTENT' && verify.evidence === 'TRANSACTION_AND_BALANCE_DELTAS',
      sdkSourceDebitEqualsFork: verify.source?.debitRaw === before.balances.owner[lc(USDG)] - after.balances.owner[lc(USDG)],
      ownerDebitExact: before.balances.owner[lc(USDG)] - after.balances.owner[lc(USDG)] === gross,
      sdkDeliveriesEqualForkBalances: auth.assets.every((a, i) => after.balances.recipient[lc(a.asset)] - before.balances.recipient[lc(a.asset)] === verify.deliveries[i].receivedRaw && verify.deliveries[i].receivedRaw === verify.deliveries[i].logReceivedRaw),
      sdkNoTransit: verify.transit.length > 0 && verify.transit.every(tr => tr.netRaw === 0n),
      atOrAboveOwnerLimit: verify.deliveries.every(d => d.receivedRaw >= d.minimumRaw),
      noTransitBalance: ['executor', 'router'].every(k => Object.values(after.balances[k]).every(b => b === 0n)),
      allowancesBackToZero: after.executorAllowanceToRouter === 0n && after.routerAllowanceToSwapRouter === 0n,
      ownerAllowanceUsedExactly: expectedAllowanceAfter === undefined ? before.ownerAllowanceToExecutor - after.ownerAllowanceToExecutor === gross : after.ownerAllowanceToExecutor === expectedAllowanceAfter,
      countersAdvanced: after.state.executions === before.state.executions + 1 && after.state.grossUsed === before.state.grossUsed + gross && BigInt(after.state.lastWindow) === run.execution.window,
    };
    return { purchase: true, pass: Object.values(checks).every(Boolean), checks, tx: t.hash, gasUsed: t.gasUsed, window: run.execution.window,
      legs: run.legs.map((l, i) => ({ asset: l.asset, fee: l.fee, amountInRaw: l.amountInRaw, quotedOutRaw: l.quotedOutRaw, minimumOutRaw: l.minimumOutRaw, ownerLimitFloorRaw: l.priceLimitFloorRaw, receivedRaw: verify.deliveries[i].receivedRaw })),
      sdkVerification: { status: verify.status, binding: verify.transactionBinding, evidence: verify.evidence, balanceScope: verify.balanceScope, source: verify.source, issues: verify.issues },
      ownerUsdgAfter: after.balances.owner[lc(USDG)], ownerAllowanceAfter: after.ownerAllowanceToExecutor,
      observed: `${verify.status} (${verify.transactionBinding}, ${verify.balanceScope}), debit ${verify.source?.debitRaw} raw, executions ${after.state.executions}, gas ${t.gasUsed}` };
  }
  const permitSig = async (value, deadline) => {
    const nonce = await read(USDG, erc20, 'nonces', [roles.owner]);
    const sig = v.parseSignature(await keys.owner.signTypedData({ domain: { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }, primaryType: 'Permit',
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      message: { owner: roles.owner, spender: EXECUTOR, value, nonce, deadline } }));
    const vByte = Number(sig.v ?? BigInt(27 + sig.yParity));
    return { value, deadline, nonce, v: vByte, r: sig.r, s: sig.s, proof: v.encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [value, deadline, vByte, sig.r, sig.s]) };
  };
  const increaseTime = async s => { await rpc('evm_increaseTime', [Number(s)]); await rpc('evm_mine'); };

  // ================================================================ authorizations
  const GROSS = 5n * USDG_UNIT;
  const limits = await limitsFromQuotes(BAG1, GROSS, 300);
  report.priceLimitPolicy = { kind: 'OWNER_SIGNED_MAX_PRICE', thisRun: 'TEST LIMIT = best real-chain QuoterV2 quote at setup + 300 bps (A/B/C) or + 100 bps (P)', isIndependentReference: false,
    limitsRaw: limits, sources: limitSources, note: 'The executor enforces the limit the owner signed. Choosing it from the same AMM is a test convenience, not a fair-price proof.' };
  const startA = await now();
  const authA = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 3, totalBudgetRaw: 3n * GROSS, startsAt: startA, periodSeconds: DAY, expiresAt: startA + 5n * DAY, maxPriceRaw: limits, nonce: 1n });
  const authB = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 3, totalBudgetRaw: 3n * GROSS, startsAt: startA, periodSeconds: DAY, maxPriceRaw: limits, nonce: 2n });
  const authC = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 3, totalBudgetRaw: 3n * GROSS, startsAt: startA, periodSeconds: DAY, maxPriceRaw: limits, nonce: 3n });
  const [sigA, sigB, sigC] = [await ownerSign(authA), await ownerSign(authB), await ownerSign(authC)];
  const idA = sdk.recurringAuthorizationId(authA, DEP), idB = sdk.recurringAuthorizationId(authB, DEP), idC = sdk.recurringAuthorizationId(authC, DEP);
  report.authorizations = { A: { id: idA, summary: sdk.summarizeRecurringAuthorization(authA), onChainIdMatchesSdk: (await read(EXECUTOR, EXEC_ABI, 'authorizationIdOf', [authA])) === idA }, B: { id: idB }, C: { id: idC } };
  const ownerUsdgStart = await bal(USDG, roles.owner);

  // ================================================================ day 0
  const permitA = await permitSig(authA.schedule.totalBudget, startA + 3600n);
  await scenario('L1-permit-first-run', { gate: 'LIFECYCLE', kind: 'LIFECYCLE', expected: 'run 1 of A; EIP-2612 permit for exactly the total budget is consumed inside execute (real USDG)' },
    () => honest(authA, sigA, { fundingProof: permitA.proof, expectedAllowanceAfter: authA.schedule.totalBudget - GROSS }));
  await scenario('F1-same-window-again', { gate: 'SCHEDULE', kind: 'REAL_FAULT', expected: 'NotDue; nothing changes' }, async () => { const run = await buildRun(authA); return refused(authA, xOf(run, await signPlan(run.plan)), sigA, 'NotDue'); });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, authB.schedule.totalBudget]);
  await scenario('L2-approve-first-run-B', { gate: 'LIFECYCLE', kind: 'LIFECYCLE', expected: 'run 1 of B with a standard approve (no permit)' }, () => honest(authB, sigB));
  // B: an unused permit is kept, then B is revoked and the allowance reset; the permit is submitted by a third party later.
  const leftoverPermit = await permitSig(authB.schedule.totalBudget, startA + 30n * DAY);
  await scenario('V1-revoke-B', { gate: 'REVOCATION', kind: 'LIFECYCLE', expected: 'owner revoke(idB) on chain; allowance untouched by revoke' }, async () => {
    const before = await read(USDG, erc20, 'allowance', [roles.owner, EXECUTOR]);
    await send(W.owner, EXECUTOR, EXEC_ABI, 'revoke', [idB]);
    const st = await read(EXECUTOR, EXEC_ABI, 'getState', [roles.owner, idB]);
    const after = await read(USDG, erc20, 'allowance', [roles.owner, EXECUTOR]);
    return { pass: st.revoked && after === before, observed: `revoked=${st.revoked}, allowance ${before} → ${after} (revoke does not reset allowance)` };
  });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 0n]);
  await scenario('V2-revoked-B-with-restored-allowance', { gate: 'REVOCATION', kind: 'REAL_FAULT', expected: 'after revoke and approve(0), a third party submits B\'s unused permit (allowance restored); execute → RevokedAuthorization' }, async () => {
    await send(W.attacker, USDG, erc20, 'permit', [roles.owner, EXECUTOR, leftoverPermit.value, leftoverPermit.deadline, leftoverPermit.v, leftoverPermit.r, leftoverPermit.s]);
    const allowance = await read(USDG, erc20, 'allowance', [roles.owner, EXECUTOR]);
    const run = await buildRun(authB);
    const r = await refused(authB, xOf(run, await signPlan(run.plan)), sigB, 'RevokedAuthorization');
    return { ...r, allowanceWhenRefused: allowance, pass: r.pass && allowance === authB.schedule.totalBudget };
  });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 0n]);
  // C: permit is front-run by a third party before the keeper's execute (signed after B's leftover permit was used: sequential nonces).
  const permitC = await permitSig(authC.schedule.totalBudget, startA + 3600n);
  await scenario('U1-permit-front-run-C', { gate: 'FUNDING', kind: 'REAL_FAULT', expected: 'a third party submits the permit first; execute still succeeds (the try/catch only skips the used nonce)' }, async () => {
    await send(W.attacker, USDG, erc20, 'permit', [roles.owner, EXECUTOR, permitC.value, permitC.deadline, permitC.v, permitC.r, permitC.s]);
    return honest(authC, sigC, { fundingProof: permitC.proof, expectedAllowanceAfter: authC.schedule.totalBudget - GROSS });
  });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 0n]); // C: allowance reset (NOT a revocation)

  // ================================================================ day 1
  await increaseTime(DAY);
  // A compromised planSigner (and router owner) against A, which is due: every widened plan is signed by the REAL planSigner key.
  // One USDG allowance per (owner, executor) is shared by ALL of the owner's authorizations; per-authorization limits are the executor's counters.
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 2n * GROSS]); // A's two remaining runs, so every refusal below is the plan's fault, not funding
  await send(W.routerOwner, router, ROUTER_ABI, 'setAllowedTarget', [UNIVERSAL_ROUTER, true]); // malicious router owner widens the router allowlist
  const swapAbi = uni.SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI;
  const decodeLeg = l => v.decodeFunctionData({ abi: swapAbi, data: l.callData }).args[0];
  const encodeLeg = p => v.encodeFunctionData({ abi: swapAbi, functionName: 'exactInputSingle', args: [p] });
  const widen = async (label, expected, expectName, mutate, extra = {}) => scenario(label, { gate: 'PLAN_SIGNER_TRUST', kind: 'REAL_FAULT', expected }, async () => {
    const run = await buildRun(authA);
    const plan = structuredClone(run.plan);
    const xo = mutate(plan, run) ?? {};
    return refused(xo.auth ?? authA, xOf({ ...run, plan }, await signPlan(plan), xo.x ?? {}), xo.sig ?? sigA, expectName, extra);
  });
  await widen('P1-recipient-to-attacker', 'leg output sent to the attacker instead of the router → RouteViolation(0,6)', 'RouteViolation', p => { const q = decodeLeg(p.legs[0]); p.legs[0].callData = encodeLeg({ ...q, recipient: roles.attacker }); }, { expectArgs: [0, 6] });
  await widen('P2-min-below-owner-limit', 'leg 1 minimum set to 1 (calldata and router check) → RouteViolation(1,11)', 'RouteViolation', p => { const q = decodeLeg(p.legs[1]); p.legs[1].callData = encodeLeg({ ...q, amountOutMinimum: 1n }); p.minOutputs[1].minAmountOut = 1n; }, { expectArgs: [1, 11] });
  await widen('P3-spend-more', 'inputAmount doubled → PlanMismatch(3)', 'PlanMismatch', p => { p.inputAmount *= 2n; }, { expectArgs: [3] });
  await widen('P4-other-bag', 'plan for another bagId → PlanMismatch(4)', 'PlanMismatch', p => { p.bagId = id2.bagId; }, { expectArgs: [4] });
  await widen('P5-other-target', 'leg 0 sent to UniversalRouter (allowlisted by the malicious router owner) → RouteViolation(0,1)', 'RouteViolation', p => { p.legs[0].target = UNIVERSAL_ROUTER; }, { expectArgs: [0, 1] });
  await widen('P6-other-token', 'leg 2 buys USDG→GME instead of COIN → RouteViolation(2,5)', 'RouteViolation', p => { const q = decodeLeg(p.legs[2]); p.legs[2].callData = encodeLeg({ ...q, tokenOut: authA.assets[0].asset }); }, { expectArgs: [2, 5] });
  await widen('P7-price-limit-partial-fill', 'sqrtPriceLimitX96 set on leg 0 (partial fill) → RouteViolation(0,8)', 'RouteViolation', p => { const q = decodeLeg(p.legs[0]); p.legs[0].callData = encodeLeg({ ...q, sqrtPriceLimitX96: 1n }); }, { expectArgs: [0, 8] });
  await widen('P8-shift-leg-amounts', 'leg 0 +1 raw, leg 1 −1 raw (same total) → RouteViolation(0,3)', 'RouteViolation', p => { p.legs[0].approveAmount += 1n; p.legs[1].approveAmount -= 1n; }, { expectArgs: [0, 3] });
  await widen('P9-wrong-window', 'execution claims window 2 while window 1 is current → WrongWindow', 'WrongWindow', () => ({ x: { window: 2n } }));
  await widen('P10-stale-quote', 'quoteDeadline in the past → QuoteExpired', 'QuoteExpired', (_p, run) => ({ x: { quoteDeadline: run.execution.quoteDeadline - 3600n } }));
  await scenario('P11-forged-owner-signature', { gate: 'PLAN_SIGNER_TRUST', kind: 'REAL_FAULT', expected: 'authorization signature from another key → InvalidOwnerSignature' }, async () => {
    const run = await buildRun(authA);
    return refused(authA, xOf(run, await signPlan(run.plan)), await keys.attacker.signTypedData(sdk.recurringAuthorizationTypedData(authA, DEP)), 'InvalidOwnerSignature');
  });
  await scenario('P12-terms-swapped-recipient', { gate: 'PLAN_SIGNER_TRUST', kind: 'REAL_FAULT', expected: 'keeper swaps the recipient in the terms, keeps the owner signature and id → AuthorizationMismatch' }, async () => {
    const run = await buildRun(authA);
    return refused({ ...authA, recipient: roles.attacker.toLowerCase() }, xOf(run, await signPlan(run.plan)), sigA, 'AuthorizationMismatch');
  });
  await send(W.routerOwner, router, ROUTER_ABI, 'setAllowedTarget', [UNIVERSAL_ROUTER, false]);
  await scenario('L3-second-run-same-window-after-attacks', { gate: 'LIFECYCLE', kind: 'LIFECYCLE', expected: 'run 2 of A in window 1: the refusals above did not consume the window' }, () => honest(authA, sigA));
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 0n]);
  await scenario('V3-allowance-reset-is-not-revocation', { gate: 'REVOCATION', kind: 'REAL_FAULT', expected: 'C has allowance 0 (approve(0) on day 0) → the transfer fails; C is NOT revoked' }, async () => {
    const run = await buildRun(authC);
    const r = await refused(authC, xOf(run, await signPlan(run.plan)), sigC, null);
    const st = await read(EXECUTOR, EXEC_ABI, 'getState', [roles.owner, idC]);
    return { ...r, pass: r.pass && !st.revoked, revoked: st.revoked, note: 'the token\'s own allowance error; C stays valid (see L4)' };
  });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, GROSS]);
  await scenario('L4-C-after-reapprove', { gate: 'LIFECYCLE', kind: 'LIFECYCLE', expected: 'C runs again after the owner re-approves one run' }, () => honest(authC, sigC, { expectedAllowanceAfter: 0n }));
  await scenario('V4-revokeBySig-C', { gate: 'REVOCATION', kind: 'LIFECYCLE', expected: 'owner signs Revocation off chain; a third party submits revokeBySig' }, async () => {
    const sig = await keys.owner.signTypedData(sdk.recurringRevocationTypedData(roles.owner, idC, DEP));
    await send(W.relayer, EXECUTOR, EXEC_ABI, 'revokeBySig', [roles.owner, idC, sig]);
    const st = await read(EXECUTOR, EXEC_ABI, 'getState', [roles.owner, idC]);
    return { pass: st.revoked, observed: `revoked=${st.revoked} (submitted by ${roles.relayer})` };
  });

  // ================================================================ day 2, 3, 5
  await increaseTime(DAY);
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, GROSS * 10n]);
  await scenario('V5-revoked-C', { gate: 'REVOCATION', kind: 'REAL_FAULT', expected: 'C has allowance again but is revoked → RevokedAuthorization' }, async () => { const run = await buildRun(authC); return refused(authC, xOf(run, await signPlan(run.plan)), sigC, 'RevokedAuthorization'); });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, GROSS]); // A: exactly its last run (permit allowance was 15, two runs used it; approve overrides)
  await scenario('L5-third-run-A', { gate: 'LIFECYCLE', kind: 'LIFECYCLE', expected: 'run 3 of A (last), window 2' }, () => honest(authA, sigA, { expectedAllowanceAfter: 0n }));
  await increaseTime(DAY);
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, GROSS * 10n]);
  await scenario('F2-exhausted', { gate: 'SCHEDULE', kind: 'REAL_FAULT', expected: 'A after 3 of 3 runs, allowance available → Exhausted' }, async () => { const run = await buildRun(authA); return refused(authA, xOf(run, await signPlan(run.plan)), sigA, 'Exhausted'); });
  await increaseTime(2n * DAY);
  await scenario('F3-expired', { gate: 'SCHEDULE', kind: 'REAL_FAULT', expected: 'A at/after expiresAt → Expired (the SDK refuses to build first; the plan is built for the last valid second)' }, async () => {
    let sdkRefusal = null;
    try { await buildRun(authA); } catch (e) { sdkRefusal = e.code; }
    const run = await buildRun(authA, { nowSeconds: authA.schedule.expiresAt - 1n });
    const r = await refused(authA, xOf(run, await signPlan(run.plan), { quoteDeadline: (await now()) + 300n }), sigA, 'Expired');
    return { ...r, sdkRefusal, pass: r.pass && sdkRefusal === 'RECURRING_TERMS_INVALID' };
  });
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 0n]);
  const ownerUsdgEnd = await bal(USDG, roles.owner);
  const honestRuns = scenarios.filter(s => s.purchase && s.pass).length;
  report.fundsStayInOwnerAddress = { mode: 'ALLOWANCE', ownerAddress: roles.owner, ownerUsdgStart, ownerUsdgEnd, spentRaw: ownerUsdgStart - ownerUsdgEnd, honestRuns, expectedSpentRaw: BigInt(honestRuns) * GROSS,
    pass: ownerUsdgStart - ownerUsdgEnd === BigInt(honestRuns) * GROSS,
    note: 'USDG stayed in the owner EOA except the exact per-run debits; the executor and router held nothing between runs (checked after every run). Trust that remains: the immutable executor is the spender of the remaining allowance, shared by all of the owner\'s authorizations.' };

  // ================================================================ registry (real BagFactory, Bag, StrategyRegistry)
  const RAW_LIMITS = await limitsFromQuotes(BAG2, GROSS, 300);
  let regNow = await now();
  await scenario('R0-sdk-refuses-fee-bearing-bag', { gate: 'FEE_SCOPE', kind: 'SDK_REFUSAL', expected: 'a3caff05 declares performanceFeeBps 1000: the SDK refuses to build an authorization (fee-bearing BAGs are outside the first scope)' }, async () => {
    try { sdk.buildRecurringAuthorization({ ...terms(BAG2, id2), amountPerRunRaw: GROSS, runs: 1, totalBudgetRaw: GROSS, startsAt: regNow, periodSeconds: DAY, maxPriceRaw: RAW_LIMITS, nonce: 10n }); return { pass: false, observed: 'built' }; }
    catch (e) { return { pass: e.code === 'RECURRING_TERMS_INVALID' && /performance fee/.test(e.message), observed: `${e.code}: ${e.message}` }; }
  });
  /** A BAG's registered rows (registered order, with symbols) as signed asset limits. */
  const listOf = (doc, lim) => sdk.recurringRegisteredAssets(doc).map(r => ({ asset: r.asset, symbol: r.symbol, weightBps: r.weightBps, decimals: r.decimals, maxPriceRaw: lim[r.asset] ?? 10n ** 12n }));
  /** The SDK refuses a3caff05 (fee), so its authorization is assembled by hand here, ONLY to exercise the executor's on-chain
   *  registry checks; the executor cannot see a fee (the definition is not on chain). Same field set the SDK produces. */
  const rawAuth = (doc, idn, over = {}) => {
    const base = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 1, totalBudgetRaw: GROSS, startsAt: regNow, periodSeconds: DAY, maxPriceRaw: limits, nonce: 10n });
    return { ...base, bag: { bagId: idn.bagId, bagVersion: idn.version, compositionHash: idn.compositionHash, definitionHash: idn.definitionHash, strategyId: idn.registered ? idn.strategyId : v.zeroHash, strategyVersion: idn.registered ? doc.ref.version : 0 },
      assets: listOf(doc, RAW_LIMITS), ...over };
  };
  const regTerms = (over, doc = BAG2, idn = id2) => (doc === BAG2 ? rawAuth(doc, idn, over)
    : sdk.buildRecurringAuthorization({ ...terms(doc, idn), amountPerRunRaw: GROSS, runs: 1, totalBudgetRaw: GROSS, startsAt: regNow, periodSeconds: DAY, maxPriceRaw: limits, nonce: 10n, ...over }));
  const emptyX = (auth, quoteDeadline) => ({ authorizationId: sdk.recurringAuthorizationId(auth, DEP), window: 0n, quoteDeadline,
    plan: { bagId: auth.bag.bagId, executionPlanHash: v.zeroHash, wallet: EXECUTOR, inputToken: USDG, inputAmount: auth.schedule.grossAmountPerRun, deadline: quoteDeadline, legs: [], minOutputs: [] }, planSignature: '0x' });
  const registryCase = (label, expected, expectName, mk, expectArgs) => scenario(label, { gate: 'BAG_REGISTRY', kind: 'REAL_FAULT', expected }, async () => {
    regNow = await now();
    const auth = mk();
    return refused(auth, emptyX(auth, regNow + 300n), await ownerSign(auth), expectName, { expectArgs });
  });
  await registryCase('R1-a3caff05-signed-for-v1', `authorization for a3caff05 version 1 (BagFactory history, block ${A3_V1.block}); the creator recorded v2 → BagChanged(2, current hash)`, 'BagChanged',
    () => { const a = regTerms({}); a.bag = { ...a.bag, bagVersion: A3_V1.version, compositionHash: A3_V1.compositionHash, strategyVersion: 1 }; return a; }, [2n, id2.compositionHash]);
  await registryCase('R2-a3caff05-v2-registry-passes', 'a3caff05 v2 with the registered strategyId and definitionHash: BagFactory and StrategyRegistry checks pass; the call stops at the plan check → PlanMismatch(5)', 'PlanMismatch', () => regTerms({}), [5n]);
  await registryCase('R3-a3caff05-wrong-definition', 'a3caff05 v2 with another definitionHash → StrategyNotRegistered', 'StrategyNotRegistered', () => { const a = regTerms({}); a.bag = { ...a.bag, definitionHash: id1.definitionHash }; return a; });
  await registryCase('R4-unknown-bag', 'bagId not in BagFactory → UnknownBag', 'UnknownBag', () => { const a = regTerms({}); a.bag = { ...a.bag, bagId: v.keccak256(v.toHex('not a bag')) }; return a; });
  await registryCase('R5-955df6e0-wrong-composition', '955df6e0 with a3caff05\'s composition hash → BagChanged(1, real hash)', 'BagChanged', () => { const a = regTerms({}, BAG1, id1); a.bag = { ...a.bag, compositionHash: id2.compositionHash }; return a; }, [1n, id1.compositionHash]);
  // The signed list must BE the Bag's registered content: the real id, version and composition hash of 955df6e0 with another list.
  const listA3 = listOf(BAG2, RAW_LIMITS);
  const swapped = (() => { const l = listOf(BAG1, limits).map(a => ({ ...a })); const w = l[0].weightBps; l[0].weightBps = l[1].weightBps; l[1].weightBps = w; return l; })();
  await registryCase('R7-955df6e0-with-a3caff05-list', '955df6e0 id, version and its REAL composition hash, signed with a3caff05\'s asset list (the SDK refuses to build this) → CompositionMismatch(signed list, registered)', 'CompositionMismatch',
    () => { const a = regTerms({}, BAG1, id1); a.assets = listA3; return a; }, [sdk.recurringCompositionHash(CHAIN_LABEL, listA3), id1.compositionHash]);
  await registryCase('R8-955df6e0-weights-swapped', '955df6e0 with its own tokens but two weights swapped (same total) → CompositionMismatch', 'CompositionMismatch',
    () => { const a = regTerms({}, BAG1, id1); a.assets = swapped; return a; }, [sdk.recurringCompositionHash(CHAIN_LABEL, swapped), id1.compositionHash]);
  await scenario('R9-sdk-refuses-other-list', { gate: 'BAG_REGISTRY', kind: 'SDK_REFUSAL', expected: 'the SDK refuses before signing when the bag.json assets do not reproduce the registered composition: (a) 955df6e0\'s document with a3caff05\'s registered hash, (b) 955df6e0 with one symbol changed in its metadata' }, async () => {
    const attempt = (doc, registry) => { try { sdk.buildRecurringAuthorization({ ...terms(doc, id1), registry, amountPerRunRaw: GROSS, runs: 1, totalBudgetRaw: GROSS, startsAt: regNow, periodSeconds: DAY, maxPriceRaw: limits, nonce: 11n }); return 'BUILT'; } catch (e) { return `${e.code}: ${e.message}`; } };
    regNow = await now();
    const own = terms(BAG1, id1).registry;
    const a = attempt(BAG1, { ...own, compositionHash: id2.compositionHash });
    const renamed = structuredClone(BAG1); renamed.metadata.assets[0].symbol += 'X';
    const b = attempt(renamed, own);
    const ok = x => /^RECURRING_TERMS_INVALID: .*compositionHash/.test(x);
    return { pass: ok(a) && ok(b), observed: `(a) ${a} | (b) ${b}` };
  });
  await registryCase('R6-955df6e0-claims-registered', '955df6e0 is not in StrategyRegistry; naming its derived strategyId → StrategyNotRegistered', 'StrategyNotRegistered', () => { const a = regTerms({}, BAG1, id1); a.bag = { ...a.bag, strategyId: id1.strategyId, strategyVersion: 1 }; return a; });

  // ================================================================ route scope
  await scenario('S1-a3caff05-no-v3-route', { gate: 'ROUTE_SCOPE', kind: 'SDK_REFUSAL', expected: 'a3caff05 v2 cannot be bought with v3 exactInputSingle: some asset has no USDG pool at any allowed tier → NO_ROUTE' }, async () => {
    regNow = await now();
    const auth = regTerms({});
    try { await buildRun(auth); return { pass: false, observed: 'built a plan' }; }
    catch (e) { return { pass: e.code === 'NO_ROUTE', observed: `${e.code}: ${redact(e.message)}` }; }
  });

  // ================================================================ price limit against a moved market
  // Isolated: the attacker's swaps are undone (evm_revert) after M4, so later phases see the unmoved market.
  const beforeMove = await F.edit('SNAPSHOT', 'evm_snapshot', [], 'isolate the price-move scenarios (reverted after M4)');
  const startP = await now();
  const limitsP = await limitsFromQuotes(BAG1, GROSS, 100);
  const authP = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 2, totalBudgetRaw: 2n * GROSS, startsAt: startP, periodSeconds: DAY, maxPriceRaw: limitsP, nonce: 20n });
  const sigP = await ownerSign(authP);
  await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, authP.schedule.totalBudget]);
  const coin = authP.assets.find(a => (BAG1.metadata?.assets ?? []).find(m => m.address.toLowerCase() === a.asset && m.symbol === 'COIN'))?.asset ?? authP.assets[2].asset;
  const coinIdx = authP.assets.findIndex(a => a.asset === coin);
  const planBeforeMove = await buildRun(authP, { quoteTtlSeconds: 3600n });
  const planBeforeMoveSig = await signPlan(planBeforeMove.plan);
  // A market move after the quote: the attacker buys COIN with USDG in the leg's pool until the best quote breaks the owner's limit.
  const move = { asset: coin, fee: planBeforeMove.legs[coinIdx].fee, usdgSpentRaw: 0n, steps: 0 };
  await send(W.attacker, USDG, erc20, 'approve', [SWAP_ROUTER02, 50_000n * USDG_UNIT]);
  for (; move.steps < 40; move.steps++) {
    try { await buildRun(authP); } catch (e) { if (e.code === 'PRICE_LIMIT_NOT_MET') break; throw e; }
    const chunk = 1_000n * USDG_UNIT;
    await send(W.attacker, SWAP_ROUTER02, swapAbi, 'exactInputSingle', [{ tokenIn: USDG, tokenOut: coin, fee: move.fee, recipient: roles.attacker, amountIn: chunk, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }], 1_500_000n);
    move.usdgSpentRaw += chunk;
  }
  report.priceMove = move;
  await scenario('M1-pre-move-plan-after-move', { gate: 'PRICE_POLICY', kind: 'REAL_FAULT', expected: 'the plan quoted before the move, honestly signed, is submitted after it: the swap cannot meet the minimum → reverted, nothing changes' }, async () => {
    const stillValid = (await now()) < planBeforeMove.plan.deadline;
    const r = await refused(authP, xOf(planBeforeMove, planBeforeMoveSig), sigP, ['Error', 'InsufficientOutput', 'LegCallFailed', 'OutputBelowLimit']);
    return { ...r, planDeadlineStillValid: stillValid, pass: r.pass && stillValid };
  });
  await scenario('M2-sdk-refuses-after-move', { gate: 'PRICE_POLICY', kind: 'SDK_REFUSAL', expected: 'fresh quotes are below the owner limit → PRICE_LIMIT_NOT_MET, no plan' }, async () => {
    try { await buildRun(authP); return { pass: false, observed: 'built a plan' }; } catch (e) { return { pass: e.code === 'PRICE_LIMIT_NOT_MET', observed: `${e.code}: ${redact(e.message)}` }; }
  });
  await scenario('M3-planSigner-accepts-market', { gate: 'PRICE_POLICY', kind: 'REAL_FAULT', expected: 'planSigner signs the post-move market price as the COIN minimum (below the owner limit) → RouteViolation(coin,11)' }, async () => {
    const run = await buildRun(authP, { slippageBps: 0 }).catch(() => null);
    const base = run ?? planBeforeMove;
    const plan = structuredClone(base.plan);
    const q = await client.simulateContract({ address: QUOTER_V2, abi: uni.UNISWAP_V3_QUOTER_V2_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDG, tokenOut: coin, amountIn: planBeforeMove.legs[coinIdx].amountInRaw, fee: move.fee, sqrtPriceLimitX96: 0n }] });
    const market = q.result[0];
    const leg = decodeLeg(plan.legs[coinIdx]); plan.legs[coinIdx].callData = encodeLeg({ ...leg, amountOutMinimum: market }); plan.minOutputs[coinIdx].minAmountOut = market;
    const r = await refused(authP, xOf({ ...base, plan }, await signPlan(plan)), sigP, 'RouteViolation', { expectArgs: [coinIdx, 11] });
    return { ...r, marketOutRaw: market, ownerFloorRaw: planBeforeMove.legs[coinIdx].priceLimitFloorRaw };
  });
  await scenario('M4-calldata-min-zero', { gate: 'PRICE_POLICY', kind: 'REAL_FAULT', expected: 'planSigner keeps the router minimum at the owner floor but sets calldata amountOutMinimum = 0: the swap executes at the moved price and the measured-output check reverts it' }, async () => {
    const plan = structuredClone(planBeforeMove.plan);
    const leg = decodeLeg(plan.legs[coinIdx]); plan.legs[coinIdx].callData = encodeLeg({ ...leg, amountOutMinimum: 0n }); plan.minOutputs[coinIdx].minAmountOut = planBeforeMove.legs[coinIdx].priceLimitFloorRaw;
    return refused(authP, xOf({ ...planBeforeMove, plan }, await signPlan(plan)), sigP, ['InsufficientOutput', 'OutputBelowLimit']);
  });

  await F.edit('REVERT', 'evm_revert', [beforeMove], 'undo the attacker swaps of the price-move scenarios');
  // ================================================================ verifier fed altered expectations (mined transaction, wrong expectation)
  const goodTx = scenarios.find(s => s.id === 'L1-permit-first-run').tx;
  const goodIntent = intents.get(goodTx);
  const otherIntent = intents.get(scenarios.find(s => s.id === 'L3-second-run-same-window-after-attacks').tx);
  const revertedTx = scenarios.find(s => s.id === 'F1-same-window-again').tx;
  const altered = (label, expected, variants) => scenario(label, { gate: 'RECEIPT_VERIFIER', kind: 'ALTERED_EXPECTATION', expected }, async () => {
    const results = [];
    for (const vr of variants) {
      const r = await sdk.verifyRecurringPurchase({ client: evidence, transactionHash: goodTx, auth: authA, deployment: DEP, ...vr.params });
      const codes = [...new Set(r.issues.map(i => i.code))];
      results.push({ variant: vr.label, status: r.status, binding: r.transactionBinding, evidence: r.evidence, codes, pass: r.status === (vr.status ?? 'FAILED') && (!vr.code || codes.includes(vr.code)) && (!vr.evidence || r.evidence === vr.evidence) });
    }
    return { pass: results.every(r => r.pass), results, observed: results.map(r => `${r.variant}: ${r.status}${r.codes.length ? ' ' + r.codes.join(',') : ''}`).join(' | ') };
  });
  const both = (params, code) => [{ label: 'prepared call', params: { ...params, intent: goodIntent }, code }, { label: 'decoded call', params, code: params.deployment ? 'NOT_EXECUTOR_TX' : code }];
  await altered('E0-baseline', 'the good L1 transaction: VERIFIED with the prepared call and with the decoded call; event-only mode is VERIFIED but labelled TRANSACTION_AND_TRANSFER_LOGS', [
    { label: 'prepared call', params: { intent: goodIntent }, status: 'VERIFIED', evidence: 'TRANSACTION_AND_BALANCE_DELTAS' },
    { label: 'decoded call', params: {}, status: 'VERIFIED', evidence: 'TRANSACTION_AND_BALANCE_DELTAS' },
    { label: 'event-only', params: { intent: goodIntent, verification: 'TRANSFER_LOGS' }, status: 'VERIFIED', evidence: 'TRANSACTION_AND_TRANSFER_LOGS' }]);
  await altered('E1-other-recipient', 'expect another recipient (another authorization id) → AUTHORIZATION_MISMATCH', both({ auth: { ...authA, recipient: roles.attacker.toLowerCase() } }, 'AUTHORIZATION_MISMATCH'));
  await altered('E2-other-amount', 'expect 6 USDG per run → AUTHORIZATION_MISMATCH', both({ auth: { ...authA, schedule: { ...authA.schedule, grossAmountPerRun: 6n * USDG_UNIT } } }, 'AUTHORIZATION_MISMATCH'));
  await altered('E3-other-executor', 'expect another executor address → AUTHORIZATION_MISMATCH (prepared) / NOT_EXECUTOR_TX (decoded)', both({ deployment: { ...DEP, executor: roles.attacker.toLowerCase() } }, 'AUTHORIZATION_MISMATCH'));
  await altered('E4-tighter-limits', 'expect limits 10× tighter → AUTHORIZATION_MISMATCH', both({ auth: { ...authA, assets: authA.assets.map(a => ({ ...a, maxPriceRaw: a.maxPriceRaw / 10n })) } }, 'AUTHORIZATION_MISMATCH'));
  await altered('E5-other-prepared-call', 'same authorization, but the call prepared for another run (L3), or the L1 call without its permit proof → CALL_MISMATCH', [
    { label: 'L3 intent', params: { intent: otherIntent }, code: 'CALL_MISMATCH' },
    { label: 'permit proof dropped', params: { intent: { ...goodIntent, fundingProof: '0x' } }, code: 'CALL_MISMATCH' }]);
  await altered('E6-mined-revert', 'F1\'s mined, reverted execute for A → FAILED TRANSACTION_REVERTED (nothing bought)', [{ label: 'decoded call', params: { transactionHash: revertedTx }, code: 'TRANSACTION_REVERTED' }]);

  // ================================================================ evidence scope: the single-transaction-block reader on a busy block
  await scenario('B1-busy-block', { gate: 'RECEIPT_VERIFIER', kind: 'EVIDENCE_SCOPE', expected: 'an honest purchase mined in the same block as another transaction: the SINGLE_TRANSACTION_BLOCK reader cannot isolate it → INDETERMINATE (BALANCE_EVIDENCE_UNAVAILABLE), never VERIFIED; event-only verification of the same transaction is VERIFIED and labelled TRANSACTION_AND_TRANSFER_LOGS' }, async () => {
    const authQ = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 1, totalBudgetRaw: GROSS, startsAt: await now(), periodSeconds: DAY, maxPriceRaw: limits, nonce: 40n });
    const sigQ = await ownerSign(authQ);
    await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, GROSS]);
    const run = await buildRun(authQ);
    const x = xOf(run, await signPlan(run.plan));
    let hash, other;
    await rpc('evm_setAutomine', [false]);
    try {
      hash = await W.keeper.writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: 'execute', args: [authQ, x, sigQ, '0x'], gas: 8_000_000n });
      other = await W.attacker.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [roles.relayer, 1n], gas: 100_000n });
      await rpc('evm_mine');
    } finally { await rpc('evm_setAutomine', [true]); }
    const [r1, r2] = [await client.getTransactionReceipt({ hash }), await client.getTransactionReceipt({ hash: other })];
    const intent = { execution: x, ownerSignature: sigQ, fundingProof: '0x' };
    const strict = await sdk.verifyRecurringPurchase({ client: evidence, transactionHash: hash, auth: authQ, deployment: DEP, intent });
    const logs = await sdk.verifyRecurringPurchase({ client: evidence, transactionHash: hash, auth: authQ, deployment: DEP, intent, verification: 'TRANSFER_LOGS' });
    await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 0n]);
    const sameBlock = r1.blockHash === r2.blockHash;
    return { pass: r1.status === 'success' && sameBlock && strict.status === 'INDETERMINATE' && strict.issues.some(i => i.code === 'BALANCE_EVIDENCE_UNAVAILABLE') && logs.status === 'VERIFIED' && logs.evidence === 'TRANSACTION_AND_TRANSFER_LOGS',
      tx: hash, observed: `purchase ${r1.status}, same block as another tx: ${sameBlock}; balance mode ${strict.status} (${strict.issues.map(i => i.code).join(',')}); event-only ${logs.status} (${logs.evidence})` };
  });

  // ================================================================ persistent keeper (app lib/dca/keeper) on the same fork
  // Needs a TypeScript loader for the app's keeper modules: run this file with the pinned tsx (start command in RESULTS).
  let keeperLib;
  try {
    keeperLib = { ...(await import(pathToFileURL(join(app, 'lib/dca/keeper/keeper.ts')).href)), ...(await import(pathToFileURL(join(app, 'lib/dca/keeper/chain.ts')).href)), ...(await import(pathToFileURL(join(app, 'lib/dca/keeper/store.ts')).href)) };
  } catch (e) { report.keeperPhase = { status: 'NOT_RUN', reason: 'the keeper is TypeScript; run with the pinned tsx: ' + redact(e?.code ?? e?.message) }; }
  if (keeperLib) {
    const { RecurringKeeper, createViemKeeperChain, FileKeeperStore, MemoryKeeperStore } = keeperLib;
    const appRequire = createRequire(join(app, 'package.json'));
    const av = appRequire('viem'), aacc = appRequire('viem/accounts');
    const achain = av.defineChain({ id: CHAIN_ID, name: 'ISOLATED Robinhood fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
    const atransport = av.custom({ request: ({ method, params }) => rpc(method, params ?? []) });
    const apc = av.createPublicClient({ chain: achain, transport: atransport, pollingInterval: 50, cacheTime: 0 });
    const pkA = accounts.generatePrivateKey(), pkB = accounts.generatePrivateKey();
    const kA = aacc.privateKeyToAccount(pkA), kB = aacc.privateKeyToAccount(pkB);
    for (const a of [kA.address, kB.address]) await F.edit('GAS', 'hardhat_setBalance', [a, v.toHex(v.parseEther('10'))], 'fork-only gas for a keeper test account');
    const chainOf = acct => createViemKeeperChain({ publicClient: apc, walletClient: av.createWalletClient({ account: acct, chain: achain, transport: atransport }) });
    const signPlanK = (plan, r) => keys.planSigner.signTypedData(uni.routerPlanTypedData(plan, { chainId: CHAIN_ID, router: r }));
    // The store holds the owner's authorization signature: it stays in the git-ignored cache; a redacted copy is shared.
    const storePath = join(out, 'cache', 'keeper-store.json');
    const mk = (store, chain, holder = 'keeper-a') => new RecurringKeeper({ store, chain, signPlan: signPlanK, quoter: QUOTER_V2, holder, pendingTimeoutMs: 600_000 });
    const nonceOf = a => client.getTransactionCount({ address: a });
    const K_RUNS = 4;
    const startK = await now();
    const authK = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: K_RUNS, totalBudgetRaw: BigInt(K_RUNS) * GROSS, startsAt: startK, periodSeconds: DAY, maxPriceRaw: await limitsFromQuotes(BAG1, GROSS, 300), nonce: 30n });
    const sigK = await ownerSign(authK);
    const depK = { ...DEP, router: router.toLowerCase() };
    await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, BigInt(K_RUNS) * GROSS]);
    const idK = sdk.recurringAuthorizationId(authK, DEP);
    const chainState = () => read(EXECUTOR, EXEC_ABI, 'getState', [roles.owner, idK]);
    const ownerStart = await bal(USDG, roles.owner);
    const kscenario = (id, expected, fn) => scenario(id, { gate: 'KEEPER', kind: 'KEEPER_FORK', expected }, fn);
    const chainA = chainOf(kA);
    await kscenario('K1-first-run', 'keeper A (file store) adds the signed authorization and buys window 0; the SDK verifies the real receipt', async () => {
      const k = mk(new FileKeeperStore(storePath), chainA);
      await k.addJob({ authorization: authK, ownerSignature: sigK, deployment: depK });
      const [a] = await k.tick(); const [b] = await k.tick();
      const c = b.confirmed[0];
      return { pass: a.state === 'PENDING_TX' && b.state === 'DONE_THIS_WINDOW' && b.confirmed.length === 1 && c.verification === 'VERIFIED' && c.binding === 'PREPARED_INTENT' && c.evidence === 'TRANSACTION_AND_BALANCE_DELTAS' && b.pending === null,
        observed: `${a.state} → ${b.state}, ${c?.verification} (${c?.binding}, ${c?.balanceScope}) ${c?.hash}`, tx: c?.hash };
    });
    await kscenario('K2-restart-same-store', 'a new keeper process on the same file store in the same window: nothing is sent', async () => {
      const n = await nonceOf(kA.address);
      const [j] = await mk(new FileKeeperStore(storePath), chainA).tick();
      const st = await chainState();
      return { pass: j.state === 'DONE_THIS_WINDOW' && (await nonceOf(kA.address)) === n && Number(st.executions) === 1, observed: `${j.state}, nonce unchanged, chain executions ${st.executions}` };
    });
    await kscenario('K3-lost-store', 'a keeper with an EMPTY store re-adds the authorization: the chain counters keep the window closed; the earlier run is recovered from logs', async () => {
      const n = await nonceOf(kA.address);
      const k = mk(new MemoryKeeperStore(), chainA);
      await k.addJob({ authorization: authK, ownerSignature: sigK, deployment: depK });
      const [j] = await k.tick();
      return { pass: j.state === 'DONE_THIS_WINDOW' && j.confirmed.length === 1 && j.confirmed[0].verification === 'VERIFIED' && j.confirmed[0].binding === 'DECODED_CALL' && (await nonceOf(kA.address)) === n,
        observed: `${j.state}, confirmed recovered ${j.confirmed.length} (${j.confirmed[0]?.verification}, ${j.confirmed[0]?.binding}: not prepared by this keeper), nonce unchanged` };
    });
    await increaseTime(DAY);
    await kscenario('K4-crash-after-send', 'window 1: the keeper crashes after sending, before storing the hash; the restart finds the purchase on chain and does not resend', async () => {
      const crashing = mk(new FileKeeperStore(storePath), { ...chainA, sendExecute: async (...x) => { await chainA.sendExecute(...x); throw new Error('CRASH after send'); } });
      let crashed = false; try { await crashing.tick(); } catch (e) { crashed = /CRASH after send/.test(e.message); }
      const stored = (await new FileKeeperStore(storePath).list())[0];
      const n = await nonceOf(kA.address);
      const [j] = await mk(new FileKeeperStore(storePath), chainA).tick();
      const st = await chainState();
      const last = j.confirmed[1];
      return { pass: crashed && stored.pending?.hash === null && j.confirmed.length === 2 && last?.verification === 'VERIFIED' && last?.binding === 'PREPARED_INTENT' && j.pending === null && (await nonceOf(kA.address)) === n && Number(st.executions) === 2,
        observed: `crashed=${crashed}, write-ahead hash=${stored.pending?.hash}, after restart: ${j.state}, confirmed ${j.confirmed.length} (${last?.verification}, ${last?.binding} from the write-ahead intent), chain executions ${st.executions}, nonce unchanged` };
    });
    await increaseTime(DAY);
    await kscenario('K5-two-keepers', 'window 2: keeper B (own store, its node blind to A\'s pending tx) sends too; one purchase, B\'s mined revert is recorded, the owner is charged once', async () => {
      const before = await bal(USDG, roles.owner);
      const a = mk(new FileKeeperStore(storePath), chainA, 'a');
      const chainB = chainOf(kB);
      const b = mk(new MemoryKeeperStore(), { ...chainB, simulateExecute: async () => ({ ok: true, gas: 4_000_000n }) }, 'b');
      await b.addJob({ authorization: authK, ownerSignature: sigK, deployment: depK });
      await rpc('evm_setAutomine', [false]);
      const [pa] = await a.tick(); const [pb] = await b.tick();
      await rpc('evm_mine'); await rpc('evm_setAutomine', [true]);
      const [ja] = await a.tick(); const [jb] = await b.tick();
      const st = await chainState();
      const reverted = [...ja.attempts, ...jb.attempts].filter(x => x.outcome === 'REVERTED').length;
      return { pass: pa.state === 'PENDING_TX' && pb.state === 'PENDING_TX' && Number(st.executions) === 3 && before - (await bal(USDG, roles.owner)) === GROSS && reverted === 1,
        observed: `both sent; chain executions ${st.executions}; owner charged ${before - (await bal(USDG, roles.owner))}; reverted attempts recorded ${reverted}` };
    });
    await increaseTime(DAY);
    await kscenario('K6-gas-shortage', 'window 3: the keeper account has no ETH → GAS_SHORTAGE and nothing sent; funded again → the last run; then COMPLETED', async () => {
      const k = mk(new FileKeeperStore(storePath), chainA);
      const n = await nonceOf(kA.address);
      await F.edit('GAS', 'hardhat_setBalance', [kA.address, '0x1'], 'keeper out of gas (fork only)');
      const [g] = await k.tick();
      const noSend = (await nonceOf(kA.address)) === n;
      await F.edit('GAS', 'hardhat_setBalance', [kA.address, v.toHex(v.parseEther('10'))], 'keeper funded again (fork only)');
      await k.tick(); const [d] = await k.tick();
      await increaseTime(DAY);
      const [c] = await k.tick();
      const st = await chainState();
      return { pass: g.state === 'GAS_SHORTAGE' && noSend && d.confirmed.length === K_RUNS && c.state === 'COMPLETED' && Number(st.executions) === K_RUNS && st.grossUsed === BigInt(K_RUNS) * GROSS,
        observed: `${g.state} (no tx) → confirmed ${d.confirmed.length} → ${c.state}; chain executions ${st.executions}, grossUsed ${st.grossUsed}` };
    });
    // Fixed max price on real pools: a window above it is skipped, recorded, and never made up. Runs LAST and moves the market
    // for good (no snapshot: under an open evm_snapshot, EDR's eth_estimateGas used another block time than eth_call, reproduced
    // as QuoteExpired in the keeper's pre-flight; the keeper failed closed and sent nothing).
    await kscenario('K7-fixed-price-skips-window', 'a new 2-run authorization (limits 100 bps above the real quote): run 1 in window 0; in window 1 the COIN pool is moved above the fixed max price → WAITING_PRICE stating market vs max price, nothing sent; at expiry window 1 is recorded missed (WAITING_PRICE), not made up, and one run\'s budget is reported unspendable', async () => {
      {
        const auth7 = sdk.buildRecurringAuthorization({ ...terms(BAG1, id1), amountPerRunRaw: GROSS, runs: 2, totalBudgetRaw: 2n * GROSS, startsAt: await now(), periodSeconds: DAY, maxPriceRaw: await limitsFromQuotes(BAG1, GROSS, 100), nonce: 31n });
        const summary7 = sdk.summarizeRecurringAuthorization(auth7);
        await send(W.owner, USDG, erc20, 'approve', [EXECUTOR, 2n * GROSS]);
        const k = mk(new MemoryKeeperStore(), chainA, 'k7');
        await k.addJob({ authorization: auth7, ownerSignature: await ownerSign(auth7), deployment: depK });
        await k.tick(); const [first] = await k.tick();
        await increaseTime(DAY);
        await send(W.attacker, USDG, erc20, 'approve', [SWAP_ROUTER02, 50_000n * USDG_UNIT]);
        let steps = 0;
        for (; steps < 40; steps++) {
          try { await buildRun(auth7); } catch (e) { if (e.code === 'PRICE_LIMIT_NOT_MET') break; throw e; }
          await send(W.attacker, SWAP_ROUTER02, swapAbi, 'exactInputSingle', [{ tokenIn: USDG, tokenOut: coin, fee: move.fee, recipient: roles.attacker, amountIn: 1_000n * USDG_UNIT, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }], 1_500_000n);
        }
        const n = await nonceOf(kA.address);
        const [waiting] = await k.tick();
        const noSend = (await nonceOf(kA.address)) === n;
        await increaseTime(DAY);
        const [end] = await k.tick();
        const st = await read(EXECUTOR, EXEC_ABI, 'getState', [roles.owner, sdk.recurringAuthorizationId(auth7, DEP)]);
        report.keeperPriceSkip = { summaryPriceLimit: summary7.priceLimit, summaryDependencies: summary7.dependencies, moveSteps: steps, waiting: { state: waiting.state, detail: waiting.stateDetail, outlook: waiting.outlook }, end: { state: end.state, missed: end.missed, outlook: end.outlook } };
        return { pass: first.confirmed.length === 1 && waiting.state === 'WAITING_PRICE' && /market price ~\d+ is above the FIXED max price \d+/.test(waiting.stateDetail ?? '') && noSend
            && end.state === 'EXPIRED' && end.missed.length === 1 && end.missed[0].reason === 'WAITING_PRICE' && end.outlook?.runsLeft === 1 && end.outlook?.unspendableRaw === GROSS && Number(st.executions) === 1
            && summary7.priceLimit.isSlippageProtection === false && summary7.priceLimit.catchUp === false,
          observed: `${steps} × 1000 USDG moved COIN; window 1: ${waiting.state} (${redact(waiting.stateDetail ?? '').slice(0, 160)}), no tx: ${noSend}; at expiry: ${end.state}, missed ${end.missed.map(m => m.window + ':' + m.reason).join(',')}, runs left ${end.outlook?.runsLeft}, unspendable ${end.outlook?.unspendableRaw} raw; chain executions ${st.executions}` };
      }
    });
    report.keeperPhase = { status: 'RUN', authorizationId: idK, runs: K_RUNS, ownerDebitRaw: ownerStart - (await bal(USDG, roles.owner)), expectedDebitRaw: BigInt(K_RUNS) * GROSS, store: 'keeper-store.redacted.json (the file store with signatures replaced by their sha256)', keeperAccounts: [kA.address, kB.address],
      note: 'keeper transactions are sent with app viem on the same fork transport; they are not in forkLocalTransactions' };
    writeFileSync(join(out, 'keeper-store.redacted.json'), readFileSync(storePath, 'utf8').replace(/0x[0-9a-fA-F]{130,}/g, m => `<redacted signature sha256:${createHash('sha256').update(m).digest('hex').slice(0, 16)}>`));
  }
} catch (e) {
  if (e instanceof UsageError) { report.exit = { code: 2, status: 'USAGE', detail: e.message }; exitCode = 2; }
  else if (e.external || PRUNED_RE.test(errText(e))) { report.exit = { code: 3, status: 'EXTERNAL', detail: redact(errText(e)) }; exitCode = 3; }
  else { report.exit = { code: 1, status: 'FATAL', detail: redact(errText(e)), stack: redact(e?.stack ?? '') }; exitCode = 1; }
  console.error(report.exit.status, report.exit.detail);
} finally {
  report.scenarios = scenarios;
  const by = k => Object.fromEntries([...new Set(scenarios.map(s => s[k]))].map(g => [g, { pass: scenarios.filter(s => s[k] === g && s.pass).length, fail: scenarios.filter(s => s[k] === g && !s.pass).length }]));
  report.counts = { byKind: by('kind'), byGate: by('gate') };
  if (!report.exit) { const failed = scenarios.filter(s => !s.pass).map(s => s.id); report.exit = failed.length ? { code: 4, status: 'SCENARIO_FAILED', failed } : { code: 0, status: 'COMPLETE' }; exitCode = report.exit.code; }
  report.quoteDiagnostics = quoteDiagnostics;
  report.network = { ...network, relay: relay?.stats, forkLocalTransactions: F?.localTx?.sent, publicWrites: 0, note: 'publicWrites is 0 by construction: the relay refuses every non-read method (self-tested at start) and counts refusals' };
  report.forkChanges = F?.changes;
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, 'results.json'), json(report));
  writeFileSync(join(out, 'summary.md'), summaryMd(report));
  try { await F?.close(); } catch {}
  try { await relay?.close(); } catch {}
  console.log(`exit ${report.exit.code} ${report.exit.status}; results: ${join(out, 'results.json')}`);
  process.exit(exitCode);
}

function summaryMd(r) {
  const cell = x => String(x ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const kinds = { LIFECYCLE: 'Yaşam döngüsü (dürüst işlemler; SDK doğrulaması: hazırlanan çağrı + işlem kapsamlı bakiye)', REAL_FAULT: 'Gerçek hatalı yürütme (fork\'ta gönderildi ve mine edildi)', SDK_REFUSAL: 'SDK reddi (plan veya yetki kurulmadı)', ALTERED_EXPECTATION: 'Değiştirilmiş doğrulama beklentisi (mine edilmiş işlem, yanlış beklenti)', EVIDENCE_SCOPE: 'Kanıt kapsamı (okuyucunun kanıtlayamadığı durum)', KEEPER_FORK: 'Kalıcı keeper (aynı fork)' };
  let md = `# RecurringPurchaseExecutor fork kanıtı\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| Kanıt sınıfı | **${r.evidenceClass}**: yalnızca bu süreçte üretilen test anahtarları. Cüzdan, insan imzası veya public işlem değildir |\n`;
  md += `| Çıkış | ${r.exit?.code} ${r.exit?.status} |\n`;
  md += `| Uygulama commit'i | \`${r.build?.appCommit}\` (contracts/ ve SDK src kirli mi: ${r.build?.appDirtyInContractsOrSdk ? 'EVET' : 'hayır'}) |\n`;
  md += `| Fork | blok ${r.fork?.blockNumber} (\`${r.fork?.blockHash}\`), tek fork bloğu; her alımın bütün bacakları tek işlemde |\n`;
  md += `| Executor | \`${r.keylessExecutor?.address}\` (anahtarsız; 4663'te kod ${r.keylessExecutor?.mainnetCode}, nonce ${r.keylessExecutor?.mainnetNonce}). Runtime artifact ile eşleşiyor: ${r.deployment?.executor?.runtimeMatchesArtifact} |\n`;
  md += `| Gerçek kontratlar | USDG (impl \`${r.deployment?.realContracts?.USDG?.eip1967Implementation}\`), SwapRouter02, QuoterV2, BagFactory, StrategyRegistry. Router: uygulamanın BagExecutionRouter'ı, gerçek BagFactory ile; owner ve planSigner test anahtarı |\n`;
  md += `| Alım doğrulaması | SDK \`verifyRecurringPurchase\`: mine edilen calldata bu koşucunun hazırladığı çağrıyla bayt bayt aynı (PREPARED_INTENT); kaynak borcu, alıcı teslimleri ve executor/router kalıntısı işlem kapsamlı bakiyelerden (okuyucu: ${r.purchaseVerification?.balanceReader}; yalnızca bloktaki tek işlem için geçerli). Koşucunun kendi bakiye okumaları ikinci, bağımsız kontrol. Gerçek zincir için Nitro okuyucusu bu koşuda denenmedi |\n`;
  md += `| Fiyat sınırı | Sahibin imzaladığı varlık başına azami fiyat. Testte: kurulumda gerçek zincirdeki en iyi QuoterV2 teklifi + 300 bps (A/B/C, keeper) veya + 100 bps (P). Bağımsız piyasa referansı **değildir** |\n`;
  md += `| Ağ | Composer/LI.FI isteği: **${r.network?.composerOrLifiRequests}**; reddedilen host: ${(r.network?.refused ?? []).length}; upstream okuma: ${r.network?.relay?.forwardedRequests}; relay'in reddettiği yazma: ${r.network?.relay?.refusedRequests}; public yazma: ${r.network?.publicWrites} |\n`;
  md += `| Fonlar EOA'da | ${r.fundsStayInOwnerAddress?.pass ? 'EVET' : 'HAYIR'}: ${r.fundsStayInOwnerAddress?.honestRuns} alım × 5 USDG = ${r.fundsStayInOwnerAddress?.spentRaw} ham birim; executor ve router'da bakiye kalmadı |\n\n`;
  for (const k of Object.keys(kinds)) {
    const rows = (r.scenarios ?? []).filter(x => x.kind === k);
    if (!rows.length) continue;
    md += `## ${kinds[k]}: ${rows.filter(x => x.pass).length}/${rows.length}\n\n| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |\n|---|---|---|---|---|---|\n`;
    for (const x of rows) md += `| ${x.id} | ${x.gate} | ${cell(x.expected)} | ${cell(x.observed ?? x.error)} | ${x.stateUnchanged === undefined ? '—' : x.stateUnchanged} | ${x.pass ? 'PASS' : '**FAIL**'} |\n`;
    md += '\n';
  }
  md += `Fork'a özel durum değişiklikleri (${(r.forkChanges ?? []).length}): ${[...new Set((r.forkChanges ?? []).map(c => c.kind))].join(', ')}. Ayrıntı: results.json → forkChanges.\n`;
  return md;
}
