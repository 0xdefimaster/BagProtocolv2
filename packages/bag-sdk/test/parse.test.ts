import { describe, expect, it } from 'vitest';
import { parseBag } from '../src';
import { externalBag, externalBagText } from './helpers';

const codes = (input: unknown) => {
  const r = parseBag(input);
  return r.ok ? [] : r.issues.map((i) => `${i.code}@${i.path}`);
};
const withDoc = (mutate: (doc: any) => void) => {
  const doc = externalBag();
  mutate(doc);
  return doc;
};

describe('parseBag: strict (D5)', () => {
  it('accepts the external file as text and as a parsed value', () => {
    expect(parseBag(externalBagText()).ok).toBe(true);
    expect(parseBag(externalBag()).ok).toBe(true);
  });

  it('unknown field → reject (document, definition, asset, rules, metadata)', () => {
    expect(codes(withDoc((d) => (d.extra = 1)))).toEqual(['UNKNOWN_FIELD@extra']);
    expect(codes(withDoc((d) => (d.definition.creator = '0x' + '11'.repeat(20))))).toEqual(['UNKNOWN_FIELD@definition.creator']);
    expect(codes(withDoc((d) => (d.definition.assets[0].symbol = 'TSLA')))).toEqual(['UNKNOWN_FIELD@definition.assets[0].symbol']);
    expect(codes(withDoc((d) => (d.definition.rules.leverage = 2)))).toEqual(['UNKNOWN_FIELD@definition.rules.leverage']);
    expect(codes(withDoc((d) => (d.metadata.logo = 'x')))).toEqual(['UNKNOWN_FIELD@metadata.logo']);
  });

  it('missing required field → reject (never read as null)', () => {
    expect(codes(withDoc((d) => delete d.definition.mutability))).toEqual(['MISSING_FIELD@definition.mutability']);
    expect(codes(withDoc((d) => delete d.definition.rules.performanceFeeBps))).toEqual(['MISSING_FIELD@definition.rules.performanceFeeBps']);
    expect(codes(withDoc((d) => delete d.definition.assets[1].decimals))).toEqual(['MISSING_FIELD@definition.assets[1].decimals']);
    expect(codes(withDoc((d) => delete d.definition))).toEqual(['MISSING_FIELD@definition']);
    expect(codes(withDoc((d) => delete d.bagJson))).toEqual(['MISSING_FIELD@bagJson']);
  });

  it('1.0 or 1e0 where an integer is required → reject (only visible in the text)', () => {
    const text = externalBagText();
    expect(codes(text.replace('"weightBps": 6000', '"weightBps": 6000.0'))).toEqual(['NOT_AN_INTEGER@definition.assets[0].weightBps']);
    expect(codes(text.replace('"maxAssets": 10', '"maxAssets": 1e1'))).toEqual(['NOT_AN_INTEGER@definition.rules.maxAssets']);
    expect(codes(text.replace('"decimals": 18, "weightBps": 4000', '"decimals": 18.0, "weightBps": 4000'))).toEqual(['NOT_AN_INTEGER@definition.assets[1].decimals']);
    // A real fraction is rejected from a parsed value too.
    expect(codes(withDoc((d) => (d.definition.rules.performanceFeeBps = 10.5)))).toEqual(['NOT_AN_INTEGER@definition.rules.performanceFeeBps']);
  });

  it('wrong type → reject', () => {
    expect(codes(withDoc((d) => (d.definition.assets[0].weightBps = '6000')))).toEqual(['WRONG_TYPE@definition.assets[0].weightBps']);
    expect(codes(withDoc((d) => (d.definition.rules.minInvestment.amount = 10)))).toEqual(['WRONG_TYPE@definition.rules.minInvestment.amount']);
    expect(codes(withDoc((d) => (d.definition.assets = {})))).toEqual(['WRONG_TYPE@definition.assets']);
    expect(codes(withDoc((d) => (d.definition.mutability = true)))).toEqual(['WRONG_TYPE@definition.mutability']);
    expect(codes('[]')).toEqual(['WRONG_TYPE@']);
  });

  it('enum values and the closed v1 chain list are enforced', () => {
    expect(codes(withDoc((d) => (d.definition.kind = 'LEVERAGED')))).toEqual(['INVALID_VALUE@definition.kind']);
    expect(codes(withDoc((d) => (d.definition.chain = 'solana')))).toEqual(['UNSUPPORTED_CHAIN@definition.chain']);
    expect(codes(withDoc((d) => (d.definition.assets[0].chain = 'polygon')))).toEqual(['UNSUPPORTED_CHAIN@definition.assets[0].chain']);
    expect(codes(withDoc((d) => (d.definition.assets[0].address = '0x1234')))).toEqual(['INVALID_ADDRESS@definition.assets[0].address']);
    expect(codes(withDoc((d) => (d.definition.assets[0].address = ' 0xb0000000000000000000000000000000000000bb')))).toEqual(['INVALID_ADDRESS@definition.assets[0].address']);
  });

  it('a duplicate JSON key is refused instead of silently keeping the last one', () => {
    const text = externalBagText().replace('"performanceFeeBps": 1000,', '"performanceFeeBps": 1000, "performanceFeeBps": 0,');
    expect(JSON.parse(text).definition.rules.performanceFeeBps).toBe(0); // what JSON.parse would have done
    expect(codes(text)).toEqual(['DUPLICATE_KEY@']);
  });

  it('minInvestment.amount must be a canonical decimal string ("10" and "10.0" would hash differently)', () => {
    for (const bad of ['10.0', '010', '1e1', '-1', '.5', '5.', ' 10']) {
      expect(codes(withDoc((d) => (d.definition.rules.minInvestment.amount = bad)))).toEqual(['NON_CANONICAL_DECIMAL@definition.rules.minInvestment.amount']);
    }
    for (const good of ['0', '10', '0.5', '123.0001']) expect(parseBag(withDoc((d) => (d.definition.rules.minInvestment.amount = good))).ok).toBe(true);
  });

  it('only bag.json v1', () => {
    expect(codes(withDoc((d) => (d.bagJson = 2)))).toEqual(['UNSUPPORTED_FORMAT_VERSION@bagJson']);
  });

  it('syntax errors are reported, not thrown', () => {
    expect(codes('{"bagJson": 1,')[0]).toMatch(/^JSON_SYNTAX@/);
    expect(codes('{"bagJson": 1} trailing')[0]).toMatch(/^JSON_SYNTAX@/);
  });

  it('reports every problem at once', () => {
    const r = codes(withDoc((d) => {
      d.extra = 1;
      delete d.definition.kind;
      d.definition.assets[0].weightBps = 1.5;
    }));
    expect(r).toEqual(expect.arrayContaining(['UNKNOWN_FIELD@extra', 'MISSING_FIELD@definition.kind', 'NOT_AN_INTEGER@definition.assets[0].weightBps']));
  });

  it('BAG-served fields are optional, and typed when present', () => {
    expect(parseBag({ bagJson: 1, definition: externalBag().definition }).ok).toBe(true);
    expect(codes(withDoc((d) => (d.ref = { strategyId: 'not-a-uuid', version: 0, parentVersion: null, createdAt: 'x' })))).toEqual([
      'INVALID_VALUE@ref.strategyId',
      'OUT_OF_RANGE@ref.version',
    ]);
    expect(codes(withDoc((d) => (d.definitionHash = '0x12')))).toEqual(['INVALID_VALUE@definitionHash']);
  });

  it('"__proto__" is just an unknown key, not a prototype write', () => {
    const text = externalBagText().replace('"bagJson": 1,', '"bagJson": 1, "__proto__": {"polluted": true},');
    expect(codes(text)).toEqual(['UNKNOWN_FIELD@__proto__']);
    expect(({} as any).polluted).toBeUndefined();
  });
});
