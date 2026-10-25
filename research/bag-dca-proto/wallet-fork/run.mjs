#!/usr/bin/env node
// Wallet-signed periodic DCA on an isolated Robinhood Chain fork (model B: the user's EOA owns a
// separate MultiSig smart account that funds the plan through a bounded delegation).
//
//   node wallet-fork/run.mjs --signer test   --sdk <built packages/bag-sdk with #126>   (local test key, end to end)
//   node wallet-fork/run.mjs --signer wallet --sdk <...>                               (human signatures in the local page)
//   options: --mode replay|live (default replay; live needs LIFI_API_KEY in --env-file), --env-file <file>, --port <n>, --out <dir>
//
// Four user signatures: D1 (limits plan), D2 (plan that is cancelled with budget left), the cancel
// user operation and the withdraw user operation. Everything else is fork setup or test-key checks.
// Nothing is sent to a public network: the upstream relay refuses every write method.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay, createFork, compileProto, chainFor, v, accounts, aa, kit, reasonOf, revertIs, json, PUBLIC_RPC } from '../lib/fork-env.mjs';
import { loadComposer, composerOps, USDG, FIXTURE_GROSS } from '../lib/composer-plan.mjs';
import { buildDcaPlan, planCaveatSpec, decodeDelegationTypedData, compareDelegationToPlan, decodeUserOpTypedData, formatTokenAmount, canonicalJson } from '../lib/dca-rules.mjs';
import { planCaveats, delegationTypedData, typedDigest, stripEip712Domain, delegationStruct, permissionContext, asTuple, executeCallData, userOperation, userOpTypedData, toWire, ENTRY_POINT } from '../lib/typed-data.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..');
const args = process.argv.slice(2), arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SIGNER = arg('--signer', 'test'), MODE = arg('--mode', 'replay');
if (!['test', 'wallet'].includes(SIGNER)) throw new Error('--signer test|wallet');
if (!['replay', 'live'].includes(MODE)) throw new Error('--mode replay|live');
const SESSION = new Date().toISOString().replaceAll(':', '-').slice(0, 19) + '-' + randomBytes(3).toString('hex');
const out = resolve(arg('--out', join(here, 'out', `${SESSION}-${SIGNER}-${MODE}`)));
const privateDir = join(here, 'private', SESSION);
if (existsSync(out)) throw new Error('Use a new --out directory.');
// A purchase trace carries the permission context (with the user's delegation signature) in its
// calldata, so in human-signature mode traces stay in the private folder, next to the signatures.
const traceDir = SIGNER === 'wallet' ? join(privateDir, 'traces') : join(out, 'traces');
mkdirSync(out, { recursive: true }); mkdirSync(traceDir, { recursive: true });

// Only allowlisted keys are read from the env file; values are never logged or written.
const env = {};
if (arg('--env-file')) for (const line of readFileSync(resolve(arg('--env-file')), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && ['ROBINHOOD_RPC_URL', 'LIFI_API_KEY'].includes(m[1])) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const secrets = Object.values(env).filter(Boolean);
const redact = x => { let s = String(x); for (const k of secrets) s = s.replaceAll(k, '<redacted>'); return s.replace(/https?:\/\/[^\s"'<>]+/g, '<url>').slice(0, 600); };

const CLASS = SIGNER === 'wallet' ? 'HUMAN_SIGNATURE' : 'TEST_KEY';
const PROGRAM = MODE === 'live' ? 'FRESH_COMPOSER_QUOTE' : 'RECORDED_COMPOSER_REPLAY';
const report = { schema: 'bag-dca-wallet-fork/v1', session: SESSION, signer: SIGNER, mode: MODE, evidence: { signatures: CLASS, program: PROGRAM }, startedAt: new Date().toISOString(),
  checks: [], purchases: [], userOps: [], signatures: [], forks: [], preflight: {}, status: 'RUNNING' };
const check = async (id, name, cls, fn) => {
  try { const details = await fn(); report.checks.push({ id, name, class: cls, status: 'PASS', details }); console.log(`PASS ${id} ${name}`); return details; }
  catch (e) { const error = redact(e?.shortMessage ?? e?.message ?? e); report.checks.push({ id, name, class: cls, status: 'FAIL', error }); console.log(`FAIL ${id} ${name}: ${error.slice(0, 300)}`); return null; }
};
const must = async (id, name, cls, fn) => { const r = await check(id, name, cls, fn); if (r === null) throw new Error(`${id} failed; stopping`); return r; };

const keyless = label => v.getAddress('0x' + v.keccak256(v.toBytes(label)).slice(-40));
const F_STAR = keyless('BAG-DCA fork-only plan factory v1'), PM_STAR = keyless('BAG-DCA fork-only paymaster v1');
const FORBIDDEN_OWNERS = ['0xb193de199eeb9bd1143607a11ad00999ceb956b8']; // the user's funded account must never sign here
const USDG_HOLDER = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const FUND = 50_000_000n, SINGLE_MODE = '0x' + '0'.repeat(64);
// Fork lifecycles use 2-minute windows: a one-day time jump makes any Composer program (recorded or a
// fresh quote taken at real time) stale on the fork. Day/week periods are covered by the rules tests.
const FORK_PERIOD = { count: Number(arg('--period-minutes', '2')), unit: 'minute' };
const pins = JSON.parse(readFileSync(join(root, 'lib/pins.json'), 'utf8'));
const envDF = kit.getSmartAccountsEnvironment(4663), DM = envDF.DelegationManager, E = envDF.caveatEnforcers;
const ENF = { ERC20PeriodTransferEnforcer: E.ERC20PeriodTransferEnforcer, ERC20TransferAmountEnforcer: E.ERC20TransferAmountEnforcer, LimitedCallsEnforcer: E.LimitedCallsEnforcer,
  TimestampEnforcer: E.TimestampEnforcer, RedeemerEnforcer: E.RedeemerEnforcer, AllowedCalldataEnforcer: E.AllowedCalldataEnforcer };
const erc20 = v.parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)']);
const dmAbi = v.parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])', 'function disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))',
  'function disabledDelegations(bytes32) view returns (bool)', 'function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)) pure returns (bytes32)', 'function getDomainHash() view returns (bytes32)']);
