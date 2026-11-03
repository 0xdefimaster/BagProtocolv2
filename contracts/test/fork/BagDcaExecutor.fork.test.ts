import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, hashTypedData, keccak256, parseAbi, parseEventLogs, stringToHex, toHex, zeroHash, type Hex } from 'viem';
import { DCA_TYPES } from '../helpers/dca-types';
import { verifyDcaReceipt, type DcaReceiptClient } from '../../../packages/bag-sdk/src/dca';
import { A, bestQuote, connectPinnedFork, ERC20, errorName, evidence, fundUsdg, SKIP, stepLogger } from './fork-harness';

// -----------------------------------------------------------------------------
// ROBINHOOD CHAIN FORK TEST — synthetic BAG (BagFactory deployed on the fork),
// real USDG/TSLA/NVDA, real SwapRouter02, v3 factory, QuoterV2 and StrategyRegistry.
// Not a mainnet test: nothing is broadcast; keys are Hardhat test accounts.
// The real-BAG scenario is BagDcaRealBag.fork.test.ts.
//
//   ROBINHOOD_MAINNET_RPC_URL=<rpc> ROBINHOOD_FORK_BLOCK=<n> npx hardhat test nodejs contracts/test/fork/BagDcaExecutor.fork.test.ts
//   or: npx tsx scripts/dca-fork-evidence.ts   (pins a block, runs every fork test twice, compares)
// -----------------------------------------------------------------------------

const ROUTER = parseAbi(['function factory() view returns (address)']);

