import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeFunctionData, getAddress, keccak256, toHex, type Hex } from 'viem';

// -----------------------------------------------------------------------------
// BagVault SPIKE (in-kind mint/redeem share token). Hardhat in-process EVM
// only: nothing here is deployed anywhere. Covers the vault's own rules
// (pro-rata in kind, rounding in the vault's favour, slippage bounds,
// balance-delta transfers, mint-only pause, dead shares) and the factory's
// binding to a genuine Bag. Gas figures are printed for docs/BAG_VAULT_DESIGN.md.
// -----------------------------------------------------------------------------

const E18 = 10n ** 18n;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const DEAD_SHARES = 1_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const ref = (s: string) => keccak256(toHex(s));

async function rejects(p: Promise<unknown>, error: string) {
  await assert.rejects(p, (e: Error) => e.message.includes(error), `expected ${error}`);
}

async function setup(componentCount = 2, opts: { hookToken?: boolean } = {}) {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [creator, alice, bob, carol, guardian, stranger] = await viem.getWalletClients();
  const bagFactory = await viem.deployContract('BagFactory', [creator.account.address, creator.account.address, 0n, 10n ** 16n]);
  const vaultFactory = await viem.deployContract('BagVaultFactory', [bagFactory.address]);
  await bagFactory.write.createBag([ref('bag-1'), ref('composition-v1'), 'ipfs://bag-1', true]);
  const bagId = await bagFactory.read.deriveBagId([creator.account.address, ref('bag-1')]);
  const bag = (await bagFactory.read.bagOf([bagId])) as `0x${string}`;

  // Components: the first can be a HookERC20 (6 decimals, hook/skim), the rest plain 18-decimal tokens.
  const tokens: { address: `0x${string}`; write: any; read: any }[] = [];
  const hook = opts.hookToken ? await viem.deployContract('HookERC20', []) : null;
  if (hook) tokens.push(hook as any);
  while (tokens.length < componentCount) tokens.push((await viem.deployContract('MockToken', [`T${tokens.length}`, `T${tokens.length}`, 18])) as any);
  // Unit basket: amount of each component per 1e18 shares at the first mint.
  const units = tokens.map((_, i) => (hook && i === 0 ? 3_000_000n : (BigInt(i) + 1n) * 7n * 10n ** 17n + 3n) as bigint);

  const createHash = await vaultFactory.write.createVault([bag, 'Bag Share', 'BAGS', tokens.map((t) => t.address), units, guardian.account.address]);
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  const vaultAddress = (await vaultFactory.read.vaultOf([bag])) as `0x${string}`;
  const vault = await viem.getContractAt('BagVault', vaultAddress);
  const as = (w: typeof alice) => viem.getContractAt('BagVault', vaultAddress, { client: { wallet: w } });

  const fund = async (w: typeof alice, amount = 10n ** 30n) => {
    for (const t of tokens) {
      await t.write.mint([w.account.address, amount]);
      const tw = await viem.getContractAt(hook && t.address === hook.address ? 'HookERC20' : 'MockToken', t.address, { client: { wallet: w } });
      await tw.write.approve([vaultAddress, 2n ** 255n]);
    }
  };
  const balances = async (who: `0x${string}`) => Promise.all(tokens.map((t) => t.read.balanceOf([who]) as Promise<bigint>));
  const max = () => tokens.map(() => 2n ** 255n);
  const zero = () => tokens.map(() => 0n);
  const gas = async (hash: Hex) => (await publicClient.waitForTransactionReceipt({ hash })).gasUsed;
  return { viem, publicClient, creator, alice, bob, carol, guardian, stranger, bagFactory, vaultFactory, bag, tokens, hook, units, vault, vaultAddress, as, fund, balances, max, zero, gas, createGas: createReceipt.gasUsed };
}

