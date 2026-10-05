import { describe, expect, it } from 'vitest';
import { resolveDeployedVersionId, type DeployedVersionRow } from '../deployed-version';

const TX = '0x' + 'ab'.repeat(32);
const row = (version: number, createdAt: string, onchainVersion: number | null = null): DeployedVersionRow => ({
  id: `v${version}`,
  version,
  created_at: createdAt,
  onchain_tx_hash: onchainVersion === null ? null : '0x' + String(version).repeat(64).slice(0, 64),
  onchain_version: onchainVersion,
});
const deployment = (over: Partial<{ status: string; txHash: string | null; createdAt: string; onChainVersion: number }> = {}) => ({
  status: 'DEPLOYED',
  txHash: TX,
  createdAt: '2026-10-05T13:20:00Z',
  onChainVersion: 1,
  ...over,
});

describe('resolveDeployedVersionId', () => {
  it('the live case: one version, deployed → that version is on-chain version 1', () => {
    expect(resolveDeployedVersionId([row(1, '2026-10-05T13:19:00Z')], deployment())).toBe('v1');
  });

  it('drafts before deploy: the newest version without an on-chain record is the deployed one', () => {
    const rows = [row(1, '2026-10-05T10:00:00Z'), row(2, '2026-10-05T11:00:00Z'), row(3, '2026-10-05T12:00:00Z')];
    expect(resolveDeployedVersionId(rows, deployment())).toBe('v3');
  });

  it('versions recorded on-chain after deploy (2..N) keep pointing at the deployed one', () => {
    const rows = [row(1, '2026-10-05T10:00:00Z'), row(2, '2026-10-05T14:00:00Z', 2), row(3, '2026-10-05T15:00:00Z', 3)];
    expect(resolveDeployedVersionId(rows, deployment({ onChainVersion: 3 }))).toBe('v1');
  });

  it('never guesses: not deployed, no tx, broken on-chain tail, version counter mismatch, or a version newer than the deployment', () => {
    const one = [row(1, '2026-10-05T13:19:00Z')];
    expect(resolveDeployedVersionId(one, null)).toBeNull();
    expect(resolveDeployedVersionId(one, deployment({ status: 'NOT_DEPLOYED' }))).toBeNull();
    expect(resolveDeployedVersionId(one, deployment({ txHash: null }))).toBeNull();
    // Gap in the on-chain tail.
    expect(resolveDeployedVersionId([row(1, '2026-10-05T10:00:00Z'), row(2, '2026-10-05T14:00:00Z', 3)], deployment({ onChainVersion: 3 }))).toBeNull();
    // Deployment says version 2 is on-chain but no row records it.
    expect(resolveDeployedVersionId(one, deployment({ onChainVersion: 2 }))).toBeNull();
    // A pre-0035 deployment followed by an off-chain version: that version was not the one deployed.
    expect(resolveDeployedVersionId([row(1, '2026-10-05T10:00:00Z'), row(2, '2026-10-05T14:00:00Z')], deployment())).toBeNull();
    // Every version recorded on-chain (no deploy candidate).
    expect(resolveDeployedVersionId([row(2, '2026-10-05T14:00:00Z', 2)], deployment({ onChainVersion: 2 }))).toBeNull();
  });
});
