import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, hashTypedData, keccak256, parseAbi, parseEventLogs, toHex, zeroHash, type Hex } from 'viem';
import { DCA_TYPES } from '../helpers/dca-types';
import { DCA_ADAPTER_ABI, DCA_EXECUTOR_ABI, dcaCompositionHash, dcaRegisteredAssets, verifyDcaReceipt, type DcaReceiptClient } from '../../../packages/bag-sdk/src/dca';
import type { BagDocument } from '../../../packages/bag-sdk/src/types';
import { A, bestQuote, compareRuntime, connectPinnedFork, ERC20, errorName, evidence, fundUsdg, SKIP, stepLogger } from './fork-harness';

// -----------------------------------------------------------------------------
// ROBINHOOD CHAIN FORK TEST — the REAL BagFactory, real BAGs and the real
// StrategyRegistry, re-verified on a pinned fork. Candidates come from
// real-bags.robinhood.json; nothing there is trusted: the factory and every Bag
// must match this repository's compiled code, the Bags must point back at the
// factory, the documents must reproduce the on-chain composition hash, and the
// configured app addresses (FACTORY_ADDRESS_ROBINHOOD, BAG_EXECUTION_ROUTER_ADDRESS)
// are compared when present. The executor is deployed on the fork against these
// real contracts. Not a mainnet test: nothing is broadcast.
// -----------------------------------------------------------------------------

const here = new URL('.', import.meta.url);
const CANDIDATES = JSON.parse(readFileSync(new URL('real-bags.robinhood.json', here), 'utf8'));
const doc = (p: string) => JSON.parse(readFileSync(new URL(p, here), 'utf8')) as BagDocument;
const FACTORY_ABI = parseAbi([
  'function bagOf(bytes32) view returns (address)',
  'function deriveBagId(address creator, bytes32 offChainRef) pure returns (bytes32)',
  'function owner() view returns (address)',
  'function creationFeeCap() view returns (uint256)',
  'event BagCreated(bytes32 indexed bagId, address indexed creator, bytes32 indexed offChainRef, address bag, bytes32 compositionHash, uint256 version)',
  'event BagVersionRecorded(bytes32 indexed bagId, address indexed creator, address indexed bag, uint256 version, bytes32 compositionHash, string metadataURI)',
]);
const BAG_ABI = parseAbi([
  'function bagId() view returns (bytes32)', 'function offChainRef() view returns (bytes32)', 'function creator() view returns (address)',
  'function factory() view returns (address)', 'function version() view returns (uint256)', 'function compositionHash() view returns (bytes32)', 'function isMutable() view returns (bool)',
]);
const REGISTRY_ABI = parseAbi([
  'function matches(bytes32 strategyId, uint32 version, bytes32 definitionHash) view returns (bool)',
  'function definitionHashOf(bytes32 strategyId, uint32 version) view returns (bytes32)',
  'function deriveStrategyId(address creator, bytes32 offChainRef) pure returns (bytes32)',
]);
const ROUTER_FACTORY_ABI = parseAbi(['function bagFactory() view returns (address)']);
const ERRORS = [...DCA_EXECUTOR_ABI, ...DCA_ADAPTER_ABI];
const REGISTRY_ERRORS = /^(UnknownBag|BagChanged|CompositionMismatch|StrategyNotRegistered|InvalidTerms\(13\))/;
const uuidRef = (uuid: string) => `0x${uuid.replace(/-/g, '').padStart(64, '0')}` as Hex;
const lc = (x: string) => x.toLowerCase();

