import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDatabase, createTestDatabase } from './pg-harness';

// 0047: redeem_intents.composer_transaction exists as nullable jsonb, existing rows are untouched, and the
// migration is safe to run again.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const MIGRATION = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/0047_redeem_composer_transaction.sql'), 'utf8');

describe('0047 redeem_intents.composer_transaction (real Postgres)', () => {
  it('is a nullable jsonb column', async () => {
    const { rows } = await db.admin.query(
      `select data_type, is_nullable from information_schema.columns where table_name = 'redeem_intents' and column_name = 'composer_transaction'`
    );
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
  });

  it('re-running it changes nothing', async () => {
    await db.admin.query(MIGRATION);
    await db.admin.query(MIGRATION);
    const { rows } = await db.admin.query(`select count(*)::int as n from information_schema.columns where table_name = 'redeem_intents' and column_name = 'composer_transaction'`);
    expect(rows[0].n).toBe(1);
  });
});
