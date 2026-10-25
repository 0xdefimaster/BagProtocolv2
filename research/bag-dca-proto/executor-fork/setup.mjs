// Shared setup for the RecurringPurchaseExecutor fork runs (executor-fork/run.mjs, test keys; executor-wallet/run.mjs,
// a real wallet's signatures). One place decides which build is used, which real contracts are touched and every
// fork-only state edit, so both runs deploy and check exactly the same way.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { v, accounts, startRelay, createFork, compileProto, json, CHAIN_ID } from '../lib/fork-env.mjs';

// ---- Real Robinhood Chain contracts (lib/config/robinhood-chain.ts; STRATEGY_REGISTRY_DESIGN.md §0)
export const USDG = v.getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
export const USDG_HOLDER = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
export const SWAP_ROUTER02 = v.getAddress('0xCaf681a66D020601342297493863E78C959E5cb2');
export const QUOTER_V2 = v.getAddress('0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7');
export const UNIVERSAL_ROUTER = v.getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904');
export const BAG_FACTORY = v.getAddress('0x7ce5a81df434755f38cb5f67ad49a8bb3c8e6f72');
export const STRATEGY_REGISTRY = v.getAddress('0x907cc27d644c8ea1c24b8320ad09ecf2819209a8');
/** Creator of both fixture BAGs (read only; never a signer here). */
export const BAG_CREATOR = '0xb193DE199EeB9bd1143607a11AD00999Ceb956b8';
/** The chain label of the composition rows (`robinhood:<address>:<symbol>:<decimals>:<weightBps>`), as the BAG app registers them. */
export const CHAIN_LABEL = 'robinhood';
/** No key and no deployer can produce this address: an authorization for it cannot be used on 4663. */
export const KEYLESS_LABEL = 'BAG RecurringPurchaseExecutor fork-only v1';
export const EXECUTOR = v.getAddress(v.slice(v.keccak256(v.toHex(KEYLESS_LABEL)), 12));
export const DEP = Object.freeze({ chainId: CHAIN_ID, executor: EXECUTOR.toLowerCase() });
export const DAY = 86_400n;
export const USDG_UNIT = 1_000_000n;
export const PRUNED_RE = /historical state|missing trie node|state.{0,20}not available|header not found|state histories/i;

export const erc20 = v.parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function nonces(address) view returns (uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)']);
// OpenZeppelin errors, plus the custom errors of the USDG implementation observed on 4663 (selectors 0x13be252b, 0x8baa579f, 0xf4d678b8).
export const ERC20_ERRORS = v.parseAbi(['error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)', 'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)', 'error SafeERC20FailedOperation(address token)',
  'error InsufficientAllowance()', 'error InvalidSignature()', 'error InsufficientBalance()']);
const bagAbi = v.parseAbi(['function version() view returns (uint256)', 'function compositionHash() view returns (bytes32)']);
const regAbi = v.parseAbi(['function deriveStrategyId(address,bytes32) pure returns (bytes32)', 'function isRegistered(bytes32) view returns (bool)', 'function matches(bytes32,uint32,bytes32) view returns (bool)']);
const factoryAbi = v.parseAbi(['function bagOf(bytes32) view returns (address)', 'function deriveBagId(address,bytes32) pure returns (bytes32)']);
const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

