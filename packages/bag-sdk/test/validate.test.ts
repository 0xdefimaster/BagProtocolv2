import { describe, expect, it } from 'vitest';
import { parseBag, validateBag, type BagDocument, type TokenInfo } from '../src';
import { EXTERNAL_DEFINITION_HASH, externalBag } from './helpers';

const doc = (mutate: (d: any) => void = () => {}): BagDocument => {
  const raw = externalBag();
  mutate(raw);
  const r = parseBag(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};
const tokens: TokenInfo[] = [
  { chain: 'robinhood', address: '0xA0000000000000000000000000000000000000AA', decimals: 18 },
  { chain: 'robinhood', address: '0xb0000000000000000000000000000000000000bb', decimals: 18 },
];
const errorCodes = (bag: BagDocument, t: TokenInfo[] = tokens) => validateBag(bag, { tokens: t }).errors.map((e) => `${e.code}@${e.path}`);

describe('validateBag', () => {
  it('the external file is valid and hashes to the published vector', () => {
    const v = validateBag(doc(), { tokens });
    expect(v).toEqual({ valid: true, definitionHash: EXTERNAL_DEFINITION_HASH, errors: [], warnings: [] });
  });

  it('duplicate token (same chain + address, any case) → reject', () => {
    const bag = doc((d) => {
      d.definition.assets[1].address = d.definition.assets[0].address.toLowerCase();
      d.definition.assets[0].weightBps = 5000;
      d.definition.assets[1].weightBps = 5000;
      delete d.metadata;
    });
    expect(errorCodes(bag)).toContain('DUPLICATE_ASSET@definition.assets[1].address');
  });

  it('wrong decimals → reject (against the token information the caller supplies)', () => {
    expect(errorCodes(doc((d) => (d.definition.assets[0].decimals = 6)))).toEqual(['DECIMALS_MISMATCH@definition.assets[0].decimals']);
    expect(errorCodes(doc(), [{ ...tokens[0], decimals: 6 }, tokens[1]])).toEqual(['DECIMALS_MISMATCH@definition.assets[1].decimals']);
  });

  it('without token information the decimals are not claimed as checked', () => {
    const v = validateBag(doc());
    expect(v.valid).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(['DECIMALS_NOT_CHECKED']);
    expect(validateBag(doc((d) => (d.definition.assets[0].decimals = 19))).errors.map((e) => e.code)).toEqual(['INVALID_DECIMALS']);
  });

  it('foreign-chain asset → reject (D2: a v1 strategy is single-chain)', () => {
    const bag = doc((d) => {
      d.definition.assets[0].chain = 'ethereum';
      delete d.metadata;
    });
    expect(errorCodes(bag, [{ ...tokens[0] }, { ...tokens[1], chain: 'ethereum' }])).toEqual(['ASSET_CHAIN_MISMATCH@definition.assets[0].chain']);
  });

  it('weights must sum to exactly 10000: no unallocated or over-allocated remainder', () => {
    for (const w of [5998, 5999, 6001, 6002, 5000]) {
      expect(errorCodes(doc((d) => (d.definition.assets[0].weightBps = w)))).toEqual(['WEIGHTS_NOT_100@definition.assets']);
    }
    expect(errorCodes(doc())).toEqual([]);
  });

  it('weights respect the declared bounds', () => {
    expect(errorCodes(doc((d) => (d.definition.rules.weightBounds.maxBps = 5000)))).toEqual(['ABOVE_MAX_WEIGHT@definition.assets[0].weightBps']);
    expect(errorCodes(doc((d) => (d.definition.rules.weightBounds.minBps = 4500)))).toEqual(['BELOW_MIN_WEIGHT@definition.assets[1].weightBps']);
    expect(errorCodes(doc((d) => (d.definition.rules.weightBounds = { minBps: 8000, maxBps: 7000 })))).toEqual(['INVALID_WEIGHT_BOUNDS@definition.rules.weightBounds']);
  });

  it('a null bound is checked against the frozen v1 default, which is never written into the document', () => {
    const bag = doc((d) => {
      d.definition.rules.weightBounds.maxBps = null;
      d.definition.assets[0].weightBps = 8000;
      d.definition.assets[1].weightBps = 2000;
    });
    const v = validateBag(bag, { tokens });
    expect(v.errors.map((e) => e.code)).toEqual(['ABOVE_MAX_WEIGHT']);
    expect(v.errors[0].message).toMatch(/v1 default/);
    expect(bag.definition.rules.weightBounds.maxBps).toBeNull();
  });

  it('rule ranges: fee cap, slippage (0 is "not set" and must be null), drift, maxAssets', () => {
    expect(errorCodes(doc((d) => (d.definition.rules.performanceFeeBps = 3001)))).toEqual(['INVALID_PERFORMANCE_FEE@definition.rules.performanceFeeBps']);
    expect(errorCodes(doc((d) => (d.definition.rules.performanceFeeBps = 0)))).toEqual([]);
    expect(errorCodes(doc((d) => (d.definition.rules.swapSlippageBps = 0)))).toEqual(['INVALID_SLIPPAGE@definition.rules.swapSlippageBps']);
    expect(errorCodes(doc((d) => (d.definition.rules.rebalance.driftThresholdBps = 10001)))).toEqual(['INVALID_DRIFT_THRESHOLD@definition.rules.rebalance.driftThresholdBps']);
    expect(errorCodes(doc((d) => (d.definition.rules.maxAssets = 1)))).toEqual(['TOO_MANY_ASSETS@definition.assets']);
    expect(errorCodes(doc((d) => (d.definition.rules.maxAssets = 0)))).toEqual(['INVALID_RULE_VALUE@definition.rules.maxAssets']);
  });

  it('a stated definitionHash that is not the recomputed one → reject', () => {
    expect(errorCodes(doc((d) => (d.definitionHash = EXTERNAL_DEFINITION_HASH.toUpperCase().replace('0X', '0x'))))).toEqual([]);
    expect(errorCodes(doc((d) => (d.definitionHash = '0x' + '00'.repeat(32))))).toEqual(['DEFINITION_HASH_MISMATCH@definitionHash']);
  });

  it('network.chainId must be the chain table value; lineage must be contiguous; a fork is another strategy', () => {
    expect(errorCodes(doc((d) => (d.network = { chainId: 4663 })))).toEqual([]);
    expect(errorCodes(doc((d) => (d.network = { chainId: 1 })))).toEqual(['NETWORK_MISMATCH@network.chainId']);
    const ref = (version: number, parentVersion: number | null) => ({ strategyId: '11111111-1111-4111-8111-111111111111', version, parentVersion, createdAt: 'x' });
    expect(errorCodes(doc((d) => (d.ref = ref(1, null))))).toEqual([]);
    expect(errorCodes(doc((d) => (d.ref = ref(3, 2))))).toEqual([]);
    expect(errorCodes(doc((d) => (d.ref = ref(3, 1))))).toEqual(['INVALID_PARENT_VERSION@ref.parentVersion']);
    expect(errorCodes(doc((d) => (d.ref = ref(1, 1))))).toEqual(['INVALID_PARENT_VERSION@ref.parentVersion']);
    expect(errorCodes(doc((d) => ((d.ref = ref(1, null)), (d.forkedFrom = { strategyId: d.ref.strategyId, version: 1 }))))).toEqual(['SELF_FORK@forkedFrom.strategyId']);
  });

  it('metadata may only name assets of the definition', () => {
    expect(errorCodes(doc((d) => (d.metadata.assets[0].address = '0x' + 'cc'.repeat(20))))).toEqual(['METADATA_ASSET_UNKNOWN@metadata.assets[0]']);
  });

  it('is deterministic', () => {
    const bag = doc((d) => {
      d.definition.assets[0].weightBps = 9000;
      d.definition.rules.performanceFeeBps = 5000;
    });
    expect(validateBag(bag, { tokens })).toEqual(validateBag(bag, { tokens }));
  });
});
