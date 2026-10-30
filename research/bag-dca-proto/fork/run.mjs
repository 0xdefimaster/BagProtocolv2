// RESEARCH PROTOTYPE: authorization model comparison on an isolated Robinhood Chain fork.
// Never submits to a public network: the upstream relay forwards read-only methods only.
// Composer is replaced by MockRouter (same approve/transferFrom shape); no API key needed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Usage: node fork/run.mjs [--rpc <url>]   (dependencies from the prototype package.json/lock)
const cli = process.argv.slice(2), upstream = cli.includes('--rpc') ? cli[cli.indexOf('--rpc') + 1] : 'https://rpc.mainnet.chain.robinhood.com';
// MetaMask Smart Accounts Kit sends usage analytics unless DO_NOT_TRACK is set.
process.env.DO_NOT_TRACK ??= '1';
const protoRequire = createRequire(join(here, '..', 'package.json'));
const v = protoRequire('viem');
const { privateKeyToAccount, generatePrivateKey } = protoRequire('viem/accounts');
const aa = protoRequire('viem/account-abstraction');
const kit = protoRequire('@metamask/smart-accounts-kit');
const solc = protoRequire('solc');
const { createHardhatRuntimeEnvironment } = await import(pathToFileURL(protoRequire.resolve('hardhat/hre')));

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const USDG_HOLDER = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const ANY_DELEGATE = '0x0000000000000000000000000000000000000a11';
const U = 1_000_000n;

const cases = [];
const section = name => console.log('\n## ' + name);
async function check(id, name, fn) {
  try { const details = await fn(); cases.push({ id, name, status: 'PASS', details }); console.log(`PASS ${id} ${name}`); }
  catch (e) { cases.push({ id, name, status: 'FAIL', error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 600) }); console.log(`FAIL ${id} ${name}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)}`); }
}
const reasonOf = e => { const parts = []; for (let x = e; x; x = x.cause) parts.push(x.shortMessage, x.details, x.metaMessages?.join(' '), x.data?.errorName, x.reason); return parts.filter(Boolean).join(' | '); };
async function reverts(fn, expected) {
  try { await fn(); } catch (e) {
    const r = reasonOf(e);
    if (expected && !r.includes(expected)) throw new Error(`reverted, but not with "${expected}": ${r.slice(0, 400)}`);
    return { reverted: true, reason: (r.match(new RegExp(expected ?? '.{0,80}'))?.[0]) ?? r.slice(0, 120) };
  }
  throw new Error('expected a revert, call succeeded');
}

// ---- Read-only upstream relay -------------------------------------------------------------
const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'net_version', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs']);
const rejected = [];
const relay = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const calls = [].concat(JSON.parse(body));
  if (calls.some(c => !allowed.has(c.method))) { rejected.push(...calls.map(c => c.method)); res.writeHead(403); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"read-only relay"}}'); return; }
  const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
});
await new Promise(r => relay.listen(0, '127.0.0.1', r));
const relayUrl = 'http://127.0.0.1:' + relay.address().port;
const probe = await fetch(relayUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] }) });
assert.equal(probe.status, 403, 'relay must refuse submission methods');

// ---- Compile prototype contracts ----------------------------------------------------------
const sources = Object.fromEntries(['DcaPlan.sol', 'Mocks.sol'].map(f => [f, { content: readFileSync(join(here, 'contracts', f), 'utf8') }]));
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const errs = (compiled.errors ?? []).filter(e => e.severity === 'error'); if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
const art = n => { for (const f of Object.values(compiled.contracts)) if (f[n]) return { abi: f[n].abi, bytecode: '0x' + f[n].evm.bytecode.object }; throw new Error(n); };

