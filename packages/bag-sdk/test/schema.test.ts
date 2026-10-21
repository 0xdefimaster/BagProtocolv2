import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { parseBag } from '../src';
import { externalBag } from './helpers';

const schemaText = readFileSync(fileURLToPath(new URL('../schema/bag.v1.schema.json', import.meta.url)), 'utf8');
const docsSchemaText = readFileSync(fileURLToPath(new URL('../../../docs/schemas/bag.v1.schema.json', import.meta.url)), 'utf8');
const schema = JSON.parse(schemaText);
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe('published bag.json JSON Schema', () => {
  it('keeps the packaged schema identical to the repository schema', () => {
    expect(JSON.parse(schemaText)).toEqual(JSON.parse(docsSchemaText));
  });

  it('accepts the SDK minimum document and a BAG-served document', () => {
    const minimal = externalBag();
    const served = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/feetest.v1.bag.json', import.meta.url)), 'utf8'));
    expect(parseBag(minimal).ok).toBe(true);
    expect(validateSchema(minimal), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(parseBag(served).ok).toBe(true);
    expect(validateSchema(served), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it('rejects schema-shape failures that the strict SDK parser also rejects', () => {
    const base = externalBag();
    const cases = [
      { ...base, unexpected: true },
      { ...base, definition: { ...base.definition, chain: 'solana' } },
      { ...base, definition: { ...base.definition, rules: { ...base.definition.rules, minInvestment: { amount: '10.0', measuredAs: 'PAYMENT_TOKEN_AMOUNT' } } } },
    ];
    for (const doc of cases) {
      expect(parseBag(doc).ok).toBe(false);
      expect(validateSchema(doc)).toBe(false);
    }
  });
});
