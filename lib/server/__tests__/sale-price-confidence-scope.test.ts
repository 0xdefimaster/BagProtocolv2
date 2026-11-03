import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';
import { paymentAssetUsdPrice } from '../payment-value';

// (7) The reference-price confidence policy (sale-price-confidence.ts) applies ONLY to fee-paying sales — the
// RedeemSettlement quote (phase 1) and the legacy RedeemFeeRouter attestation. The free sale path (/execute,
// redeem-execution.ts) and every other price consumer keep reading `.price` exactly as before.

const root = join(__dirname, '..', '..', '..');
const src = (rel: string) => readFileSync(join(root, rel), 'utf8');
const POLICY_MARKERS = ['sale-price-confidence', 'referencePriceForFeeSale', 'feeSalePricePolicy', 'salePriceDeviationLimit'];

describe('(7) the non-fee sale path is not altered', () => {
  // (The read-only fee-liquidity reporter is meant to mirror the policy and is tested in fee-router-executability.test.ts.)
  it('only the two fee-sale attestation modules use the policy', () => {
    expect(src('lib/server/redeem-settlement-attestation.ts')).toContain('referencePriceForFeeSale');
    expect(src('lib/server/redeem-fee-attestation.ts')).toContain('referencePriceForFeeSale');
    for (const file of [
      'lib/server/redeem-execution.ts',
      'lib/server/payment-value.ts',
      'lib/server/purchase-execution.ts',
      'app/api/bags/[id]/redeem-preview/route.ts',
    ]) {
      const text = src(file);
      for (const m of POLICY_MARKERS) expect(text, `${file} must not use ${m}`).not.toContain(m);
    }
  });

  it('the free path still values its output with an unverified or confidence-less price', async () => {
    // A synthetic non-settlement token address — so the provider is really asked (USDG short-circuits to '1').
    const asset: AssetIdentity = { chain: 'robinhood', address: '0x00000000000000000000000000000000000071a5' };
    let calls = 0;
    const provider = (extra: Partial<AssetPrice>): PriceProvider => ({
      getPrice: async (a) => (calls++, { asset: a, price: '1', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'test', ...extra }),
    });
    await expect(paymentAssetUsdPrice(asset, provider({}))).resolves.toBe('1');
    await expect(paymentAssetUsdPrice(asset, provider({ confidence: 0.5 }))).resolves.toBe('1');
    await expect(paymentAssetUsdPrice(asset, provider({ timestamp: '' }))).resolves.toBe('1');
    expect(calls).toBe(3);
  });
});