// ---- Fork -------------------------------------------------------------------------------
const upstreamBlock = await fetch(relayUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then(r => r.json());
const forkBlock = BigInt(upstreamBlock.result);
const hre = await createHardhatRuntimeEnvironment({ paths: { cache: join(here, '.cache') }, chainDescriptors: { 4663: { name: 'Robinhood fork (research)', chainType: 'l1', hardforkHistory: { cancun: { blockNumber: 0 } } } },
  networks: { fork: { type: 'edr-simulated', chainId: 4663, chainType: 'l1', hardfork: 'cancun', forking: { url: relayUrl, blockNumber: Number(forkBlock) }, throwOnTransactionFailures: true } } });
const connection = await hre.network.connect('fork');
const chain = v.defineChain({ id: 4663, name: 'ISOLATED Robinhood fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [relayUrl] } } });
const transport = v.custom({ request: x => connection.provider.request(x) });
const client = v.createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 10 });
const rpc = (method, params = []) => client.request({ method, params });

const user = privateKeyToAccount(generatePrivateKey());      // throwaway key, fork only
const keeper = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());
for (const a of [user, keeper, attacker]) await rpc('hardhat_setBalance', [a.address, v.toHex(v.parseEther('10'))]);
const wallet = account => v.createWalletClient({ account, chain, transport });
const W = { user: wallet(user), keeper: wallet(keeper), attacker: wallet(attacker) };
async function send(who, address, abi, functionName, args = []) {
  const hash = await W[who].writeContract({ address, abi, functionName, args, gas: 8_000_000n });
  const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(functionName + ' failed'); return r;
}
async function deploy(who, name, args = []) {
  const { abi, bytecode } = art(name);
  const hash = await W[who].deployContract({ abi, bytecode, args, gas: 12_000_000n });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress;
}
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
const now = async () => (await client.getBlock()).timestamp;
async function setTime(t) { await rpc('evm_setNextBlockTimestamp', [Number(t)]); await rpc('evm_mine', []); }
async function nextTxAt(t) { await rpc('evm_setNextBlockTimestamp', [Number(t)]); }

const erc20 = v.parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function nonces(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function name() view returns (string)', 'function version() view returns (string)',
  'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']);
const bal = (t, a) => read(t, erc20, 'balanceOf', [a]);
const allowanceOf = (o, s) => read(USDG, erc20, 'allowance', [o, s]);

// Fork-only USDG funding from a recorded public holder.
async function fundUsdg(to, amount) {
  await rpc('hardhat_impersonateAccount', [USDG_HOLDER]); await rpc('hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))]);
  const hw = v.createWalletClient({ account: USDG_HOLDER, chain, transport });
  await client.waitForTransactionReceipt({ hash: await hw.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [to, amount], gas: 500000n }) });
  await rpc('hardhat_stopImpersonatingAccount', [USDG_HOLDER]);
}

// ---- Shared deployments ---------------------------------------------------------------------
const planAbi = art('DcaPlan').abi, factoryAbi = art('DcaPlanFactory').abi, routerAbi = art('MockRouter').abi;
const factory = await deploy('keeper', 'DcaPlanFactory');
const mockOut = await deploy('keeper', 'MockOut');
const router = await deploy('keeper', 'MockRouter');
const OUT_PER_RUN = 10n * 10n ** 18n, FLOOR = 9n * 10n ** 18n;
const swapData = gross => v.encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [USDG, gross, mockOut, OUT_PER_RUN] });
const setRouterMode = m => send('keeper', router, routerAbi, 'setMode', [m]);
const PERIOD = 86_400n;
const report = { scope: 'ISOLATED_ROBINHOOD_FORK_AUTHORIZATION_PROTOTYPE', forkBlock: forkBlock.toString(), composer: 'MOCK_ROUTER_NOT_COMPOSER', publicTransactions: 0 };

function terms(over) {
  return { funding: 1, owner: user.address, source: user.address, recipient: user.address, inputToken: USDG, outputToken: mockOut, router,
    delegationManager: v.zeroAddress, definitionHash: v.keccak256(v.toHex('prototype-bag')), grossPerRun: 10n * U, maxRuns: 10n,
    start: 0n, period: PERIOD, expiry: 0n, minOutPerRun: FLOOR, ...over };
}
const predict = (t, n) => read(factory, factoryAbi, 'predict', [t, n]);