describe('BagDcaExecutor on a Robinhood Chain fork (synthetic BAG, real tokens and Uniswap v3)', { skip: SKIP }, () => {
  it('runs a 2-asset DCA through the real SwapRouter02 and refuses a run above the ceiling', async () => {
    const step = stepLogger('synthetic');
    const ev = evidence('synthetic-bag');
    const { viem, pc, tc, fork } = await connectPinnedFork(step);
    ev.set('fork', fork);
    const [keeper, owner, recipient, creator] = await viem.getWalletClients();
    const read = (address: Hex, abi: any, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args } as any) as Promise<any>;
    const bal = (t: Hex, w: Hex) => read(t, ERC20, 'balanceOf', [w]) as Promise<bigint>;

    step('1. real contracts present and consistent');
    for (const [name, addr] of Object.entries(A)) assert.ok(((await pc.getCode({ address: addr })) ?? '0x').length > 2, `${name} has code`);
    assert.equal(getAddress(await read(A.SWAP_ROUTER02, ROUTER, 'factory')), A.V3_FACTORY, 'SwapRouter02.factory() is the v3 factory');
    assert.equal(await read(A.USDG, ERC20, 'decimals'), 6);
    assert.equal(await read(A.TSLA, ERC20, 'decimals'), 18);
    assert.equal(await read(A.NVDA, ERC20, 'decimals'), 18);

    step('2. QuoterV2: best USDG pool per asset for a 5 USDG leg');
    const leg = 5_000_000n;
    const best = { nvda: (await bestQuote(pc, A.USDG, A.NVDA, leg))!, tsla: (await bestQuote(pc, A.USDG, A.TSLA, leg))! };
    assert.ok(best.nvda && best.tsla, 'USDG pools with liquidity exist for NVDA and TSLA');
    ev.set('quotes', best);

    step('3. deploy adapter (real router/factory), BagFactory (on the fork), executor (real StrategyRegistry)');
    const adapter = await viem.deployContract('UniswapV3ExactInAdapter', [A.SWAP_ROUTER02, A.V3_FACTORY]);
    const factory = await viem.deployContract('BagFactory', [creator.account.address, creator.account.address, 0n, 10n ** 16n]);
    const executor = await viem.deployContract('BagDcaExecutor', [factory.address, A.STRATEGY_REGISTRY, adapter.address, 'robinhood']);
    const executorCodeHash = keccak256((await pc.getCode({ address: executor.address }))!);

    step('4. synthetic BAG NVDA/TSLA 50/50; ceilings = quote + 3 % (a test choice, not a fair price)');
    const price = (out: bigint) => (leg * 10n ** 18n) / out;
    const assets = [
      { asset: A.NVDA.toLowerCase() as Hex, symbol: 'NVDA', weightBps: 5000, decimals: 18, maxPriceRaw: (price(best.nvda.out) * 103n) / 100n },
      { asset: A.TSLA.toLowerCase() as Hex, symbol: 'TSLA', weightBps: 5000, decimals: 18, maxPriceRaw: (price(best.tsla.out) * 103n) / 100n },
    ];
    const comp = keccak256(stringToHex(assets.map((x) => `robinhood:${x.asset}:${x.symbol}:${x.decimals}:${x.weightBps}`).join('|')));
    const ref = keccak256(toHex('bag:dca-fork:synthetic'));
    const asCreator = await viem.getContractAt('BagFactory', factory.address, { client: { wallet: creator } });
    await asCreator.write.createBag([ref, comp, 'bag:dca-fork', true]);
    const bagId = (await factory.read.deriveBagId([creator.account.address, ref])) as Hex;

    step('5. fund the owner on the fork (impersonated USDG/WETH pool)');
    await fundUsdg(viem, pc, tc, owner.account.address, 100_000_000n);

    const t0 = (await pc.getBlock()).timestamp;
    const auth = {
      owner: owner.account.address, recipient: recipient.account.address, inputToken: A.USDG, allowedCaller: keeper.account.address,
      bag: { bagId, bagVersion: 1n, compositionHash: comp, definitionHash: keccak256(toHex('fork-definition')), strategyId: zeroHash, strategyVersion: 0 },
      assets,
      schedule: { amountPerRun: 2n * leg, totalBudget: 6n * leg, maxRuns: 3, startsAt: t0 - 10n, periodSeconds: 86_400n, expiresAt: t0 - 10n + 3n * 86_400n },
      route: { adapter: adapter.address, swapRouter: A.SWAP_ROUTER02, allowedFees: [...new Set([best.nvda.fee, best.tsla.fee])] },
      nonce: 1n,
    };
    const domain = { name: 'BagDcaExecutor', version: '1', chainId: await pc.getChainId(), verifyingContract: executor.address } as const;
    const sig = await owner.signTypedData({ account: owner.account, domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: auth });
    const id = hashTypedData({ domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: auth });
    await owner.writeContract({ address: A.USDG, abi: ERC20, functionName: 'approve', args: [executor.address, auth.schedule.totalBudget], account: owner.account, chain: undefined });
    const fees = [best.nvda.fee, best.tsla.fee];
    const run = async (a: typeof auth, s: Hex, i: Hex, window: bigint) => {
      const t = (await pc.getBlock()).timestamp;
      const hash = await executor.write.execute([a, { authorizationId: i, window, deadline: t + 600n, fees, minOutFloors: [] }, s], { account: keeper.account });
      return pc.waitForTransactionReceipt({ hash });
    };
    const runEvidence = async (r: Awaited<ReturnType<typeof run>>, index: bigint) => {
      const delivered = parseEventLogs({ abi: executor.abi, logs: r.logs, eventName: 'AssetDelivered' }) as any[];
      const v = await verifyDcaReceipt({ client: pc as unknown as DcaReceiptClient, transactionHash: r.transactionHash, auth, deployment: { chainId: domain.chainId, executor: executor.address }, executionIndex: index, expectedExecutorCodeHash: executorCodeHash });
      assert.deepEqual(v.issues, []);
      assert.equal(v.status, 'VERIFIED');
      return {
        status: r.status, gasUsed: r.gasUsed, verification: v.status, executorCodeChecked: v.executorCodeChecked,
        deliveries: delivered.map((d) => ({ token: d.args.token, delta: d.args.balanceAfter - d.args.balanceBefore, minReceived: d.args.minReceived })),
      };
    };

    step('6. run 1: exact debit, delivery to the recipient, AssetDelivered per asset, SDK VERIFIED');
    const ownerBefore = await bal(A.USDG, owner.account.address);
    const r1 = await run(auth, sig, id, 0n);
    assert.equal(r1.status, 'success');
    assert.equal(ownerBefore - (await bal(A.USDG, owner.account.address)), 2n * leg);
    assert.equal(await bal(A.USDG, executor.address), 0n);
    assert.equal(await bal(A.USDG, adapter.address), 0n);
    const run1 = await runEvidence(r1, 0n);
    for (const d of run1.deliveries) assert.ok(d.delta >= d.minReceived);
    ev.set('run1', { ...run1, ownerDebit: 2n * leg });

    step('7. same window again → NotDue; next day → run 2');
    let duplicate = 'no revert';
    await assert.rejects(run(auth, sig, id, 0n).catch((e) => { duplicate = errorName(e); throw e; }), /NotDue/);
    await tc.increaseTime({ seconds: 86_400 });
    await tc.mine({ blocks: 1 });
    const run2 = await runEvidence(await run(auth, sig, id, 1n), 1n);
    ev.set('duplicateSameWindow', duplicate);
    ev.set('run2', run2);

    step('8. TSLA ceiling at half the market → whole run reverts, nothing moves');
    const low = { ...auth, nonce: 2n, assets: [assets[0], { ...assets[1], maxPriceRaw: assets[1].maxPriceRaw / 2n }] };
    const lowSig = await owner.signTypedData({ account: owner.account, domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: low });
    const lowId = hashTypedData({ domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: low });
    await owner.writeContract({ address: A.USDG, abi: ERC20, functionName: 'approve', args: [executor.address, 10n ** 12n], account: owner.account, chain: undefined });
    const before = await bal(A.USDG, owner.account.address);
    let lowError = 'no revert';
    await assert.rejects(run(low, lowSig, lowId, 1n).catch((e) => { lowError = errorName(e); throw e; }), /Too little received/);
    assert.equal(await bal(A.USDG, owner.account.address), before);
    assert.equal(((await executor.read.getState([owner.account.address, lowId])) as any).runs, 0);
    ev.set('ceilingBelowMarket', { error: lowError, ownerBalanceUnchanged: true, runsUnchanged: true });

    ev.write();
    console.log(`  [synthetic] run1 gas ${run1.gasUsed} deltas ${run1.deliveries.map((d) => d.delta).join('/')}; run2 gas ${run2.gasUsed}; fork block ${fork.number}`);
  });
});
