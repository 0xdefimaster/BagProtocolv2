import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { accountKindProblems, classifyAccountCode, validateSettlementDeployConfig, verifySettlementDeployment } from '../../lib/blockchain/redeem-settlement-deploy';

// scripts/deploy-redeem-settlement.ts's checks, against a real RedeemSettlement deployment: the read-back passes for
// a correct deployment and names every value that differs from the intent; the pre-deploy config check refuses the
// operational mistakes (three keys merged, zero/invalid addresses, wrong chain).

const A = (n: string) => `0x${n.repeat(40)}`;

async function deployed() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [ownerW, attestorW, other] = await viem.getWalletClients();
  const usdg = await viem.deployContract('HookERC20', []);
  const settlement = await viem.deployContract('RedeemSettlement', [usdg.address, attestorW.account.address, ownerW.account.address]);
  const chainId = await publicClient.getChainId();
  const expected = { chainId, usdg: usdg.address, owner: ownerW.account.address, attestor: attestorW.account.address };
  return { viem, publicClient, settlement, usdg, expected, other, ownerW };
}

const failed = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name);

describe('RedeemSettlement deployment checks (scripts/deploy-redeem-settlement.ts)', () => {
  it('a correct deployment passes every read-back check, including the EIP-712 domain', async () => {
    const { publicClient, settlement, expected } = await deployed();
    const checks = await verifySettlementDeployment(publicClient as never, settlement.address, expected);
    assert.deepEqual(failed(checks), []);
    assert.deepEqual(
      checks.map((c) => c.name),
      ['chain', 'usdg', 'owner', 'attestor', 'MAX_FEE_RATE_BPS', 'EIP-712 name', 'EIP-712 version', 'EIP-712 chainId', 'EIP-712 verifyingContract', 'USDG balance held', 'owner account', 'attestor account']
    );
  });

  it('every value that differs from the intent is reported, all at once', async () => {
    const { publicClient, settlement, expected, other } = await deployed();
    const checks = await verifySettlementDeployment(publicClient as never, settlement.address, {
      ...expected,
      chainId: 4663,
      owner: other.account.address,
      attestor: other.account.address,
      usdg: A('9'),
    });
    assert.deepEqual(failed(checks), ['chain', 'usdg', 'owner', 'attestor', 'EIP-712 chainId']);
  });

  it('a stray USDG balance at the contract is flagged', async () => {
    const { publicClient, settlement, usdg, expected } = await deployed();
    await usdg.write.mint([settlement.address, 1n]);
    const checks = await verifySettlementDeployment(publicClient as never, settlement.address, expected);
    assert.deepEqual(failed(checks), ['USDG balance held']);
  });

  it('an address with no contract fails immediately', async () => {
    const { publicClient, expected } = await deployed();
    const checks = await verifySettlementDeployment(publicClient as never, A('1') as `0x${string}`, expected);
    assert.deepEqual(failed(checks), ['contract code']);
  });

  it('a contract as owner fails unless explicitly allowed (Safe); a contract as attestor always fails — the first live deploy got a probe contract as owner', async () => {
    const { viem, publicClient, usdg } = await deployed();
    const [, attestorW] = await viem.getWalletClients();
    const probeLike = await viem.deployContract('HookERC20', []);
    const withContractOwner = await viem.deployContract('RedeemSettlement', [usdg.address, attestorW.account.address, probeLike.address]);
    const chainId = await publicClient.getChainId();
    const expected = { chainId, usdg: usdg.address, owner: probeLike.address, attestor: attestorW.account.address };
    assert.deepEqual(failed(await verifySettlementDeployment(publicClient as never, withContractOwner.address, expected)), ['owner account']);
    assert.deepEqual(failed(await verifySettlementDeployment(publicClient as never, withContractOwner.address, { ...expected, allowContractOwner: true })), []);

    const [ownerW] = await viem.getWalletClients();
    const withContractAttestor = await viem.deployContract('RedeemSettlement', [usdg.address, probeLike.address, ownerW.account.address]);
    const exp2 = { chainId, usdg: usdg.address, owner: ownerW.account.address, attestor: probeLike.address, allowContractOwner: true };
    assert.deepEqual(failed(await verifySettlementDeployment(publicClient as never, withContractAttestor.address, exp2)), ['attestor account']);
  });

  it('after the owner rotates the attestor, the old expectation no longer verifies', async () => {
    const { publicClient, settlement, expected, other } = await deployed();
    await settlement.write.setAttestor([other.account.address]);
    assert.deepEqual(failed(await verifySettlementDeployment(publicClient as never, settlement.address, expected)), ['attestor']);
    assert.deepEqual(failed(await verifySettlementDeployment(publicClient as never, settlement.address, { ...expected, attestor: other.account.address })), []);
  });
});

