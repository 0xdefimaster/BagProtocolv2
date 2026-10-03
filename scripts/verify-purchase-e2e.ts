import './load-env';
import { decodeEventLog, parseAbiItem } from 'viem';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';
import { getPurchaseIntentById } from '../lib/server/purchase-intent-repo';
import { getBagById } from '../lib/server/bag-repo';
import { getDeployment } from '../lib/server/bag-deployment-repo';
import { getBagHoldings } from '../lib/server/bag-holdings-repo';
import { getInvestorPosition } from '../lib/server/bag-investor-position-repo';
import { getShareSupply } from '../lib/server/bag-share-state-repo';
import { getBagNavSafe } from '../lib/server/bag-nav';
import { getPriceProvider } from '../lib/server/price-provider';
import { getChainPublicClient, hasRpcEndpoint } from '../lib/blockchain/rpc/clients';
import { isBagChain } from '../lib/config/chains';
import type { PurchaseIntent } from '../types/purchase-intent';

// -----------------------------------------------------------------------------
// Phase 1 end-to-end proof for ONE real purchase. READ-ONLY: it never writes
// to the database, never signs or sends anything, never calls the app's
// verify/execute routes. It re-checks, independently of the app's own
// verification, every link of the chain:
//
//   1. Bag         ACTIVE, deployed on chain (deployment row + tx)
//   2. Intent      created for this bag / wallet, which execution path
//   3. On chain    every reported tx exists, succeeded, was sent by the
//                  intent's wallet; for Composer the tx IS the one built
//                  (to + calldata); per-leg Transfer logs to the wallet
//   4. Binding     each tx hash is claimed by THIS intent (intent_tx_claims)
//   5. Verified    intent COMPLETED (or partial + reconciled), steps settled
//   6. Accounting  accounting/reconciliation applied exactly once
//   7. Holdings    bag_holdings carries every received asset
//   8. Position    the buyer holds shares; the bag's share supply is > 0
//   9. NAV / TVL   live NAV over bag_holdings is computable and > 0
//
// USAGE
//   npx tsx scripts/verify-purchase-e2e.ts --intent <purchase_intents.id>
//   npx tsx scripts/verify-purchase-e2e.ts --latest [--wallet 0x...]
//
// Needs Supabase (service role) and an RPC for the bag's chain
// (ROBINHOOD_RPC_URL or ALCHEMY_API_KEY). A PASS here is evidence from real
// chain + database state, not a simulation.
// -----------------------------------------------------------------------------

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

type Check = { stage: string; ok: boolean | null; detail: string };
const checks: Check[] = [];
const record = (stage: string, ok: boolean | null, detail: string) => {
  checks.push({ stage, ok, detail });
  console.log(`  ${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${detail}`);
};
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function resolveIntent(admin: ReturnType<typeof supabaseAdmin>): Promise<PurchaseIntent> {
  const id = arg('intent');
  if (id) {
    const intent = await getPurchaseIntentById(admin, id);
    if (!intent) throw new Error(`purchase intent ${id} not found`);
    return intent;
  }
  if (!process.argv.includes('--latest')) throw new Error('Pass --intent <id> or --latest [--wallet 0x...]');
  let query = admin.from('purchase_intents').select('id').order('created_at', { ascending: false }).limit(1);
  const wallet = arg('wallet');
  if (wallet) query = query.ilike('wallet_address', wallet);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const latest = data?.[0]?.id as string | undefined;
  if (!latest) throw new Error('no purchase intents found');
  const intent = await getPurchaseIntentById(admin, latest);
  if (!intent) throw new Error(`purchase intent ${latest} not found`);
  return intent;
}