describe('BagVaultFactory — one vault per genuine Bag, created by its creator', () => {
  it('records the Bag and its composition version/hash; isCurrentComposition follows the Bag', async () => {
    const { vault, vaultFactory, bag, bagFactory, creator } = await setup();
    assert.equal(getAddress(await vault.read.bag()), getAddress(bag));
    assert.equal(await vault.read.bagVersion(), 1n);
    assert.equal(await vault.read.compositionHash(), ref('composition-v1'));
    assert.equal(await vault.read.isCurrentComposition(), true);
    await bagFactory.write.recordBagVersion([ref('bag-1'), 1n, ref('composition-v2'), 'ipfs://bag-1/v2'], { account: creator.account });
    // The vault keeps its fixed composition; it now says it is not the Bag's current one.
    assert.equal(await vault.read.isCurrentComposition(), false);
    await rejects(vaultFactory.write.createVault([bag, 'x', 'x', [bag], [1n], creator.account.address]), 'VaultExists');
  });

  it('refuses a non-creator, a non-factory Bag and bad component lists', async () => {
    const { viem, vaultFactory, alice, creator, bagFactory, tokens } = await setup();
    await bagFactory.write.createBag([ref('bag-2'), ref('c'), '', true]);
    const bag2 = (await bagFactory.read.bagOf([await bagFactory.read.deriveBagId([creator.account.address, ref('bag-2')])])) as `0x${string}`;
    const asAlice = await viem.getContractAt('BagVaultFactory', vaultFactory.address, { client: { wallet: alice } });
    await rejects(asAlice.write.createVault([bag2, 'x', 'x', [tokens[0].address], [1n], alice.account.address]), 'NotBagCreator');
    // A look-alike Bag not registered by the trusted factory.
    const otherFactory = await viem.deployContract('BagFactory', [creator.account.address, creator.account.address, 0n, 1n]);
    await otherFactory.write.createBag([ref('fake'), ref('c'), '', true]);
    const fake = (await otherFactory.read.bagOf([await otherFactory.read.deriveBagId([creator.account.address, ref('fake')])])) as `0x${string}`;
    await rejects(vaultFactory.write.createVault([fake, 'x', 'x', [tokens[0].address], [1n], creator.account.address]), 'NotAFactoryBag');
    await rejects(vaultFactory.write.createVault([bag2, 'x', 'x', [tokens[0].address, tokens[0].address], [1n, 1n], creator.account.address]), 'DuplicateComponent');
    await rejects(vaultFactory.write.createVault([bag2, 'x', 'x', [tokens[0].address], [0n], creator.account.address]), 'ZeroUnitAmount');
    await rejects(vaultFactory.write.createVault([bag2, 'x', 'x', [], [], creator.account.address]), 'NoComponents');
    await rejects(vaultFactory.write.createVault([bag2, 'x', 'x', [tokens[0].address], [1n, 2n], creator.account.address]), 'LengthMismatch');
  });
});