describe('BagDcaExecutor on a Robinhood Chain fork (REAL BagFactory, BAGs and StrategyRegistry)', { skip: SKIP }, () => {
  it('verifies the deployed BAG infrastructure, accepts authentic BAGs and rejects every altered binding', async () => {
    const step = stepLogger('real-bag');
    const ev = evidence('real-bag');
    const { viem, pc, tc, fork } = await connectPinnedFork(step);
    ev.set('fork', fork);
    const read = (address: Hex, abi: any, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args } as any) as Promise<any>;
    const [keeper, owner, recipient] = await viem.getWalletClients();
    // The factory address comes from the app configuration (FACTORY_ADDRESS_ROBINHOOD, a deployment secret); the
    // repository only holds the hash of the research candidate, so the two must agree.
    const configured = process.env.FACTORY_ADDRESS_ROBINHOOD;
    assert.ok(configured && /^0x[0-9a-fA-F]{40}$/.test(configured), 'FACTORY_ADDRESS_ROBINHOOD (the app\'s BagFactory) is required for the real-BAG fork test');
    const factoryAddr = getAddress(configured);
    const candidateMatches = keccak256(factoryAddr.toLowerCase() as Hex) === CANDIDATES.bagFactoryKeccak256;

    // ---------------------------------------------------------------- the factory
    step('1. BagFactory: code = this repository\'s BagFactory, cross-checked with the app configuration');
    const factoryCode = compareRuntime(await pc.getCode({ address: factoryAddr }), 'BagFactory');
    assert.ok(factoryCode.bytes > 0, 'BagFactory candidate has code at the fork block');
    assert.ok(factoryCode.masked, `BagFactory runtime differs from the compiled artifact (${factoryCode.bytes} vs ${factoryCode.artifactBytes} bytes)`);
    const crossChecks: Record<string, unknown> = { researchCandidateHash: candidateMatches ? 'MATCH' : 'MISMATCH' };
    assert.ok(candidateMatches, 'FACTORY_ADDRESS_ROBINHOOD is not the research candidate (bagFactoryKeccak256)');
    const routerAddr = process.env.BAG_EXECUTION_ROUTER_ADDRESS as Hex | undefined;
    if (routerAddr) {
      const bound = await read(routerAddr, ROUTER_FACTORY_ABI, 'bagFactory');
      crossChecks.BagExecutionRouter_bagFactory = lc(bound) === lc(factoryAddr) ? 'MATCH' : `MISMATCH (${bound})`;
      assert.equal(lc(bound), lc(factoryAddr), 'the configured BagExecutionRouter is bound to another BagFactory');
    } else crossChecks.BagExecutionRouter_bagFactory = 'NOT_PROVIDED';
    // evidence records the address hash only: the address is a deployment secret in Netlify's scan
    ev.set('bagFactory', { addressKeccak256: keccak256(factoryAddr.toLowerCase() as Hex), ...factoryCode, owner: await read(factoryAddr, FACTORY_ABI, 'owner'), creationFeeCap: await read(factoryAddr, FACTORY_ABI, 'creationFeeCap'), crossChecks });

    step('2. StrategyRegistry: code = this repository\'s StrategyRegistry');
    const registryCode = compareRuntime(await pc.getCode({ address: A.STRATEGY_REGISTRY }), 'StrategyRegistry');
    assert.ok(registryCode.masked, 'StrategyRegistry runtime differs from the compiled artifact');
    ev.set('strategyRegistry', { address: A.STRATEGY_REGISTRY, ...registryCode });

    // ---------------------------------------------------------------- the bags
    step('3. each BAG: Bag code, factory back-pointer, id derivation, BagCreated event, on-chain composition = document');
    type Real = { uuid: string; bagId: Hex; bag: Hex; creator: Hex; version: bigint; compositionHash: Hex; assets: ReturnType<typeof dcaRegisteredAssets>; doc: BagDocument; strategy: { id: Hex; version: number; definitionHash: Hex } | null };
    const bags: Real[] = [];
    const bagEvidence: unknown[] = [];
    for (const c of CANDIDATES.bags) {
      const d = doc(c.document);
      const ref = uuidRef(c.uuid);
      const bagId: Hex = c.bagId ?? (await read(factoryAddr, FACTORY_ABI, 'deriveBagId', [c.creatorCandidate, ref]));
      const bag = getAddress(await read(factoryAddr, FACTORY_ABI, 'bagOf', [bagId]));
      if (/^0x0{40}$/i.test(bag)) {
        bagEvidence.push({ uuid: c.uuid, bagId, onFactory: false });
        step(`   ${c.uuid}: not registered on this factory (recorded, skipped)`);
        continue;
      }
      const code = compareRuntime(await pc.getCode({ address: bag }), 'Bag');
      assert.ok(code.masked, `${c.uuid}: Bag runtime differs from the compiled artifact`);
      const [onBagId, onRef, creator, onFactory, version, compositionHash] = await Promise.all(
        ['bagId', 'offChainRef', 'creator', 'factory', 'version', 'compositionHash'].map((f) => read(bag, BAG_ABI, f)),
      );
      assert.equal(onBagId, bagId);
      assert.equal(onRef, ref, `${c.uuid}: offChainRef is not the UUID`);
      assert.equal(lc(onFactory), lc(factoryAddr), `${c.uuid}: Bag.factory() is not the factory`);
      assert.equal(await read(factoryAddr, FACTORY_ABI, 'deriveBagId', [creator, ref]), bagId, `${c.uuid}: bagId is not derived from (creator, uuid)`);
      // BagCreated in the factory's own logs (topic-filtered: bagId and creator), anywhere up to the fork block.
      let created: unknown = 'NOT_SEARCHED';
      try {
        const logs = await pc.getContractEvents({ address: factoryAddr, abi: FACTORY_ABI, eventName: 'BagCreated', args: { bagId, creator }, fromBlock: 0n, toBlock: fork.number });
        created = logs.map((l: any) => ({ tx: l.transactionHash, block: l.blockNumber, bag: l.args.bag, version: l.args.version }));
        assert.ok((created as any[]).some((x) => lc(x.bag) === lc(bag)), `${c.uuid}: no BagCreated log for this Bag`);
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
        created = `UNAVAILABLE (${errorName(e).slice(0, 80)})`; // some RPCs refuse a 0..latest log range
      }
      const assets = dcaRegisteredAssets(d);
      assert.ok(assets, `${c.uuid}: document lacks symbols`);
      const docHash = dcaCompositionHash('robinhood', assets!);
      for (const a of assets!) assert.equal(Number(await read(a.asset, ERC20, 'decimals')), a.decimals, `${c.uuid}: ${a.symbol} decimals`);
      const docVersion = d.ref?.version;
      const compositionMatches = docHash === compositionHash;
      bagEvidence.push({ uuid: c.uuid, bagId, bag, creator, version, compositionHash, documentVersion: docVersion, documentCompositionHash: docHash, compositionMatches, bagCode: code, bagCreated: created, assets: assets!.map((a) => `${a.symbol}:${a.asset}:${a.weightBps}`) });
      assert.ok(compositionMatches, `${c.uuid}: the document (v${docVersion}) does not reproduce on-chain v${version}'s compositionHash`);
      let strategy: Real['strategy'] = null;
      if (c.registeredStrategy) {
        const id = (await read(A.STRATEGY_REGISTRY, REGISTRY_ABI, 'deriveStrategyId', [creator, ref])) as Hex;
        strategy = { id, version: c.registeredStrategy.version, definitionHash: c.registeredStrategy.definitionHash };
      }
      bags.push({ uuid: c.uuid, bagId, bag, creator, version, compositionHash, assets, doc: d, strategy });
    }
    ev.set('bags', bagEvidence);
    assert.ok(bags.length >= 1, 'at least one candidate BAG is registered on the factory');

    // ---------------------------------------------------------------- executor on the real infrastructure
    step('4. deploy adapter + executor on the fork against the REAL BagFactory and StrategyRegistry');
    const adapter = await viem.deployContract('UniswapV3ExactInAdapter', [A.SWAP_ROUTER02, A.V3_FACTORY]);
    const executor = await viem.deployContract('BagDcaExecutor', [factoryAddr, A.STRATEGY_REGISTRY, adapter.address, 'robinhood']);
    const executorCodeHash = keccak256((await pc.getCode({ address: executor.address }))!);
    const domain = { name: 'BagDcaExecutor', version: '1', chainId: await pc.getChainId(), verifyingContract: executor.address } as const;
    await fundUsdg(viem, pc, tc, owner.account.address, 200_000_000n);
    await owner.writeContract({ address: A.USDG, abi: ERC20, functionName: 'approve', args: [executor.address, 10n ** 15n], account: owner.account, chain: undefined });
    const t0 = (await pc.getBlock()).timestamp;
    const perRun = 20_000_000n;

    const buildAuth = async (b: Real, over: { strategy?: { id: Hex; version: number; definitionHash: Hex } | null; nonce?: bigint } = {}) => {
      const fees = new Set<number>();
      const assets = [];
      for (const a of b.assets!) {
        const legIn = (perRun * BigInt(a.weightBps)) / 10_000n || 1n;
        const q = await bestQuote(pc, A.USDG, a.asset, legIn);
        if (q) fees.add(q.fee);
        // ceiling = quote + 3 % where a pool quotes; otherwise a placeholder (that leg has no v3 route anyway)
        const maxPriceRaw = q && q.out > 0n ? ((legIn * 10n ** BigInt(a.decimals)) / q.out) * 103n / 100n + 1n : 10n ** 30n;
        assets.push({ asset: a.asset, symbol: a.symbol, weightBps: a.weightBps, decimals: a.decimals, maxPriceRaw, fee: q?.fee ?? 3000 });
      }
      const s = over.strategy === undefined ? b.strategy : over.strategy;
      return {
        fees: assets.map((a) => a.fee),
        auth: {
          owner: owner.account.address, recipient: recipient.account.address, inputToken: A.USDG, allowedCaller: keeper.account.address,
          bag: { bagId: b.bagId, bagVersion: b.version, compositionHash: b.compositionHash, definitionHash: s?.definitionHash ?? keccak256(toHex(`definition:${b.uuid}`)), strategyId: s?.id ?? zeroHash, strategyVersion: s?.version ?? 0 },
          assets: assets.map(({ fee: _f, ...a }) => a),
          schedule: { amountPerRun: perRun, totalBudget: perRun * 3n, maxRuns: 3, startsAt: t0 - 10n, periodSeconds: 86_400n, expiresAt: t0 + 3n * 86_400n },
          route: { adapter: adapter.address, swapRouter: A.SWAP_ROUTER02, allowedFees: [100, 500, 3000, 10000] },
          nonce: over.nonce ?? 1n,
        },
      };
    };
    type Auth = Awaited<ReturnType<typeof buildAuth>>['auth'];
    /** eth_call of execute as the keeper: 'OK' or the decoded revert. Nothing is mined. */
    const simulate = async (a: Auth, fees: number[]) => {
      const sig = await owner.signTypedData({ account: owner.account, domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
      const id = hashTypedData({ domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
      const t = (await pc.getBlock()).timestamp;
      const args = [a, { authorizationId: id, window: 0n, deadline: t + 600n, fees, minOutFloors: [] }, sig] as const;
      try {
        await pc.simulateContract({ address: executor.address, abi: ERRORS, functionName: 'execute', args: args as any, account: keeper.account.address });
        return { result: 'OK', id, sig, args };
      } catch (e) {
        return { result: errorName(e), id, sig, args };
      }
    };
    const clone = (a: Auth): Auth => ({ ...a, bag: { ...a.bag }, assets: a.assets.map((x) => ({ ...x })), schedule: { ...a.schedule }, route: { ...a.route } });

    step('5. authentic BAGs: the registry checks pass; full purchase where every asset routes');
    const results: Record<string, unknown> = {};
    let purchased = 0;
    for (const b of bags) {
      const { auth, fees } = await buildAuth(b);
      const sim = await simulate(auth, fees);
      const accepted = sim.result === 'OK' || !REGISTRY_ERRORS.test(sim.result);
      assert.ok(accepted, `${b.uuid}: authentic BAG rejected by a registry check: ${sim.result}`);
      const r: Record<string, unknown> = { strategyId: auth.bag.strategyId, strategyVersion: auth.bag.strategyVersion, simulation: sim.result, registryChecksPassed: true };
      if (sim.result === 'OK') {
        const hash = await executor.write.execute(sim.args as any, { account: keeper.account });
        const receipt = await pc.waitForTransactionReceipt({ hash });
        const v = await verifyDcaReceipt({ client: pc as unknown as DcaReceiptClient, transactionHash: hash, auth, deployment: { chainId: domain.chainId, executor: executor.address }, executionIndex: 0n, expectedExecutorCodeHash: executorCodeHash });
        assert.equal(v.status, 'VERIFIED', `${b.uuid}: ${v.issues.map((i) => i.code).join(',')}`);
        const delivered = parseEventLogs({ abi: executor.abi, logs: receipt.logs, eventName: 'AssetDelivered' }) as any[];
        r.purchase = { gasUsed: receipt.gasUsed, verification: v.status, executorCodeChecked: v.executorCodeChecked, deliveries: delivered.map((d) => ({ token: d.args.token, delta: d.args.balanceAfter - d.args.balanceBefore, minReceived: d.args.minReceived })) };
        purchased++;
      }
      results[b.uuid] = r;
    }
    ev.set('authentic', results);

    step('6. altered bindings are rejected (simulated; nothing mined)');
    const b0 = bags.find((b) => b.assets!.length >= 2)!;
    const { auth: base, fees: baseFees } = await buildAuth(b0, { strategy: null, nonce: 50n });
    const variants: [string, (a: Auth) => void, RegExp][] = [
      ['wrongBagId', (a) => (a.bag.bagId = keccak256(toHex('not-a-bag'))), /^UnknownBag/],
      ['wrongVersion', (a) => (a.bag.bagVersion = a.bag.bagVersion + 1n), /^BagChanged/],
      ['wrongCompositionHash', (a) => (a.bag.compositionHash = keccak256(toHex('another composition'))), /^BagChanged/],
      ['alteredComposition', (a) => (a.assets[0].asset = A.WETH.toLowerCase() as Hex), /^CompositionMismatch/], // a token outside the BAG
      ['alteredOrdering', (a) => ([a.assets[0], a.assets[1]] = [a.assets[1], a.assets[0]]), /^CompositionMismatch/],
      ['alteredWeights', (a) => { a.assets[0].weightBps -= 1; a.assets[1].weightBps += 1; }, /^CompositionMismatch/],
      ['alteredSymbol', (a) => (a.assets[0].symbol = `${a.assets[0].symbol}X`), /^CompositionMismatch/],
    ];
    const negatives: Record<string, string> = {};
    for (const [name, alter, want] of variants) {
      const a = clone(base);
      alter(a);
      const fees = name === 'alteredOrdering' ? [baseFees[1], baseFees[0], ...baseFees.slice(2)] : baseFees;
      const { result } = await simulate(a, fees);
      negatives[name] = result;
      assert.match(result, want, `${name}: expected ${want}, got ${result}`);
    }
    ev.set('negatives', { bag: b0.uuid, results: negatives });

    // ---------------------------------------------------------------- StrategyRegistry (non-zero strategyId)
    step('7. StrategyRegistry.matches through the executor with a non-zero strategyId');
    const reg = bags.find((b) => b.strategy);
    assert.ok(reg, 'a candidate BAG with a registered strategy is on the factory');
    const s = reg!.strategy!;
    const direct = await read(A.STRATEGY_REGISTRY, REGISTRY_ABI, 'matches', [s.id, s.version, s.definitionHash]);
    assert.equal(direct, true, `StrategyRegistry.matches(${s.id}, ${s.version}, definitionHash) is false at the fork block`);
    const unregistered = bags.find((b) => !b.strategy);
    const unregisteredId = unregistered
      ? ((await read(A.STRATEGY_REGISTRY, REGISTRY_ABI, 'deriveStrategyId', [unregistered.creator, uuidRef(unregistered.uuid)])) as Hex)
      : keccak256(toHex('unregistered-strategy'));
    const regCases: [string, { id: Hex; version: number; definitionHash: Hex } | null, (r: string) => boolean, string][] = [
      ['validRegistered', s, (r) => r === 'OK' || !REGISTRY_ERRORS.test(r), 'passes the registry check'],
      ['wrongVersionNext', { ...s, version: s.version + 1 }, (r) => /^StrategyNotRegistered/.test(r), 'StrategyNotRegistered'],
      ['wrongVersionZero', { ...s, version: 0 }, (r) => /^StrategyNotRegistered/.test(r), 'StrategyNotRegistered'],
      ['wrongDefinitionHash', { ...s, definitionHash: keccak256(toHex('another definition')) }, (r) => /^StrategyNotRegistered/.test(r), 'StrategyNotRegistered'],
      ['unregisteredStrategyId', { ...s, id: unregisteredId }, (r) => /^StrategyNotRegistered/.test(r), 'StrategyNotRegistered'],
      ['zeroStrategyIdVersionZero', null, (r) => r === 'OK' || !REGISTRY_ERRORS.test(r), 'registry not consulted; passes'],
    ];
    const regResults: Record<string, string> = {};
    for (const [name, strategy, ok, expect] of regCases) {
      const { auth, fees } = await buildAuth(reg!, { strategy, nonce: 100n + BigInt(Object.keys(regResults).length) });
      const { result } = await simulate(auth, fees);
      regResults[name] = result;
      assert.ok(ok(result), `${name}: expected ${expect}, got ${result}`);
    }
    {
      const { auth, fees } = await buildAuth(reg!, { strategy: null, nonce: 199n });
      auth.bag.strategyVersion = s.version; // zero id with a version
      const { result } = await simulate(auth, fees);
      regResults.zeroStrategyIdWithVersion = result;
      assert.match(result, /^InvalidTerms\(13\)/);
    }
    ev.set('strategyRegistry', { bag: reg!.uuid, strategyId: s.id, version: s.version, definitionHash: s.definitionHash, directMatches: direct, unregisteredId, results: regResults });
    ev.set('purchasesOnRealBags', purchased);
    ev.write();
    console.log(`  [real-bag] factory code ${factoryCode.masked ? 'MATCH' : 'DIFF'} (exact ${factoryCode.exact}); bags ${bags.length}; purchases ${purchased}; negatives ${Object.values(negatives).join(' | ')}; registry ${Object.values(regResults).join(' | ')}`);
  });
});
