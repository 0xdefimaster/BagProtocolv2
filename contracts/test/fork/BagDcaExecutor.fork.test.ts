import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { getAddress, hashTypedData, keccak256, parseAbi, parseEventLogs, stringToHex, toHex, zeroHash, type Hex } from 'viem';
import { DCA_TYPES } from '../helpers/dca-types';
import { verifyDcaReceipt, type DcaReceiptClient } from '../../../packages/bag-sdk/src/dca';

// -----------------------------------------------------------------------------
// ROBINHOOD CHAIN FORK TEST (chain 4663 state, local EDR fork). NOT a mainnet
// test: nothing is broadcast to Robinhood Chain, every key is a Hardhat test
// key, balances come from impersonating a pool on the fork.
//
//   ROBINHOOD_MAINNET_RPC_URL=<rpc> npx hardhat test nodejs contracts/test/fork/BagDcaExecutor.fork.test.ts
//
// Real contracts used (addresses from lib/config/robinhood-chain.ts, "VERIFIED"
// against Uniswap's deployment page and Robinhood's token page; the test also
// checks their code and the router↔factory link on the fork):
//   USDG, TSLA, NVDA, Uniswap v3 SwapRouter02, v3 factory, QuoterV2, and the BAG
//   StrategyRegistry (packages/bag-sdk/src/registry.ts).
// BagFactory: the repo's contract is deployed ON THE FORK, unless
// DCA_FORK_BAG_FACTORY names a deployed one (main has no verified BagFactory
// address record; verify one before using it).
// Skipped (not failed) when ROBINHOOD_MAINNET_RPC_URL is not set.
// -----------------------------------------------------------------------------

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL;
const A = {
  USDG: getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  TSLA: getAddress('0x322f0929c4625ed5bad873c95208d54e1c003b2d'),
  NVDA: getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'),
  WETH: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  SWAP_ROUTER02: getAddress('0xCaf681a66D020601342297493863E78C959E5cb2'),
  V3_FACTORY: getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'),
  QUOTER_V2: getAddress('0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7'),
  STRATEGY_REGISTRY: getAddress('0x907cc27d644c8ea1c24b8320ad09ecf2819209a8'),
};
const FEES = [100, 500, 3000, 10000] as const;
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']);
const FACTORY = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const ROUTER = parseAbi(['function factory() view returns (address)']);
const QUOTER = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)']);

