import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBag, validateBag } from '../src';
import { externalBag, externalBagText } from './helpers';

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../docs/schemas/bag.v1.schema.json', import.meta.url)), 'utf8'),
);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function minimalBag() {
  const full = externalBag();
  return { bagJson: 1, definition: full.definition };
}

describe('published bag.json v1 JSON Schema', () => {
  it('accepts a minimal portable document with only bagJson and definition', () => {
    const bag = minimalBag();
    expect(validateSchema(bag), JSON.stringify(validateSchema.errors)).toBe(true);

    const parsed = parseBag(bag);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateBag(parsed.bag).valid).toBe(true);
  });

  it('accepts optional BAG-serving fields without making them required or authoritative', () => {
    const bag = {
      ...externalBag(),
      definitionHash: `0x${'1'.repeat(64)}`,
      ref: {
        strategyId: '11111111-1111-4111-8111-111111111111',
        version: 2,
        parentVersion: 1,
        createdAt: '2026-10-20T00:00:00Z',
      },
      network: { chainId: 4663 },
      // The document parser intentionally treats commitments as opaque, non-authoritative metadata.
      commitments: { registry: { status: 'REGISTERED', extensionField: true } },
      forkedFrom: null,
    };

    expect(validateSchema(bag), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(parseBag(bag).ok).toBe(true);
  });

  it('uses only the frozen v1 EVM chain table (Solana is not a bag.json v1 chain)', () => {
    const bag = minimalBag();
    bag.definition.chain = 'solana';
    bag.definition.assets[0].chain = 'solana';

    expect(validateSchema(bag)).toBe(false);
    expect(parseBag(bag).ok).toBe(false);
  });

  it('rejects unknown keys, missing required definition fields, malformed addresses and non-canonical decimals', () => {
    const unknown = minimalBag() as Record<string, any>;
    unknown.extra = true;
    expect(validateSchema(unknown)).toBe(false);
    expect(parseBag(unknown).ok).toBe(false);

    const missing = minimalBag();
    delete missing.definition.rules.performanceFeeBps;
    expect(validateSchema(missing)).toBe(false);
    expect(parseBag(missing).ok).toBe(false);

    const address = minimalBag();
    address.definition.assets[0].address = '0x1234';
    expect(validateSchema(address)).toBe(false);
    expect(parseBag(address).ok).toBe(false);

    const decimal = minimalBag();
    decimal.definition.rules.minInvestment.amount = '10.0';
    expect(validateSchema(decimal)).toBe(false);
    expect(parseBag(decimal).ok).toBe(false);
  });

  it('leaves cross-field rules to validateBag; a shape-valid weight sum is still rejected', () => {
    const bag = minimalBag();
    bag.definition.assets[0].weightBps = 3000; // 3000 + 4000 != 10000, but each item is individually in range.

    expect(validateSchema(bag)).toBe(true);
    const parsed = parseBag(bag);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateBag(parsed.bag).errors.map((issue) => issue.code)).toContain('WEIGHTS_NOT_100');
  });

  it('documents why callers must pass original JSON text to parseBag', () => {
    const lexicalFraction = externalBagText().replace('"weightBps": 6000', '"weightBps": 6000.0');
    expect(validateSchema(JSON.parse(lexicalFraction))).toBe(true); // JSON Schema only sees the parsed number.
    expect(parseBag(lexicalFraction).ok).toBe(false); // v1 rejects the lexical form 6000.0.
  });
});
