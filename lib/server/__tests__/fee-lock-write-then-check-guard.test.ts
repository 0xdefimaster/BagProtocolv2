import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// B0 §5.6 — static guard for the write-then-check lock. Its safety needs the write to be COMMITTED before the other
// side's read. In production every supabase-js call is one PostgREST request, run in its own transaction and committed
// before it returns (supabase-js has no client-side transactions). These checks keep it that way: the purchase is
// inserted by its own awaited request and only then checked; neither step is folded into an RPC or a transaction.

const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('write-then-check lock — source guard', () => {
  it('createPurchaseIntentForUser: awaited insert first, then the fee-sale check, with nothing transactional around them', () => {
    const code = src('lib/server/purchase-execution.ts');
    const create = code.slice(code.indexOf('export async function createPurchaseIntentForUser'), code.indexOf('export async function getPurchaseOptionsForUser'));
    const insertAt = create.indexOf('await insertPurchaseIntent(admin');
    const checkAt = create.indexOf('await cancelPurchaseIfFeeSaleOpen(admin, intent');
    expect(insertAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(insertAt);
    expect(create).not.toMatch(/\bbegin\b|\bcommit\b|\.transaction\(|rpc\('create_purchase_intent/i);
  });

  it('the purchase intent is written by one plain insert request, not an RPC that could also read', () => {
    const repo = src('lib/server/purchase-intent-repo.ts');
    const create = repo.slice(repo.indexOf('export async function createPurchaseIntent'));
    expect(create.slice(0, 2500)).toMatch(/\.from\('purchase_intents'\)\s*\.insert\(/);
  });

  it('signFeeAttestation reads for purchases with its own request, after the sale intent already exists (loaded, not created, here)', () => {
    const code = src('lib/server/redeem-fee-attestation.ts');
    const loadAt = code.indexOf('await getRedeemIntentForUser(admin');
    const checkAt = code.indexOf('await purchaseInFlightFor(admin');
    expect(loadAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(loadAt);
    expect(code).not.toMatch(/insertRedeemIntent|createRedeemIntent|\.transaction\(/);
  });
});