describe('validateSettlementDeployConfig (pre-deploy, operational guards)', () => {
  const ok = { chainId: 4663, expectedChainId: 4663, usdg: A('5'), deployer: A('1'), owner: A('2'), attestor: A('3') };

  it('three distinct keys on the right chain: go', () => {
    assert.deepEqual(validateSettlementDeployConfig(ok), []);
  });

  it('refuses merged trust boundaries (operational, not contract rules)', () => {
    assert.match(validateSettlementDeployConfig({ ...ok, owner: ok.deployer }).join(), /owner must not be the deployer/);
    assert.match(validateSettlementDeployConfig({ ...ok, attestor: ok.deployer }).join(), /attestor must not be the deployer/);
    assert.match(validateSettlementDeployConfig({ ...ok, attestor: ok.owner }).join(), /owner must not be the attestor/);
    // Same address in a different case is still the same address.
    assert.match(validateSettlementDeployConfig({ ...ok, owner: A('a'), attestor: A('A') }).join(), /owner must not be the attestor/);
  });

  it('refuses the wrong chain, zero and invalid addresses', () => {
    assert.match(validateSettlementDeployConfig({ ...ok, chainId: 1 }).join(), /chain 1 is not the expected 4663/);
    assert.match(validateSettlementDeployConfig({ ...ok, owner: A('0') }).join(), /owner is the zero address/);
    assert.match(validateSettlementDeployConfig({ ...ok, attestor: '0x1234' }).join(), /attestor is not an address/);
  });
});

describe('account kinds (pre-deploy: owner and attestor must be able to act and sign)', () => {
  const delegate = 'ab'.repeat(20);
  it('classifies no code as EOA, an EIP-7702 delegation (0xef0100 + 20 bytes, e.g. a MetaMask smart account) as EOA_7702, anything else as CONTRACT', () => {
    assert.equal(classifyAccountCode('0x'), 'EOA');
    assert.equal(classifyAccountCode(undefined), 'EOA');
    assert.equal(classifyAccountCode(`0xef0100${delegate}`), 'EOA_7702');
    assert.equal(classifyAccountCode(`0xef0100${delegate}00`), 'CONTRACT');
    assert.equal(classifyAccountCode('0x6080604052'), 'CONTRACT');
  });

  it('refuses a contract attestor always, a contract owner unless confirmed, a 7702 attestor unless confirmed; a 7702 owner passes', () => {
    assert.deepEqual(accountKindProblems({ owner: 'EOA_7702', attestor: 'EOA' }), []);
    assert.match(accountKindProblems({ owner: 'EOA', attestor: 'EOA_7702' }).join(), /attestor has an EIP-7702 delegation/);
    assert.deepEqual(accountKindProblems({ owner: 'EOA', attestor: 'EOA_7702' }, false, true), []);
    assert.match(accountKindProblems({ owner: 'CONTRACT', attestor: 'EOA' }).join(), /owner is a contract/);
    assert.deepEqual(accountKindProblems({ owner: 'CONTRACT', attestor: 'EOA' }, true), []);
    assert.match(accountKindProblems({ owner: 'EOA', attestor: 'CONTRACT' }, true).join(), /attestor is a contract/);
  });
});