// USDG permit domain: verify the name/version a wallet must show match the on-chain separator.
const usdgName = await read(USDG, erc20, 'name'), usdgVersion = await read(USDG, erc20, 'version').catch(() => null);
const onchainSeparator = await read(USDG, erc20, 'DOMAIN_SEPARATOR');
const permitDomain = { name: usdgName, version: usdgVersion ?? '1', chainId: 4663, verifyingContract: USDG };
async function signPermit(spender, value, deadline, nonce) {
  nonce ??= await read(USDG, erc20, 'nonces', [user.address]);
  const sig = await user.signTypedData({ domain: permitDomain, primaryType: 'Permit',
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    message: { owner: user.address, spender, value, nonce, deadline } });
  const { r, s, v: vv } = v.parseSignature(sig); return { value, deadline, v: Number(vv ?? 27n), r, s };
}

// =========================================================================================
section('Model A: EOA + USDG permit');
await fundUsdg(user.address, 1000n * U);
const userNonceStart = await client.getTransactionCount({ address: user.address });

await check('A-0', 'USDG EIP-712 domain (name/version) reproduces the on-chain DOMAIN_SEPARATOR', async () => {
  const computed = v.hashDomain({ domain: permitDomain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } });
  assert.equal(computed, onchainSeparator); return { name: usdgName, version: usdgVersion, separator: onchainSeparator };
});

let t0 = await now();
const tA = terms({ start: t0 + 3600n, expiry: t0 + 3600n + PERIOD * 11n });
const planA = await predict(tA, 1n);
await check('A-1', 'setup = 1 user signature, 0 user transactions; keeper deploys the CREATE2 plan and submits the permit', async () => {
  const p = await signPermit(planA, 100n * U, t0 + 7200n);
  await send('keeper', factory, factoryAbi, 'deployWithPermit', [tA, 1n, p.value, p.deadline, p.v, p.r, p.s]);
  assert.equal(await allowanceOf(user.address, planA), 100n * U);
  assert.equal(await client.getTransactionCount({ address: user.address }), userNonceStart);
  assert.equal(await read(planA, planAbi, 'owner'), user.address);
  return { plan: planA, userSignatures: 1, userTransactions: 0, keeperTransactions: 1 };
});

await check('A-2', 'run 1: pull 10 USDG, swap, deliver output to the user in one transaction', async () => {
  await nextTxAt(tA.start);
  const u0 = await bal(USDG, user.address), o0 = await bal(mockOut, user.address);
  await send('keeper', planA, planAbi, 'run', [swapData(10n * U), '0x']);
  assert.equal(u0 - await bal(USDG, user.address), 10n * U);
  assert.equal(await bal(mockOut, user.address) - o0, OUT_PER_RUN);
  assert.equal(await bal(USDG, planA), 0n); assert.equal(await bal(mockOut, planA), 0n);
  assert.equal(await allowanceOf(user.address, planA), 90n * U);
  assert.equal(await read(USDG, erc20, 'allowance', [planA, router]), 0n);
  return { allowanceAfter: '90 USDG', planResidue: 0 };
});
await check('A-3', 'a second run in the same window is refused (NotDue)', async () => reverts(() => send('keeper', planA, planAbi, 'run', [swapData(10n * U), '0x']), 'NotDue'));

async function snapshotA(plan) { return { usdg: await bal(USDG, user.address), out: await bal(mockOut, user.address), allowance: await allowanceOf(user.address, plan), runs: await read(plan, planAbi, 'runs') }; }
await check('A-4', 'failed swap reverts the pull, approvals and counters', async () => {
  await setTime(tA.start + PERIOD);
  const before = await snapshotA(planA);
  await setRouterMode(1);
  const r1 = await reverts(() => send('keeper', planA, planAbi, 'run', [swapData(10n * U), '0x']), 'swap failed');
  await setRouterMode(2);
  const r2 = await reverts(() => send('keeper', planA, planAbi, 'run', [swapData(10n * U), '0x']), 'OutputMinimum');
  await setRouterMode(0);
  assert.deepEqual(await snapshotA(planA), before);
  assert.equal(await read(USDG, erc20, 'allowance', [planA, router]), 0n);
  return { routerRevert: r1.reason, underDelivery: r2.reason, stateUnchanged: true };
});
await check('A-5', 'run 2 succeeds after the failed attempts', async () => { await send('keeper', planA, planAbi, 'run', [swapData(10n * U), '0x']); assert.equal(await read(planA, planAbi, 'runs'), 2n); });