describe('BagDcaExecutor on a Robinhood Chain fork (real USDG/TSLA/NVDA, real Uniswap v3)', { skip: RPC ? false : 'ROBINHOOD_MAINNET_RPC_URL not set' }, () => {
  it('runs a 2-asset DCA through the real SwapRouter02 and refuses a run above the ceiling', async () => {
    const t0 = Date.now();
    const step = (msg: string) => console.log(`  [fork +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
    step('connecting to the fork (every new contract/storage read is fetched from the RPC; first run takes minutes)');
    const { viem } = await network.connect('robinhoodFork');
    const pc = await viem.getPublicClient();
    const tc = await viem.getTestClient();
    await tc.mine({ blocks: 1 }); // EDR needs one local block on an Orbit fork before eth_call
    const [keeper, owner, recipient, creator] = await viem.getWalletClients();
    const read = (address: Hex, abi: any, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args } as any) as Promise<any>;

    // 1. The real contracts are there and consistent.
    step('1. The real contracts are there and consistent.');
    for (const [name, addr] of Object.entries(A)) assert.notEqual(await pc.getCode({ address: addr }), undefined, `${name} has code`);
    assert.equal(getAddress(await read(A.SWAP_ROUTER02, ROUTER, 'factory')), A.V3_FACTORY, 'SwapRouter02.factory() is the v3 factory');
    assert.equal(await read(A.USDG, ERC20, 'decimals'), 6);
    assert.equal(await read(A.TSLA, ERC20, 'decimals'), 18);
    assert.equal(await read(A.NVDA, ERC20, 'decimals'), 18);

    // 2. Best existing USDG pool per asset and its quote for 5 USDG (QuoterV2, simulated).
    step('2. Best existing USDG pool per asset and its quote for 5 USDG (QuoterV2, simulated).');
    const leg = 5_000_000n;
    const best: Record<string, { fee: number; out: bigint }> = {};
    for (const asset of [A.NVDA, A.TSLA]) {
      for (const fee of FEES) {
        const pool = await read(A.V3_FACTORY, FACTORY, 'getPool', [A.USDG, asset, fee]);
        if (/^0x0{40}$/i.test(pool)) continue;
        try {
          const { result } = await pc.simulateContract({ address: A.QUOTER_V2, abi: QUOTER, functionName: 'quoteExactInputSingle', args: [{ tokenIn: A.USDG, tokenOut: asset, amountIn: leg, fee, sqrtPriceLimitX96: 0n }] });
          if (!best[asset] || result[0] > best[asset].out) best[asset] = { fee, out: result[0] };
        } catch {
          /* no liquidity at this tier */
        }
      }
      assert.ok(best[asset], `a USDG pool with liquidity exists for ${asset}`);
    }

    // 3. Deploy the adapter (real router + factory) and the executor (real StrategyRegistry).
    step('3. Deploy the adapter (real router + factory) and the executor (real StrategyRegistry).');
    const adapter = await viem.deployContract('UniswapV3ExactInAdapter', [A.SWAP_ROUTER02, A.V3_FACTORY]);
    const bagFactoryAddr = (process.env.DCA_FORK_BAG_FACTORY as Hex | undefined) ?? (await viem.deployContract('BagFactory', [creator.account.address, creator.account.address, 0n, 10n ** 16n])).address;
    const bagFactory = await viem.getContractAt('BagFactory', bagFactoryAddr, { client: { wallet: creator } });
    const executor = await viem.deployContract('BagDcaExecutor', [bagFactoryAddr, A.STRATEGY_REGISTRY, adapter.address, 'robinhood']);

    // 4. A BAG of NVDA/TSLA 50/50, registered composition rows sorted by symbol.
    step('4. A BAG of NVDA/TSLA 50/50, registered composition rows sorted by symbol.');
    // Ceiling = quoted price + 3 % (a test choice, NOT an independent fair price).
    const price = (out: bigint) => (leg * 10n ** 18n) / out; // USDG raw per whole token
    const assets = [
      { asset: A.NVDA.toLowerCase() as Hex, symbol: 'NVDA', weightBps: 5000, decimals: 18, maxPriceRaw: (price(best[A.NVDA].out) * 103n) / 100n },
      { asset: A.TSLA.toLowerCase() as Hex, symbol: 'TSLA', weightBps: 5000, decimals: 18, maxPriceRaw: (price(best[A.TSLA].out) * 103n) / 100n },
    ];
    const comp = keccak256(stringToHex(assets.map((x) => `robinhood:${x.asset}:${x.symbol}:${x.decimals}:${x.weightBps}`).join('|')));
    const ref = keccak256(toHex(`bag:dca-fork:${Date.now()}`));
    await bagFactory.write.createBag([ref, comp, 'bag:dca-fork', true]);
    const bagId = (await bagFactory.read.deriveBagId([creator.account.address, ref])) as Hex;

    // 5. Fund the owner on the fork from a USDG pool we do not trade against.
    step('5. Fund the owner on the fork from a USDG pool we do not trade against.');
    let holder: Hex | null = null;
    for (const fee of FEES) {
      const pool = (await read(A.V3_FACTORY, FACTORY, 'getPool', [A.USDG, A.WETH, fee])) as Hex;
      if (!/^0x0{40}$/i.test(pool) && (await read(A.USDG, ERC20, 'balanceOf', [pool])) > 1_000_000_000n) holder = pool;
    }
    assert.ok(holder, 'a USDG/WETH pool holding USDG exists to fund the test owner on the fork');
    await tc.impersonateAccount({ address: holder });
    await tc.setBalance({ address: holder, value: 10n ** 18n });
    const holderWallet = await viem.getWalletClient(holder);
    await holderWallet.writeContract({ address: A.USDG, abi: ERC20, functionName: 'transfer', args: [owner.account.address, 100_000_000n], account: holder, chain: undefined });
    await tc.stopImpersonatingAccount({ address: holder });

    const now = (await pc.getBlock()).timestamp;
    const auth = {
      owner: owner.account.address, recipient: recipient.account.address, inputToken: A.USDG,
      bag: { bagId, bagVersion: 1n, compositionHash: comp, definitionHash: keccak256(toHex('fork-definition')), strategyId: zeroHash, strategyVersion: 0 },
      assets,
      schedule: { amountPerRun: 2n * leg, totalBudget: 6n * leg, maxRuns: 3, startsAt: now - 10n, periodSeconds: 86_400n, expiresAt: now - 10n + 3n * 86_400n },
      route: { adapter: adapter.address, swapRouter: A.SWAP_ROUTER02, allowedFees: [...new Set([best[A.NVDA].fee, best[A.TSLA].fee])] },
      nonce: 1n,
    };
    const domain = { name: 'BagDcaExecutor', version: '1', chainId: await pc.getChainId(), verifyingContract: executor.address } as const;
    const sig = await owner.signTypedData({ account: owner.account, domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: auth });
    const id = hashTypedData({ domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: auth });
    await owner.writeContract({ address: A.USDG, abi: ERC20, functionName: 'approve', args: [executor.address, auth.schedule.totalBudget], account: owner.account, chain: undefined });

    const bal = (t: Hex, w: Hex) => read(t, ERC20, 'balanceOf', [w]) as Promise<bigint>;
    const run = async (window: bigint, fees: number[]) => {
      const t = (await pc.getBlock()).timestamp;
      const hash = await executor.write.execute([auth, { authorizationId: id, window, deadline: t + 600n, fees, minOutFloors: [] }, sig], { account: keeper.account });
      return pc.waitForTransactionReceipt({ hash });
    };
    const fees = [best[A.NVDA].fee, best[A.TSLA].fee];

    // 6. Run 1: exact debit, delivery to the recipient, one AssetDelivered per asset.
    step('6. Run 1: exact debit, delivery to the recipient, one AssetDelivered per asset.');
    const ownerBefore = await bal(A.USDG, owner.account.address);
    const nvdaBefore = await bal(A.NVDA, recipient.account.address);
    const tslaBefore = await bal(A.TSLA, recipient.account.address);
    const r1 = await run(0n, fees);
    assert.equal(r1.status, 'success');
    assert.equal(ownerBefore - (await bal(A.USDG, owner.account.address)), 2n * leg);
    assert.equal(await bal(A.USDG, executor.address), 0n);
    assert.equal(await bal(A.USDG, adapter.address), 0n);
    const delivered = parseEventLogs({ abi: executor.abi, logs: r1.logs, eventName: 'AssetDelivered' }) as any[];
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0].args.balanceAfter - delivered[0].args.balanceBefore, (await bal(A.NVDA, recipient.account.address)) - nvdaBefore);
    assert.equal(delivered[1].args.balanceAfter - delivered[1].args.balanceBefore, (await bal(A.TSLA, recipient.account.address)) - tslaBefore);
    for (const d of delivered) assert.ok(d.args.balanceAfter - d.args.balanceBefore >= d.args.minReceived);
    const v = await verifyDcaReceipt({ client: pc as unknown as DcaReceiptClient, transactionHash: r1.transactionHash, auth, deployment: { chainId: domain.chainId, executor: executor.address }, executionIndex: 0n, expectedExecutorCodeHash: keccak256((await pc.getCode({ address: executor.address }))!) });
    assert.deepEqual(v.issues, []);
    assert.equal(v.status, 'VERIFIED');
    console.log(`fork run 1: tx ${r1.transactionHash} gas ${r1.gasUsed}; NVDA +${delivered[0].args.balanceAfter - delivered[0].args.balanceBefore} TSLA +${delivered[1].args.balanceAfter - delivered[1].args.balanceBefore}; fees ${fees}`);

    // 7. Same window again: NotDue. Next day: run 2 passes.
    step('7. Same window again: NotDue. Next day: run 2 passes.');
    await assert.rejects(run(0n, fees), /NotDue/);
    await tc.increaseTime({ seconds: 86_400 });
    await tc.mine({ blocks: 1 });
    const r2 = await run(1n, fees);
    assert.equal(r2.status, 'success');

    // 8. A ceiling far below the market: the whole run reverts, nothing moves.
    step('8. A ceiling far below the market: the whole run reverts, nothing moves.');
    const low = { ...auth, nonce: 2n, assets: [assets[0], { ...assets[1], maxPriceRaw: assets[1].maxPriceRaw / 2n }] };
    const lowSig = await owner.signTypedData({ account: owner.account, domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: low });
    const lowId = hashTypedData({ domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: low });
    await owner.writeContract({ address: A.USDG, abi: ERC20, functionName: 'approve', args: [executor.address, 10n ** 12n], account: owner.account, chain: undefined });
    const before = await bal(A.USDG, owner.account.address);
    const t = (await pc.getBlock()).timestamp;
    await assert.rejects(executor.write.execute([low, { authorizationId: lowId, window: 1n, deadline: t + 600n, fees, minOutFloors: [] }, lowSig], { account: keeper.account }), /Too little received/);
    assert.equal(await bal(A.USDG, owner.account.address), before);
    assert.equal(((await executor.read.getState([owner.account.address, lowId])) as any).runs, 0);
  });
});
