import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { hashTypedData, keccak256, stringToHex, toHex, zeroAddress, zeroHash, type Hex } from 'viem';
import { splitByWeight } from '../../../packages/bag-sdk/src/split';
import { DCA_TYPES } from './dca-types';

// Shared local fixture for the BagDcaExecutor tests: real BagFactory/Bag and
// StrategyRegistry, mock Uniswap (contracts/mocks/dca/DcaV1Mocks.sol). Local
// Hardhat EVM only; not a fork.

export const DAY = 86_400n;
export const USDG = (x: number | bigint) => BigInt(x) * 1_000_000n;
export const E18 = 10n ** 18n;

export const REVOCATION_TYPES = { Revocation: [{ name: 'owner', type: 'address' }, { name: 'authorizationId', type: 'bytes32' }] } as const;

export type Asset = { asset: Hex; symbol: string; weightBps: number; decimals: number; maxPriceRaw: bigint };
export type Auth = {
  owner: Hex; recipient: Hex; inputToken: Hex; allowedCaller: Hex;
  bag: { bagId: Hex; bagVersion: bigint; compositionHash: Hex; definitionHash: Hex; strategyId: Hex; strategyVersion: number };
  assets: Asset[];
  schedule: { amountPerRun: bigint; totalBudget: bigint; maxRuns: number; startsAt: bigint; periodSeconds: bigint; expiresAt: bigint };
  route: { adapter: Hex; swapRouter: Hex; allowedFees: number[] };
  nonce: bigint;
};

export const compositionString = (chain: string, assets: readonly Pick<Asset, 'asset' | 'symbol' | 'decimals' | 'weightBps'>[]) =>
  assets.map((a) => `${chain}:${a.asset.toLowerCase()}:${a.symbol}:${a.decimals}:${a.weightBps}`).join('|');
export const compositionHash = (chain: string, assets: readonly Pick<Asset, 'asset' | 'symbol' | 'decimals' | 'weightBps'>[]) =>
  keccak256(stringToHex(compositionString(chain, assets)));
export const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
export const legAmountsTs = (amount: bigint, assets: readonly Asset[]) => {
  const m = splitByWeight(amount, { assets: assets.map((a) => ({ chain: 'robinhood', address: a.asset, decimals: a.decimals, weightBps: a.weightBps })) } as never);
  return assets.map((a) => m.get(`robinhood:${a.asset.toLowerCase()}`)!);
};
export const ceilingMinTs = (legIn: bigint, a: Pick<Asset, 'decimals' | 'maxPriceRaw'>) => ceilDiv(legIn * 10n ** BigInt(a.decimals), a.maxPriceRaw);