await check('A-6', 'permit front-run by a third party does not block setup (nonce consumed, allowance checked)', async () => {
  t0 = await now();
  const t = terms({ start: t0 + 3600n, expiry: t0 + 3600n + PERIOD * 11n }), plan = await predict(t, 2n);
  const p = await signPermit(plan, 100n * U, t0 + 7200n);
  await send('attacker', USDG, erc20, 'permit', [user.address, plan, p.value, p.deadline, p.v, p.r, p.s]);
  await send('keeper', factory, factoryAbi, 'deployWithPermit', [t, 2n, p.value, p.deadline, p.v, p.r, p.s]);
  assert.equal(await allowanceOf(user.address, plan), 100n * U); return { plan };
});

// V-A3 / V-A4: approve(0) is not cancellation.
t0 = await now();
const tC = terms({ start: t0 + 60n, expiry: t0 + 60n + PERIOD * 11n });
const planC = await predict(tC, 3n);
const pC1 = await signPermit(planC, 100n * U, t0 + 7n * 86400n);
const pC2 = await signPermit(planC, 100n * U, t0 + 7n * 86400n, (await read(USDG, erc20, 'nonces', [user.address])) + 1n); // a second, still-unsubmitted signature
await send('keeper', factory, factoryAbi, 'deployWithPermit', [tC, 3n, pC1.value, pC1.deadline, pC1.v, pC1.r, pC1.s]);
await check('A-7', 'approve(plan, 0) stops spending', async () => {
  await send('user', USDG, erc20, 'approve', [planC, 0n]); await setTime(tC.start);
  return reverts(() => send('keeper', planC, planAbi, 'run', [swapData(10n * U), '0x']));
});
await check('A-8', 'HAZARD: an unused permit submitted after approve(0) restores the allowance and the plan runs again', async () => {
  await send('attacker', USDG, erc20, 'permit', [user.address, planC, pC2.value, pC2.deadline, pC2.v, pC2.r, pC2.s]);
  assert.equal(await allowanceOf(user.address, planC), 100n * U);
  await send('keeper', planC, planAbi, 'run', [swapData(10n * U), '0x']);
  return { conclusion: 'approve(0) alone is not a cancellation' };
});
await check('A-9', 'V-A3: after cancel(), the plan refuses to run although an allowance exists', async () => {
  await send('user', planC, planAbi, 'cancel'); await setTime(tC.start + PERIOD);
  assert(await allowanceOf(user.address, planC) > 0n);
  return reverts(() => send('keeper', planC, planAbi, 'run', [swapData(10n * U), '0x']), 'Inactive');
});
await check('A-10', 'V-A4: re-approving a cancelled plan does not revive it', async () => {
  await send('user', USDG, erc20, 'approve', [planC, 1000n * U]);
  return reverts(() => send('keeper', planC, planAbi, 'run', [swapData(10n * U), '0x']), 'Inactive');
});
await check('A-11', 'only the owner can cancel (plan and factory)', async () => {
  const a = await reverts(() => send('attacker', planA, planAbi, 'cancel'), 'Denied');
  const b = await reverts(() => send('attacker', factory, factoryAbi, 'cancel', [tA, 1n]), 'Denied');
  return { plan: a.reason, factory: b.reason };
});
await check('A-12', 'V-A5: an undeployed plan cancelled in the factory cannot be deployed, even after its permit is submitted', async () => {
  t0 = await now();
  const t = terms({ start: t0 + 60n, expiry: t0 + 60n + PERIOD * 11n }), plan = await predict(t, 4n);
  const p = await signPermit(plan, 100n * U, t0 + 7200n);
  await send('user', factory, factoryAbi, 'cancel', [t, 4n]);
  const a = await reverts(() => send('keeper', factory, factoryAbi, 'deployWithPermit', [t, 4n, p.value, p.deadline, p.v, p.r, p.s]), 'Cancelled');
  await send('attacker', USDG, erc20, 'permit', [user.address, plan, p.value, p.deadline, p.v, p.r, p.s]);
  const b = await reverts(() => send('keeper', factory, factoryAbi, 'deploy', [t, 4n]), 'Cancelled');
  assert.equal(await client.getCode({ address: plan }) ?? '0x', '0x');
  return { deployWithPermit: a.reason, deployAfterPermit: b.reason, code: 'none' };
});
await check('A-13', 'completion: allowance reaches 0 after the last run; further runs are refused', async () => {
  t0 = await now();
  const t = terms({ start: t0 + 60n, maxRuns: 2n, expiry: t0 + 60n + PERIOD * 3n }), plan = await predict(t, 5n);
  const p = await signPermit(plan, 20n * U, t0 + 7200n);
  await send('keeper', factory, factoryAbi, 'deployWithPermit', [t, 5n, p.value, p.deadline, p.v, p.r, p.s]);
  await setTime(t.start); await send('keeper', plan, planAbi, 'run', [swapData(10n * U), '0x']);
  await setTime(t.start + PERIOD); await send('keeper', plan, planAbi, 'run', [swapData(10n * U), '0x']);
  assert.equal(await allowanceOf(user.address, plan), 0n);
  await setTime(t.start + 2n * PERIOD);
  return reverts(() => send('keeper', plan, planAbi, 'run', [swapData(10n * U), '0x']), 'Inactive');
});