describe('BagVault — mint and redeem in kind', () => {
  it('first mint: pays the unit basket for shares + dead shares (rounded up); dead shares are locked', async () => {
    const { as, alice, vault, units, fund, balances, max, vaultAddress } = await setup();
    await fund(alice);
    const before = await balances(alice.account.address);
    const shares = 5n * E18;
    await (await as(alice)).write.mint([shares, alice.account.address, max()]);
    const paid = (await balances(alice.account.address)).map((b, i) => before[i] - b);
    assert.deepEqual(paid, units.map((u) => ceilDiv((shares + DEAD_SHARES) * u, E18)));
    assert.deepEqual(await vault.read.holdings(), paid);
    assert.deepEqual(await balances(vaultAddress), paid);
    assert.equal(await vault.read.balanceOf([alice.account.address]), shares);
    assert.equal(await vault.read.balanceOf([DEAD]), DEAD_SHARES);
    assert.equal(await vault.read.totalSupply(), shares + DEAD_SHARES);
  });

  it('first mint below the minimum is refused', async () => {
    const { as, alice, fund, max } = await setup();
    await fund(alice);
    await rejects((await as(alice)).write.mint([10n ** 9n - 1n, alice.account.address, max()]), 'FirstMintTooSmall');
  });

  it('later mints are pro-rata to holdings, rounded up; redeem is pro-rata, rounded down', async () => {
    const { as, alice, bob, vault, fund, balances, max, zero } = await setup();
    await fund(alice);
    await fund(bob);
    await (await as(alice)).write.mint([3n * E18 + 7n, alice.account.address, max()]);
    const holdings = (await vault.read.holdings()) as bigint[];
    const supply = (await vault.read.totalSupply()) as bigint;

    const shares = 1234567891234567n;
    const expectedIn = holdings.map((h) => ceilDiv(shares * h, supply));
    assert.deepEqual(await vault.read.previewMint([shares]), expectedIn);
    const b0 = await balances(bob.account.address);
    await (await as(bob)).write.mint([shares, bob.account.address, max()]);
    assert.deepEqual((await balances(bob.account.address)).map((b, i) => b0[i] - b), expectedIn);

    const h2 = (await vault.read.holdings()) as bigint[];
    const s2 = (await vault.read.totalSupply()) as bigint;
    const expectedOut = h2.map((h) => (shares * h) / s2);
    const b1 = await balances(bob.account.address);
    await (await as(bob)).write.redeem([shares, bob.account.address, zero()]);
    assert.deepEqual((await balances(bob.account.address)).map((b, i) => b - b1[i]), expectedOut);
    assert.equal(await vault.read.balanceOf([bob.account.address]), 0n);
    // Bob ends with no more of any component than he started with.
    (await balances(bob.account.address)).forEach((b, i) => assert.ok(b <= b0[i]));
  });

  it('redeem can pay to another receiver and only burns the caller’s own shares', async () => {
    const { as, alice, bob, carol, vault, fund, balances, zero, max } = await setup();
    await fund(alice);
    await (await as(alice)).write.mint([2n * E18, alice.account.address, max()]);
    await (await as(alice)).write.redeem([E18, carol.account.address, zero()]);
    assert.ok((await balances(carol.account.address)).every((b) => b > 0n));
    await rejects((await as(bob)).write.redeem([1n, bob.account.address, zero()]), 'ERC20InsufficientBalance');
    assert.equal(await vault.read.balanceOf([alice.account.address]), E18);
  });

  it('rounding always favours the vault: repeated tiny mint/redeem cycles never extract value', async () => {
    const { as, alice, bob, vault, fund, balances, max, zero } = await setup(3);
    await fund(alice);
    await fund(bob);
    await (await as(alice)).write.mint([E18 + 12345n, alice.account.address, max()]);
    const start = await balances(bob.account.address);
    const holdingsPerShareBefore = ((await vault.read.holdings()) as bigint[]).map((h) => h);
    const supplyBefore = (await vault.read.totalSupply()) as bigint;
    for (const s of [1n, 3n, 7n, 999n, 1_000_003n]) {
      await (await as(bob)).write.mint([s, bob.account.address, max()]);
      await (await as(bob)).write.redeem([s, bob.account.address, zero()]);
    }
    const end = await balances(bob.account.address);
    end.forEach((b, i) => assert.ok(b <= start[i], `component ${i}: bob gained ${b - start[i]}`));
    // Value per share for the remaining holders did not go down.
    const holdingsAfter = (await vault.read.holdings()) as bigint[];
    const supplyAfter = (await vault.read.totalSupply()) as bigint;
    holdingsAfter.forEach((h, i) => assert.ok(h * supplyBefore >= holdingsPerShareBefore[i] * supplyAfter));
  });

  it('slippage bounds: mint above maxAmountsIn and redeem below minAmountsOut revert', async () => {
    const { as, alice, vault, fund, max } = await setup();
    await fund(alice);
    await (await as(alice)).write.mint([2n * E18, alice.account.address, max()]);
    const needed = (await vault.read.previewMint([E18])) as bigint[];
    await rejects((await as(alice)).write.mint([E18, alice.account.address, needed.map((n, i) => (i === 1 ? n - 1n : n))]), 'AboveMaxAmountIn');
    await (await as(alice)).write.mint([E18, alice.account.address, needed]); // exact ceiling passes
    const out = (await vault.read.previewRedeem([E18])) as bigint[];
    await rejects((await as(alice)).write.redeem([E18, alice.account.address, out.map((o, i) => (i === 0 ? o + 1n : o))]), 'BelowMinAmountOut');
    await (await as(alice)).write.redeem([E18, alice.account.address, out]);
  });

  it('refuses zero shares, a zero receiver and wrong-length bounds', async () => {
    const { as, alice, fund, max } = await setup();
    await fund(alice);
    const v = await as(alice);
    await rejects(v.write.mint([0n, alice.account.address, max()]), 'ZeroShares');
    await rejects(v.write.mint([E18, '0x0000000000000000000000000000000000000000', max()]), 'ZeroAddress');
    await rejects(v.write.mint([E18, alice.account.address, [1n]]), 'LengthMismatch');
  });
});