/** Deterministic PRNG (mulberry32) for property tests: failures are reproducible from the seed. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), big: (bits: number) => {
    let x = 0n;
    for (let i = 0; i < bits; i += 16) x = (x << 16n) | BigInt(Math.floor(next() * 65536));
    return x & ((1n << BigInt(bits)) - 1n);
  } };
}

export async function setup(opts: { strategy?: boolean; adapter?: 'real' | 'misbehaving' } = {}) {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [keeper, owner, other, recipient, creator] = await viem.getWalletClients();

  const usdg = await viem.deployContract('DcaToken', ['USD Global', 'USDG', 6]);
  const tsla = await viem.deployContract('DcaToken', ['Tesla', 'TSLA', 18]);
  const nvda = await viem.deployContract('DcaToken', ['Nvidia', 'NVDA', 18]);
  const v3 = await viem.deployContract('DcaMockV3Factory', []);
  const router = await viem.deployContract('DcaMockSwapRouter02', [v3.address]);
  const adapter = opts.adapter === 'misbehaving'
    ? await viem.deployContract('DcaMisbehavingAdapter', [router.address])
    : await viem.deployContract('UniswapV3ExactInAdapter', [router.address, v3.address]);
  const bagFactory = await viem.deployContract('BagFactory', [creator.account.address, creator.account.address, 0n, 10n ** 16n]);
  const registry = await viem.deployContract('StrategyRegistry', []);
  const executor = await viem.deployContract('BagDcaExecutor', [bagFactory.address, registry.address, adapter.address, 'robinhood']);

  for (const t of [tsla, nvda]) {
    await v3.write.setPool([usdg.address, t.address, 500, '0x0000000000000000000000000000000000000500']);
    await v3.write.setPool([usdg.address, t.address, 3000, '0x0000000000000000000000000000000000003000']);
    await t.write.mint([router.address, 10n ** 30n]);
    await t.write.mint([adapter.address, 0n]);
  }
  // Market: TSLA 400 USDG, NVDA 200 USDG (output raw = input raw × 1e18 / price raw).
  await router.write.setRate([tsla.address, E18, USDG(400)]);
  await router.write.setRate([nvda.address, E18, USDG(200)]);
  if (opts.adapter === 'misbehaving') {
    const bad = await viem.getContractAt('DcaMisbehavingAdapter', adapter.address);
    await bad.write.setRate([tsla.address, E18, USDG(400)]);
    await bad.write.setRate([nvda.address, E18, USDG(200)]);
    for (const t of [tsla, nvda]) await t.write.mint([adapter.address, 10n ** 30n]);
  }

  // The BAG: registered composition rows sorted by symbol (NVDA, TSLA), 50/50.
  const assets: Asset[] = [
    { asset: nvda.address, symbol: 'NVDA', weightBps: 5000, decimals: 18, maxPriceRaw: USDG(210) },
    { asset: tsla.address, symbol: 'TSLA', weightBps: 5000, decimals: 18, maxPriceRaw: USDG(420) },
  ];
  const ref = keccak256(toHex('bag:dca-test'));
  const comp = compositionHash('robinhood', assets);
  const asCreator = (c: { address: Hex; abi: any }) => viem.getContractAt(c === bagFactory ? 'BagFactory' : 'StrategyRegistry', c.address, { client: { wallet: creator } });
  await (await asCreator(bagFactory) as any).write.createBag([ref, comp, 'bag:dca-test', true]);
  const bagId = (await bagFactory.read.deriveBagId([creator.account.address, ref])) as Hex;
  const definitionHash = keccak256(toHex('definition:dca-test:v1'));
  let strategyId: Hex = zeroHash;
  if (opts.strategy) {
    await (await asCreator(registry) as any).write.registerStrategy([ref, definitionHash, '']);
    strategyId = (await registry.read.deriveStrategyId([creator.account.address, ref])) as Hex;
  }

  const now = (await publicClient.getBlock()).timestamp;
  const startsAt = now + 1000n;
  const auth: Auth = {
    owner: owner.account.address,
    recipient: recipient.account.address,
    inputToken: usdg.address,
    allowedCaller: zeroAddress,
    bag: { bagId, bagVersion: 1n, compositionHash: comp, definitionHash, strategyId, strategyVersion: opts.strategy ? 1 : 0 },
    assets,
    schedule: { amountPerRun: USDG(10), totalBudget: USDG(50), maxRuns: 5, startsAt, periodSeconds: DAY, expiresAt: startsAt + 5n * DAY },
    route: { adapter: adapter.address, swapRouter: router.address, allowedFees: [500, 3000] },
    nonce: 1n,
  };
  const chainId = await publicClient.getChainId();
  const domain = { name: 'BagDcaExecutor', version: '1', chainId, verifyingContract: executor.address } as const;

  await usdg.write.mint([owner.account.address, USDG(1000)]);
  const usdgAsOwner = await viem.getContractAt('DcaToken', usdg.address, { client: { wallet: owner } });
  await usdgAsOwner.write.approve([executor.address, USDG(50)]);

  const sign = (a: Auth, wallet = owner) => wallet.signTypedData({ account: wallet.account, domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
  const idOf = (a: Auth) => hashTypedData({ domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
  const windowAt = (a: Auth, t: bigint) => (t - a.schedule.startsAt) / a.schedule.periodSeconds;
  let lastTs = now;
  /** The next block is mined at `t` (must be after the previous one). */
  const at = async (t: bigint) => {
    await testClient.setNextBlockTimestamp({ timestamp: t });
    lastTs = t;
  };
  const execute = async (a: Auth, sig: Hex, o: { window?: bigint; deadline?: bigint; fees?: number[]; floors?: bigint[]; id?: Hex } = {}) => {
    const r = {
      authorizationId: o.id ?? idOf(a),
      window: o.window ?? windowAt(a, lastTs),
      deadline: o.deadline ?? lastTs + 600n,
      fees: o.fees ?? a.assets.map(() => 3000),
      minOutFloors: o.floors ?? [],
    };
    const hash = await executor.write.execute([a, r, sig], { account: keeper.account });
    return publicClient.waitForTransactionReceipt({ hash });
  };
  const bal = async (token: { read: any }, who: Hex) => (await token.read.balanceOf([who])) as bigint;
  const state = async (a: Auth) => (await executor.read.getState([a.owner, idOf(a)])) as { runs: number; spent: bigint; lastWindow: bigint; lastRunAt: bigint; revoked: boolean };
  return { ref, viem, publicClient, testClient, keeper, owner, other, recipient, creator, usdg, tsla, nvda, v3, router, adapter, bagFactory, registry, executor, auth, domain, sign, idOf, at, execute, bal, state, windowAt, usdgAsOwner, chainId };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;
export const clone = (a: Auth): Auth => JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

/** Snapshot of everything a failed run must leave unchanged. */
export async function snapshot(c: Ctx, a: Auth) {
  return {
    state: await c.state(a),
    owner: await c.bal(c.usdg, a.owner),
    exec: await c.bal(c.usdg, c.executor.address),
    adapter: await c.bal(c.usdg, c.adapter.address),
    tsla: await c.bal(c.tsla, a.recipient),
    nvda: await c.bal(c.nvda, a.recipient),
  };
}
export async function assertNothingMoved(c: Ctx, a: Auth, before: Awaited<ReturnType<typeof snapshot>>) {
  assert.deepEqual(await snapshot(c, a), before);
}