// =========================================================================================
section('Model B: MetaMask MultiSig smart account + delegation');
const env = kit.getSmartAccountsEnvironment(4663);
const DM = env.DelegationManager, E = env.caveatEnforcers;
const dmAbi = v.parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])', 'function disableDelegation((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))',
  'function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)) pure returns (bytes32)', 'function disabledDelegations(bytes32) view returns (bool)', 'error InvalidDelegate()', 'error InvalidDelegator()', 'error CannotUseADisabledDelegation()', 'error InvalidAuthority()', 'error AlreadyDisabled()']);
const periodAbi = v.parseAbi(['function periodicAllowances(address,bytes32) view returns (uint256 periodAmount,uint256 periodDuration,uint256 startDate,uint256 lastTransferPeriod,uint256 transferredInCurrentPeriod)']);
const spentAbi = v.parseAbi(['function spentMap(address,bytes32) view returns (uint256)']);
const callsAbi = v.parseAbi(['function callCounts(address,bytes32) view returns (uint256)']);
const delegationType = { type: 'tuple[]', components: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
  { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] };
const ctx = (...ds) => v.encodeAbiParameters([delegationType], [ds]);
const C = {
  period: (amount, duration, start) => ({ enforcer: E.ERC20PeriodTransferEnforcer, terms: v.encodePacked(['address', 'uint256', 'uint256', 'uint256'], [USDG, amount, duration, start]), args: '0x' }),
  total: max => ({ enforcer: E.ERC20TransferAmountEnforcer, terms: v.encodePacked(['address', 'uint256'], [USDG, max]), args: '0x' }),
  calls: n => ({ enforcer: E.LimitedCallsEnforcer, terms: v.encodePacked(['uint256'], [n]), args: '0x' }),
  time: (after, before) => ({ enforcer: E.TimestampEnforcer, terms: v.encodePacked(['uint128', 'uint128'], [after, before]), args: '0x' }),
  redeemer: (...rs) => ({ enforcer: E.RedeemerEnforcer, terms: v.concat(rs), args: '0x' }),
  recipient: to => ({ enforcer: E.AllowedCalldataEnforcer, terms: v.concat([v.toHex(4n, { size: 32 }), v.pad(to, { size: 32 })]), args: '0x' }),
};
const transferExec = (to, amount) => v.encodePacked(['address', 'uint256', 'bytes'], [USDG, 0n, v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to, amount] })]);
const SINGLE = v.zeroHash, BATCH = '0x0100000000000000000000000000000000000000000000000000000000000000';

const sa = await kit.toMetaMaskSmartAccount({ client, implementation: kit.Implementation.MultiSig, deployParams: [[user.address], 1n], deploySalt: '0x', signer: [{ account: user }] });
const userTxBeforeB = await client.getTransactionCount({ address: user.address });
async function signDelegation(d) { return { ...d, signature: await sa.signDelegation({ delegation: d }) }; }
const delegationHash = d => read(DM, dmAbi, 'getDelegationHash', [d]);

