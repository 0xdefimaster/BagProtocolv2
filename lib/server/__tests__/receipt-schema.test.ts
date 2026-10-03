import { describe, expect, it } from 'vitest';
import schema from '@/docs/schemas/execution-history.v2.schema.json';
import { EVIDENCE_LEVELS, EXECUTION_HISTORY_SCHEMA_VERSION, EXECUTION_OUTCOMES, RECEIPT_FIELD_SOURCES, STEP_OUTCOMES } from '@/types/execution-receipt';

// The JSON Schema is the published contract; the TypeScript enums are what the code emits.
// They must never drift apart.
const defs = schema.definitions as Record<string, { properties: Record<string, { enum?: unknown[] } & Record<string, unknown>> }>;

describe('execution history JSON Schema ↔ TypeScript contract', () => {
  it('schemaVersion matches', () => {
    expect((schema.properties.schemaVersion as { const: number }).const).toBe(EXECUTION_HISTORY_SCHEMA_VERSION);
  });

  it('public enums match', () => {
    expect(defs.receipt.properties.outcome.enum).toEqual([...EXECUTION_OUTCOMES]);
    expect(defs.output.properties.outcome.enum).toEqual([...STEP_OUTCOMES]);
    expect(defs.output.properties.actualSource.enum).toEqual([...RECEIPT_FIELD_SOURCES, null]);
    const evidence = defs.receipt.properties.evidence as unknown as { properties: { level: { enum: unknown[] } } };
    expect(evidence.properties.level.enum).toEqual([...EVIDENCE_LEVELS]);
  });

  it('forward-open fields allow real values, and nothing internal is in the contract', () => {
    expect(defs.receipt.properties.blockNumber).toEqual({ type: ['integer', 'null'] });
    expect(defs.receipt.properties.blockTimestamp).toEqual({ type: ['string', 'null'] });
    const pe = defs.receipt.properties.policyEvaluation as unknown as { properties: { policySnapshotAvailable: unknown } };
    expect(pe.properties.policySnapshotAvailable).toEqual({ type: 'boolean' });
    const text = JSON.stringify(schema);
    for (const internal of ['RECONCILIATION_REQUIRED', 'PARTIAL_SUCCESS', 'AWAITING_SIGNATURE', 'DRAFT', '"status"', '"stepStatus"', 'userId']) {
      expect(text).not.toContain(internal);
    }
  });
});