describe('BagVault — hostile tokens and callers', () => {
  it('reentrancy: a token calling back into mint or redeem mid-transfer is rejected', async () => {
    const { viem, as, alice, hook, vault, vaultAddress, fund, max, zero } = await setup(2, { hookToken: true });
    await fund(alice);
    await (await as(alice)).write.mint([2n * E18, alice.account.address, max()]);
    const attacker = await viem.deployContract('ReentrantExecutionTarget', [vaultAddress]);
    // Give the attacker shares, so a re-entrant redeem would succeed if the guard were missing.
    await (await as(alice)).write.transfer([attacker.address, E18 / 2n]);
    const tokens = (await vault.read.components())[0] as `0x${string}`[];

    // Redeem path: the vault sends the hook token → the token calls the attacker → attacker re-enters redeem.
    await attacker.write.setReentrantCallData([encodeFunctionData({ abi: vault.abi, functionName: 'redeem', args: [1n, attacker.address, tokens.map(() => 0n)] })]);
    await hook!.write.arm([vaultAddress, attacker.address, encodeFunctionData({ abi: attacker.abi, functionName: 'attack' }), false]);
    await (await as(alice)).write.redeem([E18 / 4n, alice.account.address, zero()]);
    assert.equal(await attacker.read.didAttemptReentry(), true);
    assert.equal(await attacker.read.reentryReverted(), true);

    // Mint path: the vault pulls the hook token from alice → attacker re-enters mint.
    await attacker.write.setReentrantCallData([encodeFunctionData({ abi: vault.abi, functionName: 'mint', args: [1n, attacker.address, tokens.map(() => 2n ** 255n)] })]);
    await hook!.write.arm([alice.account.address, attacker.address, encodeFunctionData({ abi: attacker.abi, functionName: 'attack' }), false]);
    await (await as(alice)).write.mint([E18, alice.account.address, max()]);
    assert.equal(await attacker.read.reentryReverted(), true);
  });

  it('fee-on-transfer: a token that delivers less than asked is refused (mint)', async () => {
    const { as, alice, hook, fund, max } = await setup(2, { hookToken: true });
    await fund(alice);
    await hook!.write.arm([alice.account.address, '0x0000000000000000000000000000000000000000', '0x', true]); // skim 1 unit
    await rejects((await as(alice)).write.mint([2n * E18, alice.account.address, max()]), 'TransferAmountMismatch');
  });

  it('fee-on-transfer on the way out is refused too (redeem)', async () => {
    const { as, alice, hook, vaultAddress, fund, max, zero } = await setup(2, { hookToken: true });
    await fund(alice);
    await (await as(alice)).write.mint([2n * E18, alice.account.address, max()]);
    await hook!.write.arm([vaultAddress, '0x0000000000000000000000000000000000000000', '0x', true]);
    await rejects((await as(alice)).write.redeem([E18, alice.account.address, zero()]), 'TransferAmountMismatch');
  });

  it('pause stops mint only; redeem always works; only the guardian can pause, and can renounce', async () => {
    const { viem, as, alice, guardian, stranger, vault, vaultAddress, fund, max, zero } = await setup();
    await fund(alice);
    await (await as(alice)).write.mint([2n * E18, alice.account.address, max()]);
    await rejects((await as(stranger)).write.setMintPaused([true]), 'NotGuardian');
    const g = await viem.getContractAt('BagVault', vaultAddress, { client: { wallet: guardian } });
    await g.write.setMintPaused([true]);
    await rejects((await as(alice)).write.mint([E18, alice.account.address, max()]), 'MintPaused');
    await (await as(alice)).write.redeem([E18, alice.account.address, zero()]); // still works
    await g.write.setMintPaused([false]);
    await (await as(alice)).write.mint([E18, alice.account.address, max()]);
    await g.write.setGuardian(['0x0000000000000000000000000000000000000000']);
    await rejects(g.write.setMintPaused([true]), 'NotGuardian');
    assert.equal(await vault.read.mintPaused(), false);
  });

  it('inflation / donation attack: a donation moves no price, and the supply never returns to zero', async () => {
    const { viem, as, alice, bob, vault, vaultAddress, tokens, units, fund, balances, max, zero } = await setup();
    await fund(alice);
    await fund(bob);
    // Attacker (alice) takes the first mint at the minimum size, then donates a large amount directly.
    const minShares = 10n ** 9n;
    const a0 = await balances(alice.account.address);
    await (await as(alice)).write.mint([minShares, alice.account.address, max()]);
    for (const t of tokens) {
      const tw = await viem.getContractAt('MockToken', t.address, { client: { wallet: alice } });
      await tw.write.transfer([vaultAddress, 10n ** 24n]);
    }
    // The donation is not counted: the victim pays the same per share as the attacker did.
    const holdings = (await vault.read.holdings()) as bigint[];
    assert.deepEqual(holdings, units.map((u) => ceilDiv((minShares + DEAD_SHARES) * u, E18)));
    const victimShares = 10n * E18;
    const cost = (await vault.read.previewMint([victimShares])) as bigint[];
    const supply = (await vault.read.totalSupply()) as bigint;
    cost.forEach((c, i) => assert.equal(c, ceilDiv(victimShares * holdings[i], supply)));
    await (await as(bob)).write.mint([victimShares, bob.account.address, cost]);

    // Victim redeems at once: loses at most rounding dust, never the donation-sized amount.
    const bBefore = await balances(bob.account.address);
    await (await as(bob)).write.redeem([victimShares, bob.account.address, zero()]);
    (await balances(bob.account.address)).forEach((b, i) => assert.ok(cost[i] - (b - bBefore[i]) <= 2n, `component ${i} lost ${cost[i] - (b - bBefore[i])}`));

    // Attacker redeems everything: gets back no more than deposited (the donation is lost to them) and supply stays > 0.
    await (await as(alice)).write.redeem([minShares, alice.account.address, zero()]);
    assert.equal(await vault.read.totalSupply(), DEAD_SHARES);
    (await balances(alice.account.address)).forEach((b, i) => assert.ok(b < a0[i]));
  });
});