const sha256 = s => createHash('sha256').update(s).digest('hex');
export const redact = x => String(x).replace(/https?:\/\/[^\s"'<>]+/g, '<url>').replace(/[A-Za-z0-9_-]{32,}/g, m => (/^0x[0-9a-fA-F]+$/.test(m) ? m : '<redacted>')).slice(0, 600);

/** Every JS fetch may reach only the relay (127.0.0.1) and its upstream RPC host. Composer/LI.FI attempts are counted and refused. */
export function installNetworkGuard(rpcUrl) {
  const rpcHost = new URL(rpcUrl).hostname;
  const network = { allowedHosts: [rpcHost, '127.0.0.1'], requestsByHost: {}, refused: [], composerOrLifiRequests: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
    const key = host === rpcHost ? 'upstream-rpc' : host;
    network.requestsByHost[key] = (network.requestsByHost[key] ?? 0) + 1;
    if (/li\.quest|lifi|composer/i.test(url.hostname)) network.composerOrLifiRequests++;
    if (!network.allowedHosts.includes(host)) { network.refused.push(host); throw new Error('NETWORK_GUARD: refused ' + host); }
    return realFetch(input, init);
  };
  return network;
}

export class UsageError extends Error {}

/** The app build this run uses. Artifacts must come from the checked-out sources (own file + relative imports). */
export async function loadBuild(app) {
  const git = (...a) => { const r = spawnSync('git', ['-C', app, ...a], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  function artifact(rel, name) {
    const a = JSON.parse(readFileSync(join(app, 'artifacts', rel, name + '.json'), 'utf8'));
    const bi = JSON.parse(readFileSync(join(app, 'artifacts', 'build-info', a.buildInfoId + '.json'), 'utf8'));
    const deps = new Set([a.inputSourceName]), queue = [a.inputSourceName];
    while (queue.length) {
      const k = queue.pop();
      for (const m of (bi.input.sources[k]?.content ?? '').matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g)) {
        if (!m[1].startsWith('.')) continue;
        const r = posix.normalize(posix.join(posix.dirname(k), m[1]));
        if (!deps.has(r)) { deps.add(r); queue.push(r); }
      }
    }
    for (const k of deps) {
      if (!k.startsWith('project/')) continue;
      if (!bi.input.sources[k] || readFileSync(join(app, k.slice('project/'.length)), 'utf8') !== bi.input.sources[k].content) throw new UsageError(`stale build: ${k} differs from the build-info of ${name}; run the Hardhat build`);
    }
    return { abi: a.abi, bytecode: a.bytecode, deployedBytecode: a.deployedBytecode, immutableReferences: a.immutableReferences ?? {},
      provenance: { source: rel, checkedSources: [...deps].filter(k => k.startsWith('project/')), sourceSha256: sha256(readFileSync(join(app, rel), 'utf8')), buildInfoId: a.buildInfoId, solc: bi.solcLongVersion, optimizer: bi.input.settings.optimizer, evmVersion: bi.input.settings.evmVersion ?? 'default' } };
  }
  const execArt = artifact('contracts/dca/RecurringPurchaseExecutor.sol', 'RecurringPurchaseExecutor');
  const routerArt = artifact('contracts/BagExecutionRouter.sol', 'BagExecutionRouter');
  const sdkDist = join(app, 'packages/bag-sdk/dist');
  for (const f of ['index.js', 'recurring.js', 'adapters/uniswap-v3.js', 'adapters/evm.js']) if (!existsSync(join(sdkDist, f))) throw new UsageError(`SDK not built (${join(sdkDist, f)}); run npm run build in packages/bag-sdk`);
  const sdk = await import(pathToFileURL(join(sdkDist, 'index.js')).href);
  const uni = await import(pathToFileURL(join(sdkDist, 'adapters/uniswap-v3.js')).href);
  const evm = await import(pathToFileURL(join(sdkDist, 'adapters/evm.js')).href);
  const fixture = name => JSON.parse(readFileSync(join(app, 'packages/bag-sdk/test/fixtures', name + '.bag.json'), 'utf8'));
  const build = { appCommit: git('rev-parse', 'HEAD'), appDirtyInContractsOrSdk: git('status', '--porcelain', '--', 'contracts', 'packages/bag-sdk/src', 'lib/dca') || '', executor: execArt.provenance, router: routerArt.provenance,
    sdk: { dist: 'packages/bag-sdk/dist', recurringJsSha256: sha256(readFileSync(join(sdkDist, 'recurring.js'))), uniswapV3JsSha256: sha256(readFileSync(join(sdkDist, 'adapters/uniswap-v3.js'))) } };
  const ERROR_ABI = [...execArt.abi, ...routerArt.abi, ...ERC20_ERRORS].filter(x => x.type === 'error');
  const CALL_ABI = [...execArt.abi, ...ERROR_ABI.filter(e => !execArt.abi.some(x => x.type === 'error' && x.name === e.name))];
  return { execArt, routerArt, sdk, uni, evm, build, ERROR_ABI, CALL_ABI,
    BAG1: fixture('robinhood-955df6e0-b6ea-44ba-a5eb-1288a80c0a06'), BAG2: fixture('robinhood-a3caff05-d606-486b-959f-30865a4cbfa7') };
}

/**
 * Relay → keyless check on 4663 → fork → fork-only edits → BagExecutionRouter (real BagFactory, test owner/planSigner) and the
 * executor at the keyless address (real BagFactory + StrategyRegistry). `fund` maps a role to the USDG it gets on the fork.
 */
export async function startExecutorFork({ rpcUrl, out, label, build, roleNames, fund = {}, extraAccounts = [] }) {
  const { execArt, routerArt, sdk, BAG1, BAG2 } = build;
  const relay = await startRelay(rpcUrl);
  const remote = v.createPublicClient({ chain: v.defineChain({ id: CHAIN_ID, name: 'relay', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [relay.url] } } }), transport: v.http(relay.url) });
  const keyless = { label: KEYLESS_LABEL, address: EXECUTOR, mainnetCode: (await remote.getCode({ address: EXECUTOR })) ?? '0x', mainnetNonce: await remote.getTransactionCount({ address: EXECUTOR }) };
  if (keyless.mainnetCode !== '0x' || keyless.mainnetNonce !== 0) throw new Error('keyless executor address is in use on 4663: ' + json(keyless));
  const F = await createFork({ relayUrl: relay.url, out, label });
  const client = F.client, rpc = F.rpc;
  await rpc('evm_mine'); // EDR needs one local block before eth_call (the forked Orbit header has no excess_blob_gas)
  const read = (address, abi, functionName, a = []) => client.readContract({ address, abi, functionName, args: a });
  const bal = (t, a) => read(t, erc20, 'balanceOf', [a]);
  const keys = Object.fromEntries(['planSigner', 'routerOwner', 'deployer', ...roleNames].map(k => [k, accounts.privateKeyToAccount(accounts.generatePrivateKey())]));
  const W = Object.fromEntries(Object.entries(keys).map(([k, a]) => [k, F.wallet(a)]));
  const roles = Object.fromEntries(Object.entries(keys).map(([k, a]) => [k, a.address]));
  const send = async (w, address, abi, functionName, a = [], gas = 3_000_000n) => {
    const hash = await w.writeContract({ address, abi, functionName, args: a, gas });
    const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(functionName + ' failed'); return r;
  };

  const { art } = compileProto(['composer/contracts/LocalArbSysRead.sol']);
  await F.edit('ARBSYS', 'hardhat_setCode', ['0x0000000000000000000000000000000000000064', art('LocalArbSysRead').runtime], 'ArbSys read emulation (Nitro precompile is not in EDR)');
  for (const a of Object.values(roles)) await F.edit('GAS', 'hardhat_setBalance', [a, v.toHex(v.parseEther('10'))], 'fork-only gas for a local test account');
  await F.edit('IMPERSONATE', 'hardhat_impersonateAccount', [USDG_HOLDER], 'USDG for test accounts from a real holder balance (fork only)');
  await F.edit('GAS', 'hardhat_setBalance', [USDG_HOLDER, v.toHex(v.parseEther('1'))], 'gas for the impersonated holder');
  const holder = F.wallet(USDG_HOLDER);
  const fundUsdg = async (to, amount) => send(holder, USDG, erc20, 'transfer', [to, amount]);
  for (const [role, amount] of Object.entries(fund)) await fundUsdg(roles[role] ?? role, amount);

  const deploy = async (a, ctor) => (await client.waitForTransactionReceipt({ hash: await W.deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args: ctor, gas: 25_000_000n }) })).contractAddress;
  const router = await deploy(routerArt, [BAG_FACTORY, roles.routerOwner, roles.planSigner]);
  await send(W.routerOwner, router, routerArt.abi, 'setAllowedTarget', [SWAP_ROUTER02, true]);
  for (const t of [USDG, ...BAG1.definition.assets.map(a => a.address), ...BAG2.definition.assets.map(a => a.address)]) await send(W.routerOwner, router, routerArt.abi, 'setAllowedToken', [t, true]);
  const deployedAt = await deploy(execArt, [BAG_FACTORY, STRATEGY_REGISTRY, CHAIN_LABEL]);
  const runtime = await client.getCode({ address: deployedAt });
  await F.edit('SET_CODE', 'hardhat_setCode', [EXECUTOR, runtime], `executor runtime from ${deployedAt} (immutables: real BagFactory, real StrategyRegistry) at the keyless address`);
  await F.edit('SET_CODE', 'hardhat_setCode', [deployedAt, '0x'], 'remove the deployer-address copy so only the keyless executor exists');

  const mask = (code, refs) => { const h = code.slice(2).split(''); for (const list of Object.values(refs)) for (const { start, length } of list) for (let i = start * 2; i < (start + length) * 2; i++) h[i] = '0'; return h.join(''); };
  const routerCode = await client.getCode({ address: router });
  const domainOnChain = await read(EXECUTOR, execArt.abi, 'domainSeparator');
  const domainExpected = v.hashDomain({ domain: { ...sdk.RECURRING_PURCHASE_DOMAIN, chainId: CHAIN_ID, verifyingContract: EXECUTOR }, types: { EIP712Domain: EIP712_DOMAIN } });
  const realContracts = {};
  for (const [k, a] of Object.entries({ USDG, SWAP_ROUTER02, QUOTER_V2, BAG_FACTORY, STRATEGY_REGISTRY })) { const c = await client.getCode({ address: a }); realContracts[k] = { address: a, codeKeccak: v.keccak256(c), bytes: (c.length - 2) / 2 }; }
  realContracts.USDG.eip1967Implementation = v.getAddress(v.slice(await client.getStorageAt({ address: USDG, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }), 12));
  const usdgDomain = await read(USDG, erc20, 'DOMAIN_SEPARATOR');
  // The executor rebuilds the composition from the signed rows; it must reproduce each real Bag's registered hash.
  const compositionCheck = {};
  for (const doc of [BAG1, BAG2]) {
    const rows = sdk.recurringRegisteredAssets(doc).map(r => ({ asset: r.asset, symbol: r.symbol, weightBps: r.weightBps, decimals: r.decimals, maxPriceRaw: 1n }));
    const ref = offChainRef(doc);
    const bag = await read(BAG_FACTORY, factoryAbi, 'bagOf', [await read(BAG_FACTORY, factoryAbi, 'deriveBagId', [BAG_CREATOR, ref])]);
    const registered = await read(bag, bagAbi, 'compositionHash');
    const onChain = await read(EXECUTOR, execArt.abi, 'compositionHashOf', [rows]);
    compositionCheck[doc.ref.strategyId] = { registered, executorRebuilt: onChain, sdk: sdk.recurringCompositionHash(CHAIN_LABEL, rows), matches: onChain === registered && sdk.recurringCompositionHash(CHAIN_LABEL, rows) === registered };
  }
  const deployment = {
    executor: { address: EXECUTOR, runtimeMatchesArtifact: mask(runtime, execArt.immutableReferences) === mask(execArt.deployedBytecode, execArt.immutableReferences), immutables: { bagFactory: await read(EXECUTOR, execArt.abi, 'bagFactory'), strategyRegistry: await read(EXECUTOR, execArt.abi, 'strategyRegistry'), chainLabel: await read(EXECUTOR, execArt.abi, 'chainLabel') }, domainSeparator: domainOnChain, domainSeparatorMatchesSdk: domainOnChain === domainExpected, compositionCheck },
    router: { address: router, runtimeMatchesArtifact: mask(routerCode, routerArt.immutableReferences) === mask(routerArt.deployedBytecode, routerArt.immutableReferences), bagFactory: BAG_FACTORY, planSigner: roles.planSigner, owner: roles.routerOwner,
      allowlist: { targets: [SWAP_ROUTER02], tokens: 'USDG + assets of both BAGs' }, trust: 'test keys: router owner and planSigner are local; the runs treat both as compromised' },
    realContracts, usdgPermitDomain: { onChain: usdgDomain, matches: usdgDomain === v.hashDomain({ domain: { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }, types: { EIP712Domain: EIP712_DOMAIN } }), name: 'Global Dollar', version: '1' },
  };
  if (!deployment.executor.runtimeMatchesArtifact || !deployment.executor.domainSeparatorMatchesSdk || deployment.executor.immutables.chainLabel !== CHAIN_LABEL || !Object.values(compositionCheck).every(c => c.matches) || !deployment.router.runtimeMatchesArtifact || !deployment.usdgPermitDomain.matches) throw new Error('deployment check failed: ' + json(deployment));
  return { relay, remote, F, client, rpc, read, bal, keys, W, roles, send, fundUsdg, holder, router, deployment, keyless,
    fork: { blockNumber: F.block.number, blockHash: F.block.hash, timestamp: F.block.timestamp, note: 'one fork block for the whole run; every leg of a purchase executes in one transaction (same block by construction)' } };
}

