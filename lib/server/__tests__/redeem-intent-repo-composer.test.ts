import { describe, expect, it, vi } from 'vitest';
import { createRedeemIntent } from '../redeem-intent-repo';

// The per-asset insert never names composer_transaction (works on a database without 0047); a one-transaction
// sale writes it; a row without the column reads back null.

const TX = { to: '0xabc', data: '0x01', value: '0', chainId: 4663, approvals: [] };

function fakeAdmin(returnRow: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const inserted: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        inserted.push(payload);
        return { select: () => ({ single: async () => ({ data: returnRow(payload), error: null }) }) };
      },
    }),
  };
  return { admin: admin as never, inserted };
}

const input = {
  userId: 'u',
  walletAddress: '0xw',
  bagId: 'b',
  sharesRaw: '1',
  shareDecimals: 18,
  outputAsset: { chain: 'robinhood' as const, address: '0xusdg' },
  outputDecimals: 6,
  routeFingerprint: 'fp',
  sharePriceAtQuote: '1',
  redeemValueQuote: '1',
  steps: [],
  status: 'READY' as const,
  failureCode: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const row = (p: Record<string, unknown>) => ({ ...p, id: 'r1', output_asset_chain: 'robinhood', output_asset_address: '0xusdg' });

describe('createRedeemIntent — composer_transaction', () => {
  it('per-asset: the column is not named at all, and reads back null', async () => {
    const { admin, inserted } = fakeAdmin(row);
    const created = await createRedeemIntent(admin, input);
    expect('composer_transaction' in inserted[0]).toBe(false);
    expect(created.composerTransaction).toBeNull();
  });

  it('one transaction: written and read back', async () => {
    const { admin, inserted } = fakeAdmin(row);
    const created = await createRedeemIntent(admin, { ...input, composerTransaction: TX });
    expect(inserted[0].composer_transaction).toEqual(TX);
    expect(created.composerTransaction).toEqual(TX);
  });
});