async function main() {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  const admin = supabaseAdmin();
  const intent = await resolveIntent(admin);
  const swaps = intent.steps.filter((s) => s.action === 'SWAP');
  const path = intent.bagRouterTransaction ? 'BAG Router' : intent.composerTransaction ? 'Composer (single tx)' : 'sequential LI.FI';
  console.log(`Purchase ${intent.id} · bag ${intent.bagId} · wallet ${intent.walletAddress}`);
  console.log(`status ${intent.status} · path ${path} · created ${intent.createdAt} · ${swaps.length} swap leg(s)\n`);

  // 1. Bag
  console.log('[1] Bag');
  const bag = await getBagById(admin, intent.bagId);
  record('bag', bag?.status === 'ACTIVE', `bag status ${bag?.status ?? 'missing'} (${bag?.name ?? '-'})`);
  const chain = bag?.chain;
  const deployment = chain ? await getDeployment(admin, intent.bagId, chain) : null;
  record('bag', !!deployment?.txHash && !!deployment.contractAddress, `deployment ${deployment?.status ?? 'missing'} · contract ${deployment?.contractAddress ?? '-'} · tx ${deployment?.txHash ?? '-'}`);

  // 2. Intent
  console.log('\n[2] Intent');
  record('intent', /^0x[0-9a-fA-F]{40}$/.test(intent.walletAddress) && swaps.length > 0, `${swaps.length} swap leg(s): ${swaps.map((s) => s.targetSymbol).join(', ')}`);

  // 3. On chain
  console.log('\n[3] On chain');
  const hashes = [...new Set(swaps.map((s) => s.txHash).filter((h): h is string => !!h))];
  const receivedByToken: Record<string, bigint> = {};
  if (hashes.length === 0) {
    record('chain', false, 'no transaction hash recorded on any swap step');
  } else if (!chain || !isBagChain(chain) || !hasRpcEndpoint(chain)) {
    record('chain', null, `no RPC configured for ${chain ?? 'unknown chain'} — set ROBINHOOD_RPC_URL or ALCHEMY_API_KEY`);
  } else {
    const client = getChainPublicClient(chain);
    for (const hash of hashes) {
      try {
        const [receipt, tx] = await Promise.all([
          client.getTransactionReceipt({ hash: hash as `0x${string}` }),
          client.getTransaction({ hash: hash as `0x${string}` }),
        ]);
        record('chain', receipt.status === 'success', `${hash} mined in block ${receipt.blockNumber}, status ${receipt.status}`);
        record('chain', same(tx.from, intent.walletAddress), `sent by ${tx.from} (intent wallet ${intent.walletAddress})`);
        if (intent.composerTransaction) {
          record('chain', same(tx.to, intent.composerTransaction.to) && same(tx.input, intent.composerTransaction.data), `is the Composer tx built for this intent (to ${tx.to}, calldata ${same(tx.input, intent.composerTransaction.data) ? 'identical' : 'DIFFERENT'})`);
        }
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
            if (same(decoded.args.to, intent.walletAddress)) {
              const token = log.address.toLowerCase();
              receivedByToken[token] = (receivedByToken[token] ?? BigInt(0)) + decoded.args.value;
            }
          } catch {
            // not a Transfer log
          }
        }
      } catch (err) {
        record('chain', false, `${hash} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const s of swaps) {
      const got = receivedByToken[s.outputAsset.address.toLowerCase()];
      const recorded = s.outputAmountRaw;
      record('chain', got !== undefined && got > BigInt(0), `${s.targetSymbol}: wallet received ${got ?? 0} on chain · step records ${recorded ?? '-'}${recorded && got !== undefined ? (BigInt(recorded) === got ? ' (match)' : ' (DIFFERENT)') : ''}${s.providerEnforcedMinOutputRaw ? ` · provider-enforced min ${s.providerEnforcedMinOutputRaw}` : ''}`);
    }
  }

  // 4. Binding
  console.log('\n[4] Tx binding');
  for (const hash of hashes) {
    const { data, error } = await admin.from('intent_tx_claims').select('intent_id,intent_kind').eq('tx_hash', hash.toLowerCase());
    if (error) record('binding', false, `intent_tx_claims read failed: ${error.message}`);
    else record('binding', (data ?? []).some((r: { intent_id: string }) => r.intent_id === intent.id), `${hash} claimed by ${(data ?? []).map((r: { intent_id: string }) => r.intent_id).join(', ') || 'nobody'}`);
  }

  // 5. Verified
  console.log('\n[5] Verification');
  const partial = intent.status === 'PARTIAL_SUCCESS' || intent.status === 'RECONCILIATION_REQUIRED';
  record('verified', intent.status === 'COMPLETED' || partial, `intent status ${intent.status}${partial ? ' (partial purchase)' : ''}`);
  record('verified', swaps.every((s) => s.status === 'COMPLETED' || s.status === 'FAILED'), `steps: ${swaps.map((s) => `${s.targetSymbol}=${s.status}`).join(', ')}`);

  // 6. Accounting
  console.log('\n[6] Accounting');
  record('accounting', partial ? !!intent.reconciliationAppliedAt : !!intent.accountingAppliedAt, partial ? `reconciliation applied at ${intent.reconciliationAppliedAt ?? '— not applied'}` : `accounting applied at ${intent.accountingAppliedAt ?? '— not applied'}`);

  // 7. Holdings
  console.log('\n[7] Bag holdings');
  const holdings = await getBagHoldings(admin, intent.bagId);
  for (const s of swaps.filter((st) => st.status === 'COMPLETED')) {
    const h = holdings.find((x) => same(x.asset.address, s.outputAsset.address));
    const got = receivedByToken[s.outputAsset.address.toLowerCase()];
    record('holdings', !!h && (got === undefined || BigInt(h.quantityRaw) >= got), `${s.targetSymbol}: bag_holdings ${h?.quantityRaw ?? 'missing'}${got !== undefined ? ` (>= received ${got})` : ''}`);
  }

  // 8. Position
  console.log('\n[8] Investor position');
  const [position, supply] = await Promise.all([getInvestorPosition(admin, intent.userId, intent.bagId), getShareSupply(admin, intent.bagId)]);
  record('position', BigInt(position.sharesRaw) > BigInt(0), `buyer shares ${position.sharesRaw} (decimals ${position.shareDecimals}) · cost basis ${position.costBasisQuote}`);
  record('position', BigInt(supply.totalSharesRaw) > BigInt(0), `bag share supply ${supply.totalSharesRaw}`);

  // 9. NAV / TVL
  console.log('\n[9] NAV / TVL');
  try {
    const nav = await getBagNavSafe(admin, intent.bagId, getPriceProvider());
    record('nav', nav.ok && Number(nav.nav.grossNav) > 0, nav.ok ? `gross NAV ${nav.nav.grossNav} ${nav.nav.quoteCurrency} (as of ${nav.nav.asOf})` : `NAV unavailable: ${nav.reason} — ${nav.message}`);
  } catch (err) {
    record('nav', false, `NAV failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const failed = checks.filter((c) => c.ok === false);
  const skipped = checks.filter((c) => c.ok === null);
  console.log('\n=== RESULT ===');
  console.log(`${checks.length - failed.length - skipped.length} passed · ${failed.length} failed · ${skipped.length} skipped`);
  if (failed.length === 0 && skipped.length === 0) console.log('Phase 1 end-to-end: PASS for this purchase (real chain + database state).');
  else if (failed.length === 0) console.log('No failures, but some checks were skipped — not a full proof yet.');
  else console.log(`Phase 1 end-to-end: FAIL at stage(s): ${[...new Set(failed.map((f) => f.stage))].join(', ')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
