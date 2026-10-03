import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDatabase, createTestDatabase } from './pg-harness';
import { VERSION_ROW_COLUMNS } from '@/lib/server/strategy-passport';

// The Strategy Passport reads on-chain version fields straight from
// bag_versions; this proves every column it selects exists in BOTH a fresh
// install and an upgraded one, so a typo can't silently null the on-chain
// lineage in production.

let fresh: TestDatabase;
let upgraded: TestDatabase;
beforeAll(async () => {
  [fresh, upgraded] = await Promise.all([createTestDatabase({ mode: 'fresh' }), createTestDatabase({ mode: 'upgrade' })]);
});
afterAll(async () => {
  await Promise.all([fresh?.drop(), upgraded?.drop()]);
});

describe('Strategy Passport column contract', () => {
  it('every bag_versions column the passport selects exists, and bags.parent_bag_id is queryable', async () => {
    for (const db of [fresh, upgraded]) {
      const cols = (await db.admin.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'bag_versions'`)).rows.map(
        (r) => r.column_name as string
      );
      for (const c of VERSION_ROW_COLUMNS.split(',')) expect(cols).toContain(c);
      await db.admin.query(`select ${VERSION_ROW_COLUMNS} from bag_versions limit 1`);
      await db.admin.query(`select id from bags where parent_bag_id is not null order by created_at desc limit 1`);
    }
  });
});
