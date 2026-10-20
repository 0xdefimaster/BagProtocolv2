import { describe, expect, it } from 'vitest';
import bagSchema from '@/docs/schemas/bag.v1.schema.json';
import { RebalanceFrequency, STRATEGY_TYPES, SUPPORTED_CHAINS, UNROUTABLE_POLICIES } from '@/types/basket-protocol';

// The JSON Schema is the published bag.json v1 contract; these enums must not drift from the TypeScript ones.
// (An exhaustive Record makes the compiler list every RebalanceFrequency.)
const FREQUENCIES: Record<RebalanceFrequency, true> = { MANUAL: true, DAILY: true, WEEKLY: true, MONTHLY: true, THRESHOLD_ONLY: true };
const d = bagSchema.definitions;
const rules = d.rules.properties;
const sorted = (xs: readonly (string | null)[]) => [...xs].sort((a, b) => String(a).localeCompare(String(b)));

describe('bag.json v1 schema ↔ TypeScript', () => {
  it('enums match', () => {
    expect(sorted(d.chain.enum)).toEqual(sorted(SUPPORTED_CHAINS));
    expect(sorted(d.definition.properties.kind.enum)).toEqual(sorted([...STRATEGY_TYPES, null]));
    expect(sorted(rules.noRouteAssetPolicy.enum)).toEqual(sorted([...UNROUTABLE_POLICIES, null]));
    expect(sorted(rules.rebalance.oneOf[0].properties!.frequency.enum)).toEqual(sorted([...Object.keys(FREQUENCIES), null]));
  });

  it('every definition field is required (null, never absent, means "not set")', () => {
    expect(sorted(d.definition.required)).toEqual(sorted(Object.keys(d.definition.properties)));
    expect(sorted(d.rules.required)).toEqual(sorted(Object.keys(rules)));
    expect(sorted(d.asset.required)).toEqual(sorted(Object.keys(d.asset.properties)));
  });
});