await check('B-0', 'smart account (MultiSig, signer = user EOA) is deployed by the keeper without a user signature', async () => {
  const { factory: f, factoryData } = await sa.getFactoryArgs();
  await client.waitForTransactionReceipt({ hash: await W.keeper.sendTransaction({ to: f, data: factoryData, gas: 3_000_000n }) });
  assert((await client.getCode({ address: sa.address }))?.length > 2);
  return { account: sa.address, implementation: 'MultiSigDeleGator v1.3.0 (bytecode verified)', factory: f };
});
await check('B-1', 'user funds the smart account with 100 USDG (1 user transaction)', async () => {
  await send('user', USDG, erc20, 'transfer', [sa.address, 100n * U]); assert.equal(await bal(USDG, sa.address), 100n * U);
});

t0 = await now();
const tB = terms({ funding: 2, source: sa.address, delegationManager: DM, start: t0 + 3600n, expiry: t0 + 3600n + PERIOD * 11n });
const planB = await predict(tB, 10n);
await send('keeper', factory, factoryAbi, 'deploy', [tB, 10n]);
const dB = await signDelegation({ delegate: planB, delegator: sa.address, authority: ROOT_AUTHORITY, salt: 1n, signature: '0x',
  caveats: [C.period(10n * U, PERIOD, tB.start), C.total(100n * U), C.calls(10n), C.time(tB.start - 1n, tB.expiry), C.redeemer(planB), C.recipient(planB)] });
const hB = await delegationHash(dB);
const enforcerState = async h => ({ period: (await read(E.ERC20PeriodTransferEnforcer, periodAbi, 'periodicAllowances', [DM, h]))[4], spent: await read(E.ERC20TransferAmountEnforcer, spentAbi, 'spentMap', [DM, h]), calls: await read(E.LimitedCallsEnforcer, callsAbi, 'callCounts', [DM, h]) });
await check('B-2', 'setup totals: user = 1 transaction + 1 delegation signature; keeper = account deploy + plan deploy', async () => {
  assert.equal(await client.getTransactionCount({ address: user.address }) - userTxBeforeB, 1);
  return { userTransactions: 1, userSignatures: 1, keeperTransactions: 2, delegationHash: hB };
});
await check('B-3', 'run 1: redeem transfer(plan, 10), swap, deliver output to the user in one transaction', async () => {
  await nextTxAt(tB.start);
  const s0 = await bal(USDG, sa.address), o0 = await bal(mockOut, user.address);
  await send('keeper', planB, planAbi, 'run', [swapData(10n * U), ctx(dB)]);
  assert.equal(s0 - await bal(USDG, sa.address), 10n * U); assert.equal(await bal(mockOut, user.address) - o0, OUT_PER_RUN);
  const st = await enforcerState(hB); assert.deepEqual(st, { period: 10n * U, spent: 10n * U, calls: 1n });
  assert.equal(await read(USDG, erc20, 'allowance', [sa.address, router]), 0n);
  return { enforcers: { periodTransferred: '10 USDG', totalSpent: '10 USDG', calls: 1 }, accountApprovals: 0 };
});
await check('B-4', 'failed swap reverts the delegated transfer and every enforcer counter', async () => {
  await setTime(tB.start + PERIOD);
  const before = { sa: await bal(USDG, sa.address), runs: await read(planB, planAbi, 'runs'), enf: await enforcerState(hB) };
  await setRouterMode(1); const r1 = await reverts(() => send('keeper', planB, planAbi, 'run', [swapData(10n * U), ctx(dB)]), 'swap failed');
  await setRouterMode(2); const r2 = await reverts(() => send('keeper', planB, planAbi, 'run', [swapData(10n * U), ctx(dB)]), 'OutputMinimum');
  await setRouterMode(0);
  assert.deepEqual({ sa: await bal(USDG, sa.address), runs: await read(planB, planAbi, 'runs'), enf: await enforcerState(hB) }, before);
  return { routerRevert: r1.reason, underDelivery: r2.reason, stateUnchanged: true };
});
await check('B-5', 'plan boundary guard: a run at the last second of a window blocks a run at the first second of the next', async () => {
  const w2end = tB.start + 2n * PERIOD - 1n;
  await nextTxAt(w2end); await send('keeper', planB, planAbi, 'run', [swapData(10n * U), ctx(dB)]);
  await nextTxAt(w2end + 1n);
  return reverts(() => send('keeper', planB, planAbi, 'run', [swapData(10n * U), ctx(dB)]), 'NotDue');
});
await check('V-B1(f1)', 'the plan delegation cannot be redeemed by anyone but the plan (InvalidDelegate)', async () =>
  reverts(() => send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(dB)], [SINGLE], [transferExec(planB, 10n * U)]]), 'InvalidDelegate'));

