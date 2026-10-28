import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { resolveLifiComposerAccount, type ComposerAccountClient } from '../src/adapters/lifi';
import type { Hex } from '../src';

const address = (digit: string) => ('0x' + digit.repeat(40)) as Hex;
const SIGNER = address('1'), FACTORY = address('2'), PROXY = address('3'), OTHER = address('4');
const BLOCK = ('0x' + '5'.repeat(64)) as Hex;
const CODE = '0x60006000' as Hex;
const deployment = { chainId: 4663, factory: FACTORY, factoryCodeHash: keccak256(CODE) };
function setup(deployed = true) {
  const client = {
    getChainId: vi.fn(async () => 4663), getBlockNumber: vi.fn(async () => BigInt(100)),
    getBlock: vi.fn(async () => ({ hash: BLOCK })),
    getCode: vi.fn(async ({ address: a }: { address: Hex; blockNumber: bigint }) => a === FACTORY ? CODE : deployed ? '0x6001' as Hex : undefined),
    readContract: vi.fn(async ({ functionName }: { functionName: string; address: Hex; abi: readonly unknown[]; args?: readonly unknown[]; blockNumber: bigint }): Promise<unknown> => functionName === 'predictProxyAddress' ? PROXY : functionName === 'owner' ? SIGNER : FACTORY),
  } satisfies ComposerAccountClient;
  const run = () => resolveLifiComposerAccount({ chainId: 4663, signer: SIGNER, deployment, client });
  return { client, run };
}
describe('independent Composer account resolution', () => {
  it('pins the factory runtime, predicts the wallet proxy and checks its owner/factory at one block', async () => {
    const f = setup(); const result = await f.run();
    expect(result).toMatchObject({ signer: SIGNER, factory: FACTORY, proxy: PROXY, proxyDeployed: true, blockNumber: BigInt(100), blockHash: BLOCK });
    expect(result.trust).toEqual({ chainId: 4663, allowedTransactionTargets: [PROXY], allowedApprovalSpenders: [PROXY] });
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: FACTORY, functionName: 'predictProxyAddress', args: [SIGNER], blockNumber: BigInt(100) }));
    expect(f.client.getCode.mock.calls.every(([args]) => args.blockNumber === BigInt(100))).toBe(true);
    expect(Object.isFrozen(result.trust.allowedTransactionTargets)).toBe(true);
  });
  it('allows only the pinned factory target on first use, keeping approval limited to the predicted proxy', async () => {
    const f = setup(false); const result = await f.run();
    expect(result.proxyDeployed).toBe(false);
    expect(result.trust.allowedTransactionTargets).toEqual([FACTORY]);
    expect(result.trust.allowedApprovalSpenders).toEqual([PROXY]);
    expect(f.client.readContract).toHaveBeenCalledTimes(1);
  });
  it('accepts an explicit empty runtime as an undeployed proxy', async () => {
    const f = setup(false); f.client.getCode.mockImplementation(async ({ address: a }) => a === FACTORY ? CODE : '0x');
    expect((await f.run()).proxyDeployed).toBe(false);
  });
  it('rejects mismatched chains before reading any code', async () => {
    const f = setup(); f.client.getChainId.mockResolvedValue(1);
    await expect(f.run()).rejects.toThrow('chain mismatch');
    expect(f.client.getCode).not.toHaveBeenCalled();
  });
  it.each([undefined, '0x', '0x123', '0x6002'] as const)('rejects missing, malformed or changed factory runtime (%s)', async code => {
    const f = setup(); f.client.getCode.mockResolvedValue(code);
    await expect(f.run()).rejects.toThrow('factory runtime');
    expect(f.client.readContract).not.toHaveBeenCalled();
  });
  it.each(['0x', address('0'), SIGNER, FACTORY, 42] as const)('rejects invalid predicted proxy %s', async proxy => {
    const f = setup(); f.client.readContract.mockResolvedValue(proxy);
    await expect(f.run()).rejects.toThrow('predicted proxy');
  });
  it.each(['owner', 'factory'])('rejects a deployed proxy with wrong %s', async wrong => {
    const f = setup(); f.client.readContract.mockImplementation(async ({ functionName }) => functionName === 'predictProxyAddress' ? PROXY : functionName === wrong ? OTHER : functionName === 'owner' ? SIGNER : FACTORY);
    await expect(f.run()).rejects.toThrow('owner or factory mismatch');
  });
  it('rejects a reorg during reads', async () => {
    const f = setup(); f.client.getBlock.mockResolvedValueOnce({ hash: BLOCK }).mockResolvedValueOnce({ hash: ('0x' + '6'.repeat(64)) as Hex });
    await expect(f.run()).rejects.toThrow('canonical inclusion changed');
  });
  it('validates the caller deployment pin before RPC access and propagates unavailable reads', async () => {
    const f = setup();
    for (const bad of [{ ...deployment, chainId: 1 }, { ...deployment, factory: address('0') }, { ...deployment, factoryCodeHash: '0x' as Hex }]) {
      await expect(resolveLifiComposerAccount({ chainId: 4663, signer: SIGNER, deployment: bad, client: f.client })).rejects.toThrow('independently pinned');
    }
    expect(f.client.getChainId).not.toHaveBeenCalled();
    f.client.getBlockNumber.mockRejectedValue(new Error('unavailable'));
    await expect(f.run()).rejects.toThrow('unavailable');
  });
});
