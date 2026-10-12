import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import settleCreatorRewards, { config as settleConfig } from '@/netlify/functions/settle-creator-rewards.mjs';
import reconcileCreatorRewards from '@/netlify/functions/reconcile-creator-rewards.mjs';
import { config as refreshConfig } from '@/netlify/functions/refresh-asset-routes.mjs';

// The creator-reward schedules skip before invoking the route when the vault is not configured, so an
// unconfigured deployment does not spend a function run every few minutes on a guaranteed 503.

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('URL', 'https://site.example');
  vi.stubEnv('CRON_SECRET', 'a-long-enough-cron-secret-value-123456');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('creator-reward scheduled functions', () => {
  it('skip without calling the route when the vault is not configured', async () => {
    vi.stubEnv('CREATOR_REWARDS_VAULT_ADDRESS', '');
    vi.stubEnv('CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY', '');
    const settle = await settleCreatorRewards();
    expect(settle.status).toBe(200);
    expect(await settle.text()).toBe('skipped: CREATOR_REWARDS_VAULT_ADDRESS, CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY not set');
    const reconcile = await reconcileCreatorRewards();
    expect(await reconcile.text()).toBe('skipped: CREATOR_REWARDS_VAULT_ADDRESS not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('settlement also needs the settler key; reconciliation runs with the address alone', async () => {
    vi.stubEnv('CREATOR_REWARDS_VAULT_ADDRESS', '0x' + '1'.repeat(40));
    vi.stubEnv('CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY', '');
    expect(await (await settleCreatorRewards()).text()).toContain('CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY not set');
    expect(fetchMock).not.toHaveBeenCalled();
    await reconcileCreatorRewards();
    expect(fetchMock).toHaveBeenCalledWith('https://site.example/api/cron/reconcile-creator-rewards', expect.objectContaining({ method: 'POST' }));
  });

  it('call the route with the cron secret when configured', async () => {
    vi.stubEnv('CREATOR_REWARDS_VAULT_ADDRESS', '0x' + '1'.repeat(40));
    vi.stubEnv('CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY', 'set-in-netlify-only');
    const res = await settleCreatorRewards();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://site.example/api/cron/settle-creator-rewards', {
      method: 'POST',
      headers: { Authorization: 'Bearer a-long-enough-cron-secret-value-123456' },
    });
  });

  it('schedules: royalty settlement every 15 minutes, asset routes hourly', () => {
    expect(settleConfig.schedule).toBe('*/15 * * * *');
    expect(refreshConfig.schedule).toBe('0 * * * *');
  });
});