// Cancellation and withdrawal through user operations, submitted by the keeper as its own bundler.
const EP = env.EntryPoint ?? '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const epAbi = v.parseAbi(['function getNonce(address,uint192) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
async function userOp(calls, label) {
  const nonce = await read(EP, epAbi, 'getNonce', [sa.address, 0n]);
  const block = await client.getBlock();
  const op = { sender: sa.address, nonce, callData: await sa.encodeCalls(calls), callGasLimit: 500_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n,
    maxFeePerGas: (block.baseFeePerGas ?? 1n) * 2n + 1n, maxPriorityFeePerGas: 1n, signature: '0x' };
  op.signature = await sa.signUserOperation({ ...op, chainId: 4663 });
  const packed = aa.toPackedUserOperation(op);
  const hash = await W.keeper.writeContract({ address: EP, abi: aa.entryPoint07Abi, functionName: 'handleOps', args: [[packed], keeper.address], gas: 3_000_000n });
  const r = await client.waitForTransactionReceipt({ hash });
  const ev = v.parseEventLogs({ abi: aa.entryPoint07Abi, logs: r.logs, eventName: 'UserOperationEvent' })[0];
  if (!ev?.args.success) throw new Error(label + ': user operation failed');
  return { actualGasCost: ev.args.actualGasCost };
}
await check('B-6', 'a userOp needs gas: without ETH in the account (no paymaster) it is refused', async () =>
  reverts(() => userOp([{ to: DM, data: v.encodeFunctionData({ abi: dmAbi, functionName: 'disableDelegation', args: [dB] }) }], 'unfunded'), 'AA21'));
await rpc('hardhat_setBalance', [sa.address, v.toHex(v.parseEther('0.01'))]);
await check('B-7', 'cancel: user-signed userOp disables the plan delegation; the plan can no longer pull funds', async () => {
  const g = await userOp([{ to: DM, data: v.encodeFunctionData({ abi: dmAbi, functionName: 'disableDelegation', args: [dB] }) }], 'disable');
  assert.equal(await read(DM, dmAbi, 'disabledDelegations', [hB]), true);
  await setTime(tB.start + 3n * PERIOD);
  // 0x05baa052 = CannotUseADisabledDelegation(), bubbled up from DelegationManager through the plan
  const r = await reverts(() => send('keeper', planB, planAbi, 'run', [swapData(10n * U), ctx(dB)]), '0x05baa052');
  return { gasCostWei: g.actualGasCost.toString(), runAfterDisable: r.reason };
});
// A deliberately over-trusting "test" delegation whose delegate is an EOA: models a buggy or
// compromised redeemer, to show what the enforcers alone still guarantee.
t0 = await now();
const tStart = t0 + 10n;
const dT = await signDelegation({ delegate: keeper.address, delegator: sa.address, authority: ROOT_AUTHORITY, salt: 2n, signature: '0x',
  caveats: [C.period(10n * U, PERIOD, tStart), C.recipient(keeper.address), C.total(30n * U), C.time(tStart - 1n, tStart + 10n * PERIOD)] });
const redeemT = (exec, mode = SINGLE) => send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(dT)], [mode], [exec]]);
await setTime(tStart);
await check('V-B1(a)', 'approve through the delegation is rejected by ERC20PeriodTransferEnforcer (invalid-method)', async () =>
  reverts(() => redeemT(v.encodePacked(['address', 'uint256', 'bytes'], [USDG, 0n, v.encodeFunctionData({ abi: erc20, functionName: 'approve', args: [keeper.address, 10n * U] })])), 'invalid-method'));