const offChainRef = doc => '0x' + doc.ref.strategyId.replace(/-/g, '').padStart(64, '0');

/** On-chain identity of a bag.json: real BagFactory/Bag and StrategyRegistry, with the SDK's composition hash next to it. */
export async function bagIdentity(read, sdk, doc) {
  const ref = offChainRef(doc);
  const bagId = await read(BAG_FACTORY, factoryAbi, 'deriveBagId', [BAG_CREATOR, ref]);
  const bag = await read(BAG_FACTORY, factoryAbi, 'bagOf', [bagId]);
  const strategyId = await read(STRATEGY_REGISTRY, regAbi, 'deriveStrategyId', [BAG_CREATOR, ref]);
  const registered = await read(STRATEGY_REGISTRY, regAbi, 'isRegistered', [strategyId]);
  const definitionHash = sdk.computeDefinitionHash(doc.definition);
  return { uuid: doc.ref.strategyId, bagId, bag, version: await read(bag, bagAbi, 'version'), compositionHash: await read(bag, bagAbi, 'compositionHash'), sdkCompositionHash: sdk.bagFactoryCompositionHash(doc),
    definitionHash, strategyId, registered, matches: registered ? await read(STRATEGY_REGISTRY, regAbi, 'matches', [strategyId, doc.ref.version, definitionHash]) : false, docVersion: doc.ref.version };
}

