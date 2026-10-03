import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../bag-deployment-repo';

// UNIT tests (mocked Supabase client) for input validation, canonicalisation and
// outcome mapping. Database behaviour itself is covered by the integration suites.

const rpc = vi.fn();
const admin = { rpc: (...a: unknown[]) => rpc(...a) } as never;

const UUID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const INPUT = {
  bagId: UUID(1),
  creatorId: UUID(2),
  bagVersionId: UUID(3),
  chain: 'robinhood' as const,
  factoryAddress: `0x${'FA'.repeat(20)}`,
  contractAddress: `0x${'BA'.repeat(20)}`,
  txHash: `0x${'AB'.repeat(32)}` as `0x${string}`,
  blockNumber: 12,
  onChainBagId: `0x${'CC'.repeat(32)}` as `0x${string}`,
  onChainCreator: `0x${'DD'.repeat(20)}` as `0x${string}`,
};
const row = { id: 'd1', bag_id: UUID(1), chain: 'robinhood', status: 'DEPLOYED', tx_hash: `0x${'ab'.repeat(32)}`, on_chain_bag_id: `0x${'cc'.repeat(32)}`, block_number: 12, created_at: 'c', updated_at: 'u' };

beforeEach(() => vi.clearAllMocks());

describe('confirmUserSignedDeployment', () => {
  it('sends ONLY canonical lower-case values to the RPC', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'CONFIRMED', deployment: row, bag: { status: 'ACTIVE', contract_address: '0xba', registry_id: 'robinhood' } }, error: null });
    await repo.confirmUserSignedDeployment(admin, INPUT);
    expect(rpc).toHaveBeenCalledWith('confirm_bag_deployment', {
      p_bag_id: INPUT.bagId,
      p_creator_id: INPUT.creatorId,
      p_bag_version_id: INPUT.bagVersionId,
      p_chain: 'robinhood',
      p_factory_address: INPUT.factoryAddress.toLowerCase(),
      p_contract_address: INPUT.contractAddress.toLowerCase(),
      p_tx_hash: INPUT.txHash.toLowerCase(),
      p_block_number: 12,
      p_on_chain_bag_id: INPUT.onChainBagId.toLowerCase(),
      p_on_chain_creator: INPUT.onChainCreator.toLowerCase(),
    });
  });

  it.each([
    ['bagId', { bagId: 'x' }],
    ['creatorId', { creatorId: 'x' }],
    ['bagVersionId', { bagVersionId: 'x' }],
    ['txHash', { txHash: '0x12' }],
    ['onChainBagId', { onChainBagId: '0x12' }],
    ['onChainCreator', { onChainCreator: '0x12' }],
    ['contractAddress', { contractAddress: '0x12' }],
    ['factoryAddress', { factoryAddress: '0x12' }],
    ['blockNumber', { blockNumber: -1 }],
    ['blockNumber', { blockNumber: 1.5 }],
  ])('rejects a malformed %s BEFORE calling the RPC', async (_n, over) => {
    await expect(repo.confirmUserSignedDeployment(admin, { ...INPUT, ...over } as never)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFIRMED', { deployment: row, bag: { status: 'ACTIVE', contract_address: '0xba', registry_id: 'robinhood' } }, { outcome: 'CONFIRMED', bag: { status: 'ACTIVE', contractAddress: '0xba', registryId: 'robinhood' } }],
    ['ALREADY_CONFIRMED', { deployment: row, bag: { status: 'ACTIVE', contract_address: null, registry_id: null } }, { outcome: 'ALREADY_CONFIRMED' }],
    ['CONFLICT', { deployment: row }, { outcome: 'CONFLICT', deployment: { id: 'd1', txHash: row.tx_hash, onChainBagId: row.on_chain_bag_id, blockNumber: 12 } }],
    ['STALE_VERSION', {}, { outcome: 'STALE_VERSION' }],
    ['IDENTITY_TAKEN', {}, { outcome: 'IDENTITY_TAKEN' }],
    ['FORBIDDEN', {}, { outcome: 'FORBIDDEN' }],
    ['BAG_NOT_FOUND', {}, { outcome: 'BAG_NOT_FOUND' }],
  ])('maps outcome %s', async (outcome, extra, expected) => {
    rpc.mockResolvedValue({ data: { outcome, ...extra }, error: null });
    expect(await repo.confirmUserSignedDeployment(admin, INPUT)).toMatchObject(expected);
  });

  it('an RPC error and an unknown outcome both THROW — never a silent success', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(repo.confirmUserSignedDeployment(admin, INPUT)).rejects.toThrow('boom');
    rpc.mockResolvedValue({ data: { outcome: 'SOMETHING_NEW' }, error: null });
    await expect(repo.confirmUserSignedDeployment(admin, INPUT)).rejects.toThrow(/unexpected/);
  });
});

describe('no legacy backend-signed transitions remain', () => {
  it('startDeployment / confirmDeployment / failDeployment are gone from the module', () => {
    for (const name of ['startDeployment', 'confirmDeployment', 'failDeployment']) expect(name in repo).toBe(false);
  });
});