await check('V-B1(b)', 'batch execution mode is rejected', async () => {
  const batch = v.encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }],
    [[{ target: USDG, value: 0n, callData: v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [keeper.address, 1n] }) }]]);
  return reverts(() => redeemT(batch, BATCH), 'CaveatEnforcer:invalid-call-type');
});
await check('V-B1(c)', 'transfer(allowed recipient, 10) passes', async () => { await redeemT(transferExec(keeper.address, 10n * U)); });
await check('V-B1(d)', 'a second transfer in the same period is rejected (transfer-amount-exceeded)', async () => reverts(() => redeemT(transferExec(keeper.address, 1n)), 'transfer-amount-exceeded'));
await check('V-B1(e)', 'transfer to another recipient is rejected (AllowedCalldataEnforcer)', async () => {
  await setTime(tStart + PERIOD); return reverts(() => redeemT(transferExec(attacker.address, 10n * U)), 'AllowedCalldataEnforcer:invalid-calldata');
});
await check('V-B1(i)', 'BOUNDARY: the enforcer alone allows 10 at the last second of a period and 10 at the next second (20 within 1 s)', async () => {
  const end = tStart + 2n * PERIOD - 1n;
  await nextTxAt(end); await redeemT(transferExec(keeper.address, 10n * U));
  await nextTxAt(end + 1n); await redeemT(transferExec(keeper.address, 10n * U));
  return { transferredWithin1s: '20 USDG', note: 'only the plan contract guard (B-5) prevents this; enforcers do not' };
});
await check('V-B1(g1)', 'total budget is enforced (ERC20TransferAmountEnforcer allowance-exceeded at 30)', async () => {
  await setTime(tStart + 3n * PERIOD); return reverts(() => redeemT(transferExec(keeper.address, 1n)), 'allowance-exceeded');
});
await check('V-B1(g2)', 'call count is enforced (LimitedCallsEnforcer)', async () => {
  const d = await signDelegation({ delegate: keeper.address, delegator: sa.address, authority: ROOT_AUTHORITY, salt: 3n, signature: '0x', caveats: [C.calls(1n), C.recipient(keeper.address)] });
  await send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(d)], [SINGLE], [transferExec(keeper.address, 1n)]]);
  return reverts(() => send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(d)], [SINGLE], [transferExec(keeper.address, 1n)]]), 'limit-exceeded');
});
await check('V-B1(f2)', 'open delegation (ANY_DELEGATE) restricted by RedeemerEnforcer rejects other redeemers', async () => {
  const d = await signDelegation({ delegate: ANY_DELEGATE, delegator: sa.address, authority: ROOT_AUTHORITY, salt: 4n, signature: '0x', caveats: [C.redeemer(planB), C.recipient(planB)] });
  return reverts(() => send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(d)], [SINGLE], [transferExec(planB, 1n)]]), 'unauthorized-redeemer');
});
await check('V-B1(h1)', 'after the Timestamp threshold the delegation is rejected (expired-delegation)', async () => {
  const t = await now();
  const d = await signDelegation({ delegate: keeper.address, delegator: sa.address, authority: ROOT_AUTHORITY, salt: 5n, signature: '0x', caveats: [C.time(t - 1n, t + 100n), C.recipient(keeper.address)] });
  await send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(d)], [SINGLE], [transferExec(keeper.address, 1n)]]);
  await setTime(t + 101n);
  return reverts(() => send('keeper', DM, dmAbi, 'redeemDelegations', [[ctx(d)], [SINGLE], [transferExec(keeper.address, 1n)]]), 'expired-delegation');
});

await check('B-8', 'withdraw: user-signed userOp returns the remaining USDG to the user EOA', async () => {
  const left = await bal(USDG, sa.address), e0 = await bal(USDG, user.address);
  await userOp([{ to: USDG, data: v.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [user.address, left] }) }], 'withdraw');
  assert.equal(await bal(USDG, sa.address), 0n); assert.equal(await bal(USDG, user.address) - e0, left);
  return { withdrawn: v.formatUnits(left, 6) + ' USDG' };
});

// =========================================================================================
report.relayRejectedMethods = [...new Set(rejected)];
report.summary = { pass: cases.filter(c => c.status === 'PASS').length, fail: cases.filter(c => c.status === 'FAIL').length };
report.cases = cases;
mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'results.json'), JSON.stringify(report, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2));
console.log(`\nSUMMARY pass=${report.summary.pass} fail=${report.summary.fail}`);
relay.close(); await connection.close?.();
process.exit(report.summary.fail ? 1 : 0);