/**
 * Owner limit for a TEST: the best real-chain QuoterV2 quote (latest block, read-only relay) for one run's leg, plus
 * `bufferBps`. A test convenience, not a market reference. An asset without any quote gets a far fallback (recorded).
 */
export async function limitsFromRealQuotes({ remote, sdk, uni, doc, amountPerRunRaw, bufferBps, sources }) {
  const split = sdk.splitByWeight(amountPerRunRaw, doc.definition);
  const out = {};
  for (const a of doc.definition.assets) {
    const legIn = split.get(`${doc.definition.chain}:${a.address.toLowerCase()}`);
    let best = 0n;
    for (const fee of [100, 500, 3000, 10000]) {
      try { const { result } = await remote.simulateContract({ address: QUOTER_V2, abi: uni.UNISWAP_V3_QUOTER_V2_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDG, tokenOut: a.address, amountIn: legIn, fee, sqrtPriceLimitX96: 0n }] }); if (result[0] > best) best = result[0]; } catch {}
    }
    out[a.address.toLowerCase()] = best > 0n ? (legIn * 10n ** BigInt(a.decimals) * (10_000n + BigInt(bufferBps)) + best * 10_000n - 1n) / (best * 10_000n) : 10n ** 12n;
    if (sources) sources[`${doc.ref.strategyId}:${a.address.toLowerCase()}:${bufferBps}`] = best > 0n ? { realChainQuoteRaw: best, legInRaw: legIn, bufferBps } : { realChainQuoteRaw: null, fallbackMaxPriceRaw: 10n ** 12n };
  }
  return out;
}

/** An EIP-2612 permit request for USDG with the executor as spender. */
export const permitTypedData = ({ owner, value, nonce, deadline }) => ({
  domain: { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG },
  primaryType: 'Permit',
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  message: { owner, spender: EXECUTOR, value, nonce, deadline },
});
export const permitProof = (value, deadline, signature) => {
  const sig = v.parseSignature(signature);
  const vByte = Number(sig.v ?? BigInt(27 + sig.yParity));
  return { v: vByte, r: sig.r, s: sig.s, proof: v.encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [value, deadline, vByte, sig.r, sig.s]) };
};