describe('BagVault — invariants over many users', () => {
  it('holdings equal token balances; value per share never decreases; users in aggregate never take out more than they put in', async () => {
    const { as, alice, bob, carol, vault, vaultAddress, fund, balances, max, zero } = await setup(3);
    const users = [alice, bob, carol];
    for (const u of users) await fund(u);
    const start = await Promise.all(users.map((u) => balances(u.account.address)));
    await (await as(alice)).write.mint([E18, alice.account.address, max()]);

    let seed = 42n;
    const rand = (m: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), seed % m);
    for (let step = 0; step < 40; step++) {
      const u = users[Number(rand(3n))];
      const v = await as(u);
      const supply = (await vault.read.totalSupply()) as bigint;
      const before = (await vault.read.holdings()) as bigint[];
      const owned = (await vault.read.balanceOf([u.account.address])) as bigint;
      if (rand(2n) === 0n || owned === 0n) await v.write.mint([1n + rand(3n * E18), u.account.address, max()]);
      else await v.write.redeem([1n + rand(owned), u.account.address, zero()]);
      const after = (await vault.read.holdings()) as bigint[];
      const supplyAfter = (await vault.read.totalSupply()) as bigint;
      assert.deepEqual(await balances(vaultAddress), after); // internal holdings == balances (no donations here)
      after.forEach((h, i) => assert.ok(h * supply >= before[i] * supplyAfter, `value per share fell at step ${step}`));
    }
    // Everyone redeems everything. Rounding gains accrue to whoever holds
    // shares at the time (that is the point of rounding in the vault's
    // favour), so one user may end slightly up; but in aggregate the users
    // can never take out more than they put in: what they lost in total is
    // exactly what stays in the vault for the dead shares.
    for (const u of users) {
      const owned = (await vault.read.balanceOf([u.account.address])) as bigint;
      if (owned > 0n) await (await as(u)).write.redeem([owned, u.account.address, zero()]);
    }
    const end = await Promise.all(users.map((u) => balances(u.account.address)));
    const left = (await vault.read.holdings()) as bigint[];
    left.forEach((h, i) => {
      const net = start.reduce((sum, bs) => sum + bs[i], 0n) - end.reduce((sum, bs) => sum + bs[i], 0n);
      assert.equal(net, h); // conservation
      assert.ok(h > 0n); // the dead shares' basket stays
    });
    assert.equal(await vault.read.totalSupply(), DEAD_SHARES);
  });
});

describe('BagVault — gas (printed for the design doc)', () => {
  for (const n of [2, 5, 10]) {
    it(`${n} components`, async () => {
      const { as, alice, bob, fund, max, zero, gas, createGas } = await setup(n);
      await fund(alice);
      await fund(bob);
      const firstMint = await gas(await (await as(alice)).write.mint([E18, alice.account.address, max()]));
      const mint = await gas(await (await as(bob)).write.mint([E18, bob.account.address, max()]));
      const redeem = await gas(await (await as(bob)).write.redeem([E18 / 2n, bob.account.address, zero()]));
      console.log(`    gas n=${n}: createVault=${createGas} firstMint=${firstMint} mint=${mint} redeem=${redeem}`);
      assert.ok(mint > 0n && redeem > 0n);
    });
  }
});