const epAbi = [...aa.entryPoint07Abi, ...v.parseAbi(['function depositTo(address) payable', 'function getNonce(address,uint192) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'])];
const counterAbis = { period: v.parseAbi(['function periodicAllowances(address,bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']),
  spent: v.parseAbi(['function spentMap(address,bytes32) view returns (uint256)']), calls: v.parseAbi(['function callCounts(address,bytes32) view returns (uint256)']) };

let relay, F, server, exitCode = 1;
const sigFile = [];
try {
  // ---- Inputs -------------------------------------------------------------------------------
  const sdkDir = arg('--sdk'); if (!sdkDir) throw new Error('--sdk <built packages/bag-sdk with forwarded-delivery mode> is required');
  const vendorDir = resolve(arg('--vendor', join(root, 'vendor/e6bdd10')));
  if (MODE === 'live' && !env.LIFI_API_KEY) { report.status = 'NOT_RUN'; report.reason = 'live mode needs LIFI_API_KEY in --env-file'; exitCode = 2; throw new Error(report.reason); }
  const C = await loadComposer({ vendorDir, sdkDir: resolve(sdkDir) });
  report.inputs = { vendorDir: vendorDir.replace(root, '.'), sdkReceiptJsSha256: createHash('sha256').update(C.receiptJs).digest('hex'), bag: { id: C.fixture.bag.ref?.strategyId, definitionHash: C.fixture.bag.definitionHash } };
  const { art, solcVersion, settings } = compileProto(['composer/contracts/DcaComposerPlan.sol', 'composer/contracts/LocalArbSysRead.sol', 'composer/contracts/ForkOnlyPaymaster.sol']);
  const planAbi = art('DcaComposerPlan').abi, factoryAbi = art('DcaComposerPlanFactory').abi;
  report.compiler = { solc: solcVersion, settings: { ...settings, outputSelection: undefined } };
  relay = await startRelay(env.ROBINHOOD_RPC_URL || PUBLIC_RPC);
  report.relay = relay.stats;
  const remote = v.createPublicClient({ chain: chainFor(relay.url), transport: v.http(relay.url) });

  // ---- Signer ------------------------------------------------------------------------------
  let signer;
  if (SIGNER === 'test') {
    const key = accounts.generatePrivateKey(), acct = accounts.privateKeyToAccount(key);
    signer = { address: acct.address, sign: async step => acct.signTypedData(stripEip712Domain(step.typedData)), status: () => {} };
  } else {
    const { startSigningServer } = await import('./server.mjs');
    server = await startSigningServer({ port: Number(arg('--port', '0')), pageDir: join(here, 'page'), libDir: join(root, 'lib') });
    console.log(`\nOpen in the browser where MetaMask/Rabby is installed (this machine only):\n  ${server.url}\n`);
    if (arg('--url-file')) { mkdirSync(dirname(resolve(arg('--url-file'))), { recursive: true }); writeFileSync(resolve(arg('--url-file')), server.url); }
    const owner = await server.waitForAccount();
    signer = { address: owner, sign: step => server.requestSignature(step), status: s => server.setStatus(s) };
  }
  const owner = v.getAddress(signer.address);
  report.owner = owner;

  // ---- Preflight on Robinhood Chain (read-only) ------------------------------------------------
  const pre = await must('P-1', 'preflight: chain, USDG definition, pinned bytecode, keyless addresses, empty test account', 'READ_ONLY_MAINNET', async () => {
    const chainId = await remote.getChainId(); assert.equal(chainId, 4663);
    const block = await remote.getBlock();
    const [decimals, symbol, name] = await Promise.all(['decimals', 'symbol', 'name'].map(f => remote.readContract({ address: USDG, abi: erc20, functionName: f })));
    assert.equal(decimals, 6); assert.equal(symbol, 'USDG');
    for (const [n, c] of Object.entries(pins.contracts)) assert.equal(v.keccak256(await remote.getCode({ address: c.address })), c.codeHash, `${n} bytecode differs from lib/pins.json`);
    assert.equal(F_STAR, '0x7fE0cf854704Ce6f29691a75F6839233AFfDb3E6'); assert.equal(PM_STAR, '0x03fd2c77d32302eeF2f6F3063DbB7b899b1116D3');
    const keylessState = {};
    for (const [n, a] of [['factory', F_STAR], ['paymaster', PM_STAR]]) {
      keylessState[n] = { address: a, code: (await remote.getCode({ address: a })) ?? '0x', nonce: await remote.getTransactionCount({ address: a }), balance: await remote.getBalance({ address: a }) };
      assert.equal(keylessState[n].code, '0x', `${n} has code on Robinhood Chain`); assert.equal(keylessState[n].nonce, 0);
    }
    assert(!FORBIDDEN_OWNERS.includes(owner.toLowerCase()), 'this account must not be used: it holds real funds');
    const acct = { eth: await remote.getBalance({ address: owner }), usdg: await remote.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [owner] }),
      code: (await remote.getCode({ address: owner })) ?? '0x', nonce: await remote.getTransactionCount({ address: owner }) };
    if (SIGNER === 'wallet') { assert.equal(acct.eth, 0n, 'use a new, empty account (ETH balance is not zero)'); assert.equal(acct.usdg, 0n, 'use a new, empty account (USDG balance is not zero)'); assert.equal(acct.code, '0x', 'account has code (EIP-7702?)'); }
    return { block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, usdg: { address: USDG, decimals, symbol, name }, keyless: keylessState, owner: { address: owner, ...acct } };
  });
  report.preflight = pre;

  // ---- DCA rules: one implementation for the page and the runner -------------------------------
  const gross = MODE === 'replay' ? FIXTURE_GROSS : BigInt(Math.round(Number(arg('--amount', '5')) * 1e6));
  const sa = await kit.toMetaMaskSmartAccount({ client: remote, implementation: kit.Implementation.MultiSig, deployParams: [[owner], 1n], deploySalt: '0x',
    signer: [{ account: accounts.privateKeyToAccount(accounts.generatePrivateKey()) }] }); // signer unused: address and factory data only
  const SA = sa.address;
  const saMainnet = { code: (await remote.getCode({ address: SA })) ?? '0x', usdg: await remote.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [SA] }) };
  report.smartAccount = { address: SA, implementation: 'MultiSigDeleGator v1.3.0 (threshold 1, owner = test EOA, salt 0x)', mainnet: saMainnet };
  const start = pre.block.timestamp + 300n;
  const ruleInput = { bag: { definitionHash: C.fixture.bag.definitionHash, strategyId: C.fixture.bag.ref?.strategyId, version: C.fixture.bag.ref?.version, chainId: 4663 },
    token: { address: USDG, symbol: 'USDG', decimals: 6, verifiedOnChain: true }, amountPerRun: formatTokenAmount(gross, 6), period: FORK_PERIOD,
    start: { mode: 'at', at: start }, now: pre.block.timestamp, owner, fundingAccount: SA, recipient: owner };
  const plan1 = buildDcaPlan({ ...ruleInput, runs: 2 }), plan2 = buildDcaPlan({ ...ruleInput, runs: 3 });
  report.plans = { D1: { summary: plan1.summary, totalRaw: plan1.totalRaw, runs: plan1.runs }, D2: { summary: plan2.summary, totalRaw: plan2.totalRaw, runs: plan2.runs } };
  const termsOf = p => ({ funding: 2, owner, source: SA, recipient: owner, delegationManager: DM, definitionHash: p.bag.definitionHash, grossPerRun: p.perRunRaw,
    maxRuns: BigInt(p.runs), start: p.startTime, period: p.periodSeconds, expiry: p.expiry, cashBps: 0n });

  // ---- Prepare on a fork: template, plan addresses, the four typed data ------------------------
  async function setupFork(label) {
    const f = await createFork({ relayUrl: relay.url, out, label });
    report.forks.push({ label, block: f.block, changes: f.changes, localTransactions: f.localTx });
    const keeper = accounts.privateKeyToAccount(accounts.generatePrivateKey());
    await f.edit('ARBSYS_READ_MODEL', 'hardhat_setCode', ['0x0000000000000000000000000000000000000064', art('LocalArbSysRead').runtime], 'ArbSys arbBlockNumber() read model for the Composer VM');
    await f.edit('KEYLESS_FACTORY', 'hardhat_setCode', [F_STAR, art('DcaComposerPlanFactory').runtime], 'plan factory at the keyless address (no code can exist there on Robinhood Chain)');
    await f.edit('KEYLESS_PAYMASTER', 'hardhat_setCode', [PM_STAR, art('ForkOnlyPaymaster').runtime], 'research paymaster at the keyless address');
    await f.edit('KEEPER_ETH', 'hardhat_setBalance', [keeper.address, v.toHex(v.parseEther('10'))], 'local keeper gas (fork only)');
    await f.rpc('evm_mine');
    return { ...f, keeper, K: f.wallet(keeper), ops: composerOps(C, { client: f.client, remote, mode: MODE, apiKey: env.LIFI_API_KEY }) };
  }
  F = await setupFork('prepare');
  const placeholder = accounts.privateKeyToAccount(accounts.generatePrivateKey()).address;
  const TD = await F.ops.template(await F.ops.compileFor(placeholder, gross), placeholder, gross);
  const profile = F.ops.asProfile(TD), swap = TD.legs.reduce((a, l) => a + l.input, 0n);
  const read = (f, address, abi, functionName, a = []) => f.client.readContract({ address, abi, functionName, args: a });
  const P1 = await read(F, F_STAR, factoryAbi, 'predict', [termsOf(plan1), profile, 1n]), P2 = await read(F, F_STAR, factoryAbi, 'predict', [termsOf(plan2), profile, 2n]);
  await must('P-2', 'plan addresses recomputed from factory + salt + initCodeHash; programs for them match the signer-independent template', 'FORK_PREPARE', async () => {
    for (const [P, t, n] of [[P1, termsOf(plan1), 1n], [P2, termsOf(plan2), 2n]]) {
      const salt = await read(F, F_STAR, factoryAbi, 'salt', [t, n]), ich = await read(F, F_STAR, factoryAbi, 'initCodeHash', [t, profile]);
      assert.equal(v.getContractAddress({ opcode: 'CREATE2', from: F_STAR, salt, bytecodeHash: ich }), P);
      assert.equal(F.ops.comparable(await F.ops.template(await F.ops.compileFor(P, gross), P, gross)), F.ops.comparable(TD));
      assert.equal((await remote.getCode({ address: P })) ?? '0x', '0x', 'plan address has code on Robinhood Chain');
    }
    return { P1, P2, swapAmountRaw: swap, templateCommandsHash: TD.commandsHash };
  });
  const sessionSalt = BigInt('0x' + randomBytes(16).toString('hex'));
  const specs = { D1: planCaveatSpec(plan1, P1, { maxCalls: plan1.runs }), D2: planCaveatSpec(plan2, P2, { maxCalls: plan2.runs }) };
  const tds = { D1: delegationTypedData({ delegationManager: DM, delegate: P1, delegator: SA, caveats: planCaveats(ENF, specs.D1), salt: sessionSalt + 1n }),
    D2: delegationTypedData({ delegationManager: DM, delegate: P2, delegator: SA, caveats: planCaveats(ENF, specs.D2), salt: sessionSalt + 2n }) };
  for (const k of ['D1', 'D2']) {
    const { decoded, errors } = decodeDelegationTypedData(toWire(tds[k]), ENF);
    const bad = [...errors, ...compareDelegationToPlan(decoded, specs[k], { delegationManager: DM, delegator: SA })];
    if (bad.length) throw new Error(`${k}: typed data does not match the plan: ${bad.join('; ')}`);
  }

  // ---- Signatures --------------------------------------------------------------------------------
  const sig = {};
  async function obtain(id, kind, title, typedData, extra) {
    const wire = toWire(typedData), digest = typedDigest(typedData);
    const signature = await signer.sign({ id, kind, title, typedData: wire, digest, ...extra });
    const recovered = await v.recoverTypedDataAddress({ ...stripEip712Domain(typedData), signature });
    assert.equal(recovered, owner, `${id}: signature is not from ${owner}`);
    sigFile.push({ id, kind, digest, signature, typedData: wire });
    report.signatures.push({ id, kind, class: CLASS, digest, signatureSha256: createHash('sha256').update(signature).digest('hex'), recovered });
    return signature;
  }
  const planView = (p, P) => ({ plan: { summary: p.summary, perRunRaw: p.perRunRaw, runs: p.runs, totalRaw: p.totalRaw, periodSeconds: p.periodSeconds, startTime: p.startTime, expiry: p.expiry, recipient: p.recipient }, planAddress: P, swapAmountRaw: swap });
  const expectBase = { delegationManager: DM, delegator: SA, enforcers: ENF, keylessFactory: F_STAR, paymaster: PM_STAR, owner, smartAccount: SA, mainnetChecks: pre.keyless };
  sig.D1 = await obtain('D1', 'delegation', `İzin 1/2: ${plan1.summary.tr[0]} (limit testi)`, tds.D1, { spec: specs.D1, expect: expectBase, ...planView(plan1, P1) });
  sig.D2 = await obtain('D2', 'delegation', `İzin 2/2: ${plan2.summary.tr[0]} (bütçe kalmışken iptal edilecek)`, tds.D2, { spec: specs.D2, expect: expectBase, ...planView(plan2, P2) });
  const D1 = delegationStruct(tds.D1, sig.D1), D2 = delegationStruct(tds.D2, sig.D2);
  const fee = 1_000_000_000n;
  const cancelOp = userOperation({ sender: SA, nonce: 0n, callData: executeCallData(DM, v.encodeFunctionData({ abi: dmAbi, functionName: 'disableDelegation', args: [asTuple(D2)] })),
    paymaster: PM_STAR, validUntil: start + 6n * 3600n, maxFeePerGas: fee });
  const remaining = FUND - 3n * swap;
  const withdrawOp = userOperation({ sender: SA, nonce: 1n, callData: executeCallData(USDG, v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [owner, remaining] })),
    paymaster: PM_STAR, validUntil: start + 3n * 86400n, maxFeePerGas: fee });
  const opTds = { cancel: userOpTypedData(cancelOp, SA), withdraw: userOpTypedData(withdrawOp, SA) };
  for (const k of ['cancel', 'withdraw']) { const { errors } = decodeUserOpTypedData(toWire(opTds[k])); if (errors.length) throw new Error(`${k} op typed data: ${errors.join('; ')}`); }
  cancelOp.signature = await obtain('CANCEL', 'userop', 'İptal: D2 iznini kapat (bütçe kalmışken)', opTds.cancel, { expect: { ...expectBase, call: 'disableDelegation(D2)', delegationToDisable: tds.D2.message } });
  withdrawOp.signature = await obtain('WITHDRAW', 'userop', `Çekim: kalan ${formatTokenAmount(remaining, 6)} USDG sahibine`, opTds.withdraw, { expect: { ...expectBase, call: `USDG.transfer(${owner}, ${remaining})` } });
  if (SIGNER === 'wallet') { mkdirSync(privateDir, { recursive: true }); writeFileSync(join(privateDir, 'signatures.json'), json({ session: SESSION, note: 'PRIVATE: usable signatures. Do not share.', items: sigFile })); }
  await F.close(); signer.status('Tüm imzalar alındı. Fork üzerinde yaşam döngüsü çalışıyor…');

  // ---- Execute on a fresh fork ---------------------------------------------------------------
  F = await setupFork('execute');
  const { client, rpc, edit, K, keeper, ops } = F;
  const sendK = async (to, abi, functionName, a = [], value = 0n) => {
    const hash = await K.writeContract({ address: to, abi, functionName, args: a, value, gas: 25_000_000n });
    const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(functionName + ' failed'); return r;
  };
  const bal = (t, a) => client.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [a] });
  const now = async () => (await client.getBlock()).timestamp;
  const at = async t => { if (t > await now()) { await rpc('evm_setNextBlockTimestamp', [Number(t)]); await rpc('evm_mine'); } };
  await must('E-1', 'fork setup: pinned bytecode, keyless factory/paymaster code, paymaster deposit, smart account deployed and funded on the fork only', 'FORK_SETUP', async () => {
    for (const [n, c] of Object.entries(pins.contracts)) assert.equal(v.keccak256(await client.getCode({ address: c.address })), c.codeHash, n);
    await sendK(ENTRY_POINT, epAbi, 'depositTo', [PM_STAR], v.parseEther('0.1'));
    const { factory, factoryData } = await sa.getFactoryArgs();
    await client.waitForTransactionReceipt({ hash: await K.sendTransaction({ to: factory, data: factoryData, gas: 3_000_000n }) });
    assert((await client.getCode({ address: SA }))?.length > 2);
    await edit('IMPERSONATE', 'hardhat_impersonateAccount', [USDG_HOLDER], 'USDG for the test smart account comes from a real holder balance on the fork');
    await edit('HOLDER_GAS', 'hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))], 'gas for the impersonated holder (fork only)');
    const holder = F.wallet(USDG_HOLDER);
    await client.waitForTransactionReceipt({ hash: await holder.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [SA, FUND], gas: 500_000n }) });
    await edit('STOP_IMPERSONATE', 'hardhat_stopImpersonatingAccount', [USDG_HOLDER], '');
    for (const [P, t, n] of [[P1, termsOf(plan1), 1n], [P2, termsOf(plan2), 2n]]) {
      await sendK(F_STAR, factoryAbi, 'deploy', [t, profile, n]);
      assert((await client.getCode({ address: P }))?.length > 2, 'plan not at the signed address');
      assert.equal(await read(F, P, planAbi, 'owner'), owner); assert.equal(await read(F, P, planAbi, 'recipient'), owner); assert.equal(await read(F, P, planAbi, 'source'), SA);
    }
    return { smartAccount: SA, fundedUsdgRaw: FUND, fundingMethod: 'IMPERSONATED_HOLDER_TRANSFER_ON_FORK', holder: USDG_HOLDER, plans: { P1, P2 }, paymasterDeposit: await read(F, ENTRY_POINT, epAbi, 'balanceOf', [PM_STAR]) };
  });
  await must('E-2', 'the account accepts the user signatures (ERC-1271) and their digests equal the DelegationManager hash', CLASS, async () => {
    const domainHash = await read(F, DM, dmAbi, 'getDomainHash');
    for (const [k, d] of [['D1', D1], ['D2', D2]]) {
      const structHash = await read(F, DM, dmAbi, 'getDelegationHash', [asTuple(d)]);
      assert.equal(v.keccak256(v.concat(['0x1901', domainHash, structHash])), typedDigest(tds[k]));
      assert.equal(await read(F, SA, v.parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']), 'isValidSignature', [typedDigest(tds[k]), d.signature]), '0x1626ba7e');
    }
    return { erc1271: 'VALID', delegations: 2 };
  });
  const hashOf = d => read(F, DM, dmAbi, 'getDelegationHash', [asTuple(d)]);
  const H1 = await hashOf(D1), H2 = await hashOf(D2);
  const counters = async h => ({ periodSpent: (await read(F, ENF.ERC20PeriodTransferEnforcer, counterAbis.period, 'periodicAllowances', [DM, h]))[4],
    totalSpent: await read(F, ENF.ERC20TransferAmountEnforcer, counterAbis.spent, 'spentMap', [DM, h]), calls: await read(F, ENF.LimitedCallsEnforcer, counterAbis.calls, 'callCounts', [DM, h]),
    disabled: await read(F, DM, dmAbi, 'disabledDelegations', [h]) });
  const state = async (P, h, account = SA) => {
    const s = { runs: await read(F, P, planAbi, 'runs'), lastExecution: await read(F, P, planAbi, 'lastExecution'), accountUsdg: await bal(USDG, account), accountEth: await client.getBalance({ address: account }),
      epNonce: await read(F, ENTRY_POINT, epAbi, 'getNonce', [account, 0n]), planUsdg: await bal(USDG, P), proxyAllowance: await read(F, USDG, erc20, 'allowance', [P, await read(F, P, planAbi, 'proxy')]), counters: await counters(h) };
    for (const t of ops.legTokens) { s['recipient:' + t] = await bal(t, owner); s['plan:' + t] = await bal(t, P); }
    return s;
  };
  const programs = new Map();
  const programFor = async P => { if (MODE === 'live' || !programs.has(P)) programs.set(P, await ops.compileFor(P, gross)); return ops.forPlan(programs.get(P), P, planAbi, TD); };

  async function purchase(id, name, cls, P, d, h, account = SA, recipient = owner) {
    return must(id, name, cls, async () => {
      const c = await programFor(P), before = await state(P, h, account);
      const runArgs = [c.transaction.to, c.transaction.data, permissionContext(d)];
      const hash = await K.writeContract({ address: P, abi: planAbi, functionName: 'run', args: runArgs, gas: 25_000_000n }).catch(async e => {
        throw new Error(`${redact(reasonOf(e)).slice(0, 200)} | revert site: ${JSON.stringify(await revertSite(P, v.encodeFunctionData({ abi: planAbi, functionName: 'run', args: runArgs })))}`);
      });
      const r = await client.waitForTransactionReceipt({ hash });
      writeFileSync(join(traceDir, id + '.json'), json(await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }])));
      const after = await state(P, h, account), proxy = await read(F, P, planAbi, 'proxy');
      assert.equal(r.status, 'success'); assert.equal(after.runs, before.runs + 1n);
      assert.equal(before.accountUsdg - after.accountUsdg, swap, 'funding debit is not exactly the swap amount');
      assert.equal(after.planUsdg, 0n); assert.equal(after.proxyAllowance, 0n); assert.equal(await bal(USDG, proxy), 0n);
      const deliveries = TD.legs.map(l => { const t = l.token.toLowerCase(); return { token: t, minimum: l.minimum, delivered: after['recipient:' + t] - before['recipient:' + t], planResidue: after['plan:' + t] }; });
      for (const x of deliveries) { assert(x.delivered >= x.minimum, `below minimum ${x.token}`); assert.equal(x.planResidue, 0n); }
      for (const t of ops.legTokens) assert.equal(await bal(t, proxy), 0n, 'transit balance left on the Composer proxy');
      const verdict = await C.sdk.verifyPurchaseReceipt(c, { client: C.withReceiptEvidence(client, { deliveryAuthorization: 'BAG_DCA_PLAN_V1' }), transactionHash: hash,
        minimumReceived: TD.legs.map(l => ({ token: l.token, amountRaw: l.minimum })), confirmations: 1, delivery: { caller: P, fundingSource: account, recipient } });
      assert.equal(verdict.status, 'VERIFIED', 'SDK forwarded verification: ' + JSON.stringify(verdict.issues));
      const rec = { id, plan: P, delegationHash: h, transactionHash: hash, blockNumber: r.blockNumber, blockHash: r.blockHash, gasUsed: r.gasUsed, status: r.status,
        fundingDebitRaw: before.accountUsdg - after.accountUsdg, deliveries, countersBefore: before.counters, countersAfter: after.counters, sdk: { status: verdict.status, binding: verdict.transactionBinding, delivery: verdict.delivery },
        program: PROGRAM, trace: `traces/${id}.json` };
      report.purchases.push(rec); return rec;
    });
  }
  // Deepest failing frame of a call (callTracer via debug_traceCall), for failure reports.
  async function revertSite(to, data) {
    try {
      const t = await rpc('debug_traceCall', [{ from: keeper.address, to, data, gas: v.toHex(25_000_000n) }, 'latest', { tracer: 'callTracer' }]);
      const deep = f => { for (const k of f?.calls ?? []) { const x = deep(k); if (x) return x; } return f?.error ? { to: f.to, selector: f.input?.slice(0, 10), error: f.error, output: f.output?.slice(0, 138) } : null; };
      return deep(t);
    } catch (e) { return { traceError: redact(e?.message ?? e).slice(0, 120) }; }
  }
  async function refused(id, name, cls, P, h, attempt, expect, account = SA) {
    return check(id, name, cls, async () => {
      const before = await state(P, h, account);
      let reason; try { await attempt(); } catch (e) { reason = redact(reasonOf(e)); }
      assert(reason !== undefined, 'expected a revert, the call succeeded');
      assert(revertIs(reason, expect), `expected ${expect}, got: ${reason}`);
      assert.deepEqual(await state(P, h, account), before, 'state changed on a refused attempt');
      return { reason: reason.slice(0, 200), unchanged: ['runs', 'balances', 'allowance', 'counters', 'nonce'] };
    });
  }
  const runAttempt = (P, d) => async () => { const c = await programFor(P); await K.writeContract({ address: P, abi: planAbi, functionName: 'run', args: [c.transaction.to, c.transaction.data, permissionContext(d)], gas: 25_000_000n }); };
  // Permission-layer test: call the DelegationManager AS the plan (fork impersonation), bypassing the
  // plan's own period/run checks, to show the enforcers refuse on their own.
  const redeemAs = (P, d, target, data) => async () => {
    await rpc('hardhat_impersonateAccount', [P]); await rpc('hardhat_setBalance', [P, v.toHex(v.parseEther('1'))]);
    try { await F.wallet(P).writeContract({ address: DM, abi: dmAbi, functionName: 'redeemDelegations', args: [[permissionContext(d)], [SINGLE_MODE], [v.encodePacked(['address', 'uint256', 'bytes'], [target, 0n, data])]], gas: 3_000_000n }); }
    finally { await rpc('hardhat_stopImpersonatingAccount', [P]); }
  };
  const transferData = (to, amount) => v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to, amount] });
  async function handle(op) {
    const hash = await K.writeContract({ address: ENTRY_POINT, abi: epAbi, functionName: 'handleOps', args: [[aa.toPackedUserOperation(op)], keeper.address], gas: 3_000_000n }).catch(e => {
      const full = [e?.message, e?.cause?.message, e?.details].join(' '), raw = full.match(/return data: (0x[0-9a-fA-F]+)/)?.[1];
      let decoded = null; if (raw) try { const d = v.decodeErrorResult({ abi: aa.entryPoint07Abi, data: raw }); decoded = `${d.errorName}(${d.args.map(String).join(', ')})`; } catch {}
      const msg = decoded ? 'EntryPoint ' + decoded : redact(reasonOf(e) || e?.message); throw Object.assign(new Error(msg), { shortMessage: msg });
    });
    const r = await client.waitForTransactionReceipt({ hash });
    const ev = v.parseEventLogs({ abi: aa.entryPoint07Abi, logs: r.logs, eventName: 'UserOperationEvent' })[0];
    if (!ev?.args.success) throw new Error('user operation reverted inside the account');
    return { transactionHash: hash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, actualGasCost: ev.args.actualGasCost, userOpHash: ev.args.userOpHash };
  }

  // ---- User lifecycle -------------------------------------------------------------------------
  await at(start);
  await purchase('H-1', 'D1 window 0: purchase with the user-signed periodic permission', CLASS, P1, D1, H1);
  await purchase('H-2', 'D2 window 0: purchase with the second user-signed permission', CLASS, P2, D2, H2);
  await refused('H-3', 'D1 same window: second purchase refused by the plan (NotDue)', CLASS, P1, H1, runAttempt(P1, D1), 'NotDue');
  await refused('H-4', 'D1 same window, plan bypassed: the permission itself refuses (ERC20PeriodTransferEnforcer)', CLASS, P1, H1, redeemAs(P1, D1, USDG, transferData(P1, swap)), 'transfer-amount-exceeded');
  // Cancel with budget left: the signed user operation, first under adverse conditions.
  await check('H-5a', 'cancel op under the mainnet condition (paymaster has no code; deposit and account ETH present): cannot execute, nothing changes', CLASS, async () => {
    const snap = await rpc('evm_snapshot');
    try {
      await edit('TEST_ONLY', 'hardhat_setCode', [PM_STAR, '0x'], 'reverted after this check'); await edit('TEST_ONLY', 'hardhat_setBalance', [SA, v.toHex(v.parseEther('1'))], 'reverted after this check');
      const before = await state(P2, H2); let failed = false; try { await handle(cancelOp); } catch { failed = true; }
      assert(failed, 'executed without paymaster code'); assert.deepEqual(await state(P2, H2), before); return { refused: true };
    } finally { await rpc('evm_revert', [snap]); }
  });
  await check('H-5b', 'cancel op with the paymaster removed or replaced: the same signature no longer validates (AA24)', CLASS, async () => {
    const snap = await rpc('evm_snapshot');
    try {
      await edit('TEST_ONLY', 'hardhat_setBalance', [SA, v.toHex(v.parseEther('1'))], 'reverted after this check');
      const reasons = [];
      for (const variant of [{ paymaster: undefined, paymasterVerificationGasLimit: undefined, paymasterPostOpGasLimit: undefined, paymasterData: undefined }, { paymaster: keyless('another paymaster') }]) {
        let r = ''; try { await handle({ ...cancelOp, ...variant }); } catch (e) { r = e.message; } assert(r.includes('AA24') || r.includes('AA30') || r.includes('AA31') || r.includes('AA33'), r); reasons.push(r);
      }
      assert(reasons[0].includes('AA24'), reasons[0]); return { stripped: reasons[0], replaced: reasons[1] };
    } finally { await rpc('evm_revert', [snap]); }
  });
  const cancelled = await must('H-5c', 'cancel op executes on the fork via EntryPoint.handleOps; the account pays no gas; D2 disabled', CLASS, async () => {
    const before = await state(P2, H2), dep = await read(F, ENTRY_POINT, epAbi, 'balanceOf', [PM_STAR]);
    const r = await handle(cancelOp); const after = await state(P2, H2);
    assert.equal(after.counters.disabled, true); assert.equal(after.accountEth, 0n); assert.equal(after.epNonce, before.epNonce + 1n);
    assert.equal(dep - await read(F, ENTRY_POINT, epAbi, 'balanceOf', [PM_STAR]), r.actualGasCost);
    report.userOps.push({ id: 'CANCEL', ...r }); return r;
  });
  await refused('H-5d', 'replaying the executed cancel op is refused (AA25 nonce)', CLASS, P2, H2, () => handle(cancelOp), 'AA25');
  // The plan needs both a new calendar window and a full period since its own last purchase, so the
  // window-1 purchase happens at whichever comes later (the first purchase landed a few seconds after start).
  const dueAt = async (P, k) => { const last = await read(F, P, planAbi, 'lastExecution'); const w = start + BigInt(k) * plan1.periodSeconds; return last + plan1.periodSeconds > w ? last + plan1.periodSeconds : w; };
  await at(await dueAt(P2, 1));
  await purchase('H-6', 'D1 window 1: second purchase (total reaches the budget)', CLASS, P1, D1, H1);
  await refused('H-7', 'D2 window 1 after cancel: purchase refused (CannotUseADisabledDelegation) while budget remained', CLASS, P2, H2, runAttempt(P2, D2), 'CannotUseADisabledDelegation');
  report.cancelWithBudget = { d2TotalSpent: (await counters(H2)).totalSpent, d2Budget: plan2.totalRaw };
  await at(start + 2n * plan1.periodSeconds);
  await refused('H-8', 'D1 window 2: plan refuses (Inactive: runs/expiry)', CLASS, P1, H1, runAttempt(P1, D1), 'Inactive');
  await refused('H-9', 'D1 window 2, plan bypassed: total budget enforced by the permission (ERC20TransferAmountEnforcer)', CLASS, P1, H1, redeemAs(P1, D1, USDG, transferData(P1, swap)), 'allowance-exceeded');
  await must('H-10', 'withdraw op: remaining USDG returns to the owner EOA via handleOps; account pays no gas', CLASS, async () => {
    const left = await bal(USDG, SA), e0 = await bal(USDG, owner); assert.equal(left, remaining, 'balance differs from the signed withdraw amount');
    const r = await handle(withdrawOp); assert.equal(await bal(USDG, SA), 0n); assert.equal(await bal(USDG, owner) - e0, left); assert.equal(await client.getBalance({ address: SA }), 0n);
    report.userOps.push({ id: 'WITHDRAW', ...r, withdrawnRaw: left }); return { ...r, withdrawnRaw: left };
  });
  await refused('H-11', 'replaying the executed withdraw op is refused (AA25 nonce)', CLASS, P1, H1, () => handle(withdrawOp), 'AA25');
  signer.status('Kullanıcı imzalı yaşam döngüsü bitti; test anahtarı kontrolleri çalışıyor…');

  // ---- Test-key checks (separate account and plans; never the user's) ---------------------------
  const tk = accounts.privateKeyToAccount(accounts.generatePrivateKey());
  const tsa = await kit.toMetaMaskSmartAccount({ client, implementation: kit.Implementation.MultiSig, deployParams: [[tk.address], 1n], deploySalt: '0x', signer: [{ account: tk }] });
  const { factory: tf, factoryData: tfd } = await tsa.getFactoryArgs();
  await client.waitForTransactionReceipt({ hash: await K.sendTransaction({ to: tf, data: tfd, gas: 3_000_000n }) });
  await edit('IMPERSONATE', 'hardhat_impersonateAccount', [USDG_HOLDER], 'test-key account funding'); await edit('HOLDER_GAS', 'hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))], '');
  await client.waitForTransactionReceipt({ hash: await F.wallet(USDG_HOLDER).writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [tsa.address, FUND], gas: 500_000n }) });
  await edit('STOP_IMPERSONATE', 'hardhat_stopImpersonatingAccount', [USDG_HOLDER], '');
  const t0 = await now();
  const tRules = { ...ruleInput, owner: tk.address, fundingAccount: tsa.address, recipient: tk.address, start: { mode: 'at', at: t0 + 60n }, now: t0 };
  const tp = buildDcaPlan({ ...tRules, runs: 3 });
  const tTerms = { ...termsOf(tp), owner: tk.address, source: tsa.address, recipient: tk.address };
  const PT1 = await read(F, F_STAR, factoryAbi, 'predict', [tTerms, profile, 3n]), PT2 = await read(F, F_STAR, factoryAbi, 'predict', [tTerms, profile, 4n]);
  await sendK(F_STAR, factoryAbi, 'deploy', [tTerms, profile, 3n]); await sendK(F_STAR, factoryAbi, 'deploy', [tTerms, profile, 4n]);
  const tSign = async (P, spec, salt) => { const td = delegationTypedData({ delegationManager: DM, delegate: P, delegator: tsa.address, caveats: planCaveats(ENF, spec), salt });
    return delegationStruct(td, await tk.signTypedData(stripEip712Domain(td))); };
  const tSpec = planCaveatSpec(tp, PT1, { maxCalls: tp.runs });
  const T1 = await tSign(PT1, tSpec, 11n), T3 = await tSign(PT1, { ...tSpec, maxCalls: 1n }, 13n), T4 = await tSign(PT1, { ...tSpec, notAfter: tp.startTime + tp.periodSeconds }, 14n);
  const HT1 = await hashOf(T1), HT3 = await hashOf(T3), HT4 = await hashOf(T4);
  await check('P-3', 'explicit Delegation typed data signs to the same signature as Smart Accounts Kit (same account, same delegation)', 'TEST_KEY', async () => {
    const kitSig = await tsa.signDelegation({ delegation: { ...T1, signature: '0x' } });
    assert.equal(kitSig, T1.signature); return { equal: true };
  });
  await at(tp.startTime);
  await check('X-1', 'two keepers in the same block, same window: exactly one purchase; the other reverts; counters move once', 'TEST_KEY', async () => {
    const c = await programFor(PT1), before = await state(PT1, HT1, tsa.address);
    const k2 = accounts.privateKeyToAccount(accounts.generatePrivateKey()); await edit('KEEPER_ETH', 'hardhat_setBalance', [k2.address, v.toHex(v.parseEther('1'))], 'second keeper');
    await rpc('evm_setAutomine', [false]);
    let hashes;
    try {
      hashes = await Promise.all([K, F.wallet(k2)].map(w => w.writeContract({ address: PT1, abi: planAbi, functionName: 'run', args: [c.transaction.to, c.transaction.data, permissionContext(T1)], gas: 25_000_000n })));
      await rpc('evm_mine');
    } finally { await rpc('evm_setAutomine', [true]); }
    const statuses = await Promise.all(hashes.map(h => client.getTransactionReceipt({ hash: h }).then(r => r.status).catch(() => 'not-mined')));
    const after = await state(PT1, HT1, tsa.address);
    assert.equal(statuses.filter(s => s === 'success').length, 1, JSON.stringify(statuses)); assert.equal(after.runs, before.runs + 1n);
    assert.equal(after.counters.totalSpent - before.counters.totalSpent, swap); assert.equal(before.accountUsdg - after.accountUsdg, swap);
    return { statuses };
  });
  await at((await now()) + tp.periodSeconds);
  await check('X-2', 'failed swap (router payload corrupted, plan validation passes): reverts; balances, runs and enforcer counters unchanged', 'TEST_KEY', async () => {
    const good = await programFor(PT1);
    const bad = ops.wire.mutateSwap(good.transaction.data, Number(TD.legs[0].slot), a => { const cd = a[5][1].callData; a[5][1].callData = v.concat([v.slice(cd, 0, 4), '0x' + 'ff'.repeat((cd.length - 10) / 2)]); });
    await read(F, PT1, planAbi, 'validate', [good.transaction.to, bad]);
    const before = await state(PT1, HT1, tsa.address); let reverted = false;
    try { await K.writeContract({ address: PT1, abi: planAbi, functionName: 'run', args: [good.transaction.to, bad, permissionContext(T1)], gas: 25_000_000n }); } catch { reverted = true; }
    assert(reverted); assert.deepEqual(await state(PT1, HT1, tsa.address), before); return { reverted };
  });
  await refused('X-3', 'modified Composer program (a pinned state slot changed): plan validation refuses', 'TEST_KEY', PT1, HT1, async () => {
    const good = await programFor(PT1), x = ops.wire.decode(good.transaction.data);
    const fixed = x.state.findIndex((s, i) => s.length > 2 && i !== Number(TD.signerSlot) && i !== Number(TD.proxyBalanceSlot) && i !== Number(TD.contextSlot) && !TD.legs.some(l => Number(l.slot) === i));
    x.state[fixed] = v.concat([x.state[fixed], '0x00']);
    await K.writeContract({ address: PT1, abi: planAbi, functionName: 'run', args: [good.transaction.to, ops.wire.encode(x), permissionContext(T1)], gas: 25_000_000n });
  }, 'ProfileViolation', tsa.address);
  await refused('X-4', 'wrong plan: another plan presents this permission (InvalidDelegate)', 'TEST_KEY', PT1, HT1, runAttempt(PT2, T1), 'InvalidDelegate', tsa.address);
  await refused('X-5', 'wrong recipient: transfer to an address other than the plan (AllowedCalldataEnforcer)', 'TEST_KEY', PT1, HT1, redeemAs(PT1, T1, USDG, transferData(tk.address, swap)), 'AllowedCalldataEnforcer', tsa.address);
  await refused('X-6', 'wrong token: a different token through the permission (ERC20PeriodTransferEnforcer)', 'TEST_KEY', PT1, HT1, redeemAs(PT1, T1, TD.legs[0].token, transferData(PT1, 1n)), 'ERC20PeriodTransferEnforcer', tsa.address);
  await refused('X-7', 'over-spend: more than the per-period amount (transfer-amount-exceeded)', 'TEST_KEY', PT1, HT1, redeemAs(PT1, T1, USDG, transferData(PT1, tSpec.periodAmount + 1n)), 'transfer-amount-exceeded', tsa.address);
  await check('X-8', 'call-count limit: a permission with maxCalls 1 works once, then LimitedCallsEnforcer refuses', 'TEST_KEY', async () => {
    await redeemAs(PT1, T3, USDG, transferData(PT1, 1_000_000n))(); await at((await now()) + tp.periodSeconds);
    const before = await counters(HT3); let reason = ''; try { await redeemAs(PT1, T3, USDG, transferData(PT1, 1_000_000n))(); } catch (e) { reason = reasonOf(e); }
    assert(reason.includes('limit-exceeded'), reason); assert.deepEqual(await counters(HT3), before); return { reason: reason.slice(0, 120) };
  });
  await check('X-9', 'expired permission: TimestampEnforcer refuses after notAfter', 'TEST_KEY', async () => {
    let reason = ''; try { await redeemAs(PT1, T4, USDG, transferData(PT1, 1_000_000n))(); } catch (e) { reason = reasonOf(e); }
    assert(reason.includes('expired'), reason); return { reason: reason.slice(0, 120), notAfter: tp.startTime + tp.periodSeconds, now: await now() };
  });
  await check('X-10', 'user operation after its paymaster validUntil: refused (AA32), nothing changes', 'TEST_KEY', async () => {
    const op = userOperation({ sender: tsa.address, nonce: await read(F, ENTRY_POINT, epAbi, 'getNonce', [tsa.address, 0n]), callData: executeCallData(USDG, transferData(tk.address, 1n)),
      paymaster: PM_STAR, validUntil: (await now()) + 60n, maxFeePerGas: fee });
    op.signature = await tk.signTypedData(stripEip712Domain(userOpTypedData(op, tsa.address)));
    assert.equal(op.signature, await tsa.signUserOperation({ ...op, chainId: 4663 }), 'typed data differs from Smart Accounts Kit');
    await at((await now()) + 120n);
    const before = await bal(USDG, tsa.address); let reason = ''; try { await handle(op); } catch (e) { reason = e.message; }
    assert(reason.includes('AA32'), reason); assert.equal(await bal(USDG, tsa.address), before); return { reason, kitSignatureEqual: true };
  });
  report.relayFinal = relay.stats;
  const fails = report.checks.filter(c => c.status === 'FAIL').length;
  report.status = fails ? 'FAILED' : 'PASSED'; exitCode = fails ? 1 : 0;
  signer.status(fails ? `Bitti: ${fails} kontrol başarısız. Rapor: ${out}` : `Bitti: bütün kontroller geçti. Rapor: ${out}`);
} catch (e) {
  if (report.status === 'RUNNING') report.status = 'FAILED';
  report.fatal = redact(e?.shortMessage ?? e?.message ?? e); console.log('FATAL', report.fatal);
  try { server?.setStatus('Hata: ' + report.fatal); } catch {}
} finally {
  report.finishedAt = new Date().toISOString();
  report.publicTransactions = { relayRefusedWriteRequests: relay?.stats.refusedRequests ?? null, relayForwardedMethods: relay?.stats.forwardedByMethod ?? null,
    note: 'Every upstream request is checked against a read-only allowlist (single and batch); fork transactions are local and listed under forks[].localTransactions.' };
  report.summary = { pass: report.checks.filter(c => c.status === 'PASS').length, fail: report.checks.filter(c => c.status === 'FAIL').length, purchases: report.purchases.length, userOps: report.userOps.length };
  report.traceLocation = SIGNER === 'wallet' ? 'private folder (traces carry the delegation signatures)' : 'out/traces';
  writeFileSync(join(out, 'results.json'), json(report));
  // Human-signature mode: nothing under --out may contain a signature (the out folder is what gets shared).
  if (SIGNER === 'wallet' && sigFile.length) {
    const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'cache' ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
    const leaks = walk(out).filter(f => { const t = readFileSync(f, 'utf8').toLowerCase(); return sigFile.some(x => t.includes(x.signature.slice(2).toLowerCase())); });
    if (leaks.length) { console.log('FAIL signature found in shareable output: ' + leaks.join(', ')); report.status = 'FAILED'; report.signatureLeak = leaks; exitCode = 1; writeFileSync(join(out, 'results.json'), json(report)); }
    else console.log('PASS no signature in the shareable output folder');
  }
  console.log(`\nSUMMARY status=${report.status} signer=${SIGNER} mode=${MODE} pass=${report.summary.pass} fail=${report.summary.fail} purchases=${report.summary.purchases} userOps=${report.summary.userOps} -> ${out}`);
  try { await F?.close?.(); } catch {}
  try { await relay?.close(); } catch {}
  if (server) await server.close({ keepOpenMs: Number(arg('--keep-open', '15000')) });
  process.exit(exitCode);
}
