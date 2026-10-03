import { describe, it, expect, vi } from 'vitest';
import {
  runReconciliation,
  type ReconciliationRepo,
  type ReconciliationRepoRow,
  type VaultReadClient,
} from '../creator-rewards-reconciliation';
import { ROBINHOOD_CHAIN_ID } from '@/lib/config/robinhood-chain';

function makeRow(overrides: Partial<ReconciliationRepoRow> = {}): ReconciliationRepoRow {
  return {
    id: 'row-1',
    status: 'CONFIRMED',
    settlementRefId: '0x' + '11'.repeat(32),
    updatedAtMs: 1_000_000,
    ...overrides,
  };
}

function makeRepo(rows: ReconciliationRepoRow[]): ReconciliationRepo {
  return { getRowsToReconcile: async () => rows };
}

function makeChain(overrides: Partial<VaultReadClient> = {}): VaultReadClient {
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    isRefUsed: vi.fn().mockResolvedValue(true),
    getSolvency: vi.fn().mockResolvedValue({ totalOutstanding: BigInt(0), vaultTokenBalance: BigInt(0) }),
    ...overrides,
  };
}

describe('runReconciliation', () => {
  it('fails closed if the connected chain is not Robinhood Chain mainnet', async () => {
    const chain = makeChain({ chainId: 999 });
    await expect(runReconciliation(makeRepo([]), chain)).rejects.toThrow(/Robinhood Chain mainnet/);
  });

  it('reports nothing when every CONFIRMED row is genuinely settled on-chain and the vault is solvent', async () => {
    const repo = makeRepo([makeRow({ status: 'CONFIRMED' })]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(true) });

    const report = await runReconciliation(repo, chain);

    expect(report.checkedRows).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it('CASE A — CONFIRMED in the DB but refUsed is false on-chain', async () => {
    const repo = makeRepo([makeRow({ id: 'row-a', status: 'CONFIRMED', settlementRefId: '0xabc' })]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(false) });

    const report = await runReconciliation(repo, chain);

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      type: 'CONFIRMED_BUT_NOT_ONCHAIN',
      settlementRowId: 'row-a',
      refId: '0xabc',
    });
  });

  it('CASE A variant — CONFIRMED with no settlement_ref_id at all is flagged without even calling the chain', async () => {
    const repo = makeRepo([makeRow({ id: 'row-a2', status: 'CONFIRMED', settlementRefId: null })]);
    const isRefUsed = vi.fn();
    const chain = makeChain({ isRefUsed });

    const report = await runReconciliation(repo, chain);

    expect(isRefUsed).not.toHaveBeenCalled();
    expect(report.issues).toEqual([
      expect.objectContaining({ type: 'CONFIRMED_BUT_NOT_ONCHAIN', settlementRowId: 'row-a2' }),
    ]);
  });

  it('CASE B — refUsed is true on-chain but the row is still SUBMITTED in the DB (worker crashed before markConfirmed)', async () => {
    const repo = makeRepo([
      makeRow({ id: 'row-b', status: 'SUBMITTED', settlementRefId: '0xdef', updatedAtMs: 1_000_000 }),
    ]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(true) });

    const report = await runReconciliation(repo, chain, () => 1_000_000 + 1000); // barely any time has passed — would NOT be stale on its own

    expect(report.issues).toEqual([
      expect.objectContaining({ type: 'ONCHAIN_BUT_NOT_CONFIRMED_IN_DB', settlementRowId: 'row-b', refId: '0xdef' }),
    ]);
  });

  it('CASE C — a PENDING_SETTLEMENT row with no on-chain settlement, stuck past the staleness threshold', async () => {
    const repo = makeRepo([
      makeRow({ id: 'row-c', status: 'PENDING_SETTLEMENT', settlementRefId: null, updatedAtMs: 0 }),
    ]);
    const chain = makeChain();

    const report = await runReconciliation(repo, chain, () => 2 * 60 * 60 * 1000, 60 * 60 * 1000); // 2h elapsed, 1h threshold

    expect(report.issues).toEqual([expect.objectContaining({ type: 'STALE_PENDING', settlementRowId: 'row-c' })]);
  });

  it('a SUBMITTED row NOT yet past the staleness threshold produces no issue (still just in-flight)', async () => {
    const repo = makeRepo([
      makeRow({ id: 'row-fresh', status: 'SUBMITTED', settlementRefId: '0xfresh', updatedAtMs: 0 }),
    ]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(false) });

    const report = await runReconciliation(repo, chain, () => 5 * 60 * 1000, 60 * 60 * 1000); // 5 minutes elapsed, 1h threshold

    expect(report.issues).toEqual([]);
  });

  it('CASE D — vault token balance is less than totalOutstanding, reported even with zero DB rows to check', async () => {
    const repo = makeRepo([]);
    const chain = makeChain({
      getSolvency: vi.fn().mockResolvedValue({ totalOutstanding: BigInt(100), vaultTokenBalance: BigInt(40) }),
    });

    const report = await runReconciliation(repo, chain);

    expect(report.issues).toEqual([expect.objectContaining({ type: 'VAULT_UNDERFUNDED' })]);
  });

  it('never calls anything resembling a write/settle/withdraw path — read-only by construction (repo/chain interfaces expose no such methods)', async () => {
    // Type-level guarantee mostly, but assert at runtime too: the chain
    // fake below has no settleReward/withdraw method, and the function
    // still completes normally, proving it never needed one.
    const repo = makeRepo([makeRow({ status: 'CONFIRMED', settlementRefId: '0x1' })]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(true) });

    await expect(runReconciliation(repo, chain)).resolves.toBeDefined();
  });

  it('reports multiple distinct issues across different rows in one run', async () => {
    const repo = makeRepo([
      makeRow({ id: 'ok-row', status: 'CONFIRMED', settlementRefId: '0xok' }),
      makeRow({ id: 'bad-row', status: 'CONFIRMED', settlementRefId: '0xbad' }),
      makeRow({ id: 'stuck-row', status: 'SUBMITTED', settlementRefId: null, updatedAtMs: 0 }),
    ]);
    const chain = makeChain({
      isRefUsed: vi.fn(async (refId: string) => refId === '0xok'),
    });

    const report = await runReconciliation(repo, chain, () => 2 * 60 * 60 * 1000, 60 * 60 * 1000);

    expect(report.checkedRows).toBe(3);
    const types = report.issues.map((i) => i.type).sort();
    expect(types).toEqual(['CONFIRMED_BUT_NOT_ONCHAIN', 'STALE_PENDING']);
  });
});
