import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson, computeDefinitionHash, definitionHashPreimage, hashBag, normalizeBag, normalizeDefinition, parseBag, type BagDocument } from '../src';
import { clone, EXTERNAL_DEFINITION_HASH, externalBag } from './helpers';

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../../docs/schemas/bag-json.v1.vectors.json', import.meta.url)), 'utf8')) as {
  vectors: { name: string; input: any; canonical: any; preimage: string; definitionHash: string }[];
};

const parsed = (doc: unknown): BagDocument => {
  const r = parseBag(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};

describe('golden vectors (docs/schemas/bag-json.v1.vectors.json)', () => {
  it('normalize, preimage and hash match every published vector', () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(3);
    for (const v of vectors.vectors) {
      expect(normalizeDefinition(v.input)).toEqual(v.canonical);
      expect(definitionHashPreimage(v.input)).toBe(v.preimage);
      expect(computeDefinitionHash(v.input)).toBe(v.definitionHash);
    }
  });
});

describe('content identity', () => {
  const base = () => parsed(externalBag());

  it('same definition → same hash (and the fixture hashes to the published vector)', () => {
    expect(hashBag(base())).toBe(EXTERNAL_DEFINITION_HASH);
    expect(hashBag(base())).toBe(hashBag(base()));
    expect(hashBag(base().definition)).toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('same definition, metadata changed → same hash', () => {
    const doc = externalBag();
    doc.metadata.name = 'Renamed';
    doc.metadata.symbol = 'NEW';
    doc.metadata.description = 'Different text';
    doc.metadata.assets[0].symbol = 'RENAMED';
    expect(hashBag(parsed(doc))).toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('identity, lineage and BAG commitments are outside the hash', () => {
    const doc = externalBag();
    doc.ref = { strategyId: '11111111-1111-4111-8111-111111111111', version: 3, parentVersion: 2, createdAt: '2026-10-01T00:00:00Z' };
    doc.network = { chainId: 4663 };
    doc.forkedFrom = { strategyId: '22222222-2222-4222-8222-222222222222', version: 1 };
    doc.commitments = { registry: { status: 'REGISTERED', creator: '0x' + 'cc'.repeat(20) } };
    expect(hashBag(parsed(doc))).toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('asset address checksum/case changed → same normalized identity and hash', () => {
    const doc = externalBag();
    doc.definition.assets[0].address = doc.definition.assets[0].address.toUpperCase().replace('0X', '0x');
    doc.definition.assets[1].address = doc.definition.assets[1].address.toLowerCase();
    const n = normalizeBag(parsed(doc));
    expect(n.definition.assets.map((a) => a.address)).toEqual(['0xa0000000000000000000000000000000000000aa', '0xb0000000000000000000000000000000000000bb']);
    expect(hashBag(n)).toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('asset order changed → same canonical hash', () => {
    const doc = externalBag();
    doc.definition.assets.reverse();
    expect(hashBag(parsed(doc))).toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('key order changed → same hash', () => {
    const doc = externalBag();
    const d = doc.definition;
    doc.definition = { rules: { ...d.rules }, assets: d.assets.map((a: any) => ({ weightBps: a.weightBps, decimals: a.decimals, address: a.address, chain: a.chain })), mutability: d.mutability, chain: d.chain, kind: d.kind };
    expect(hashBag(parsed(doc))).toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('asset chain changed → different hash (and validation rejects the foreign-chain asset, see validate tests)', () => {
    const doc = externalBag();
    doc.definition.assets[0].chain = 'base';
    expect(hashBag(parsed(doc))).not.toBe(EXTERNAL_DEFINITION_HASH);
  });

  it('performanceFeeBps 0 vs null vs 1000 → three different hashes', () => {
    const withFee = (fee: number | null) => {
      const doc = externalBag();
      doc.definition.rules.performanceFeeBps = fee;
      return hashBag(parsed(doc));
    };
    const zero = withFee(0);
    expect(zero).toBe(vectors.vectors.find((v) => v.name === 'explicit-zero-fee')!.definitionHash);
    expect(new Set([zero, withFee(null), withFee(1000)]).size).toBe(3);
  });

  it('any committed value changes the hash', () => {
    const mutations: ((d: any) => void)[] = [
      (d) => (d.assets[0].weightBps = 5000),
      (d) => (d.assets[0].decimals = 6),
      (d) => (d.mutability = 'IMMUTABLE'),
      (d) => (d.kind = null),
      (d) => (d.rules.weightBounds.minBps = 400),
      (d) => (d.rules.weightBounds.maxBps = null),
      (d) => (d.rules.maxAssets = 9),
      (d) => (d.rules.minInvestment.amount = '10.5'),
      (d) => (d.rules.minInvestment = null),
      (d) => (d.rules.swapSlippageBps = 101),
      (d) => (d.rules.rebalance.frequency = 'MONTHLY'),
      (d) => (d.rules.rebalance = null),
      (d) => (d.rules.noRouteAssetPolicy = 'BLOCK'),
    ];
    const hashes = mutations.map((m) => {
      const doc = externalBag();
      m(doc.definition);
      return hashBag(parsed(doc));
    });
    for (const h of hashes) expect(h).not.toBe(EXTERNAL_DEFINITION_HASH);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('normalizeBag is idempotent and the hash ignores a stated definitionHash', () => {
    const once = normalizeBag(parsed(externalBag()));
    expect(normalizeBag(clone(once))).toEqual(once);
    expect(hashBag({ ...once, definitionHash: '0x' + '00'.repeat(32) })).toBe(EXTERNAL_DEFINITION_HASH);
  });
});

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units and canonicalizes numbers by value', () => {
    expect(canonicalJson({ é: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"é":1}');
    expect(canonicalJson({ n: 1.0 })).toBe(canonicalJson({ n: 1 }));
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});
