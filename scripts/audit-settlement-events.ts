/**
 * READ-ONLY: reconciles every `Settled` event of the configured settlement contract with BAG's redeem intents
 * (lib/domain/basket-protocol/redeem/settlement-event-audit.ts).
 *
 *   npx tsx scripts/audit-settlement-events.ts                         # REDEEM_SETTLEMENT_ADDRESS, from its deploy block
 *   npx tsx scripts/audit-settlement-events.ts --from-block=87108715   # explicit start
 *   npx tsx scripts/audit-settlement-events.ts --address=0x… --chunk=5000 --grace-sec=3600
 *   npx tsx scripts/audit-settlement-events.ts --public-rpc                          # ignore the configured RPC URL
 *
 * Each event is BOOKED, PENDING (recent, verification may still run), UNBOOKED (ran on chain, never booked from that
 * transaction), USER_MISMATCH or UNKNOWN_REDEMPTION. No key, no transaction, no database write.
 *
 * Env: REDEEM_SETTLEMENT_ADDRESS (or --address), ROBINHOOD_RPC_URL / RPC_URL_ROBINHOOD or the public RPC, and
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read only). Neither the RPC URL nor a key is printed.
 *
 * Exit code: 0 when nothing needs review, 1 when a row does, 2 on setup or RPC errors.
 */
import './load-env';
import { createPublicClient, http, parseEventLogs, type Hex } from 'viem';
import { DEPLOYED_CONTRACTS, ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC_URL, ROBINHOOD_RPC_URL } from '../lib/config/robinhood-chain';
import { SETTLED_EVENT_ABI } from '../lib/blockchain/redeem-settlement-event';
import { computeOnChainBagId } from '../lib/domain/basket-protocol/onchain';
import { auditSettlementEvents, needsReview, type SettledEventRecord } from '../lib/domain/basket-protocol/redeem/settlement-event-audit';
import { listSettlementIntentsSince } from '../lib/server/redeem-intent-repo';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

/** Recorded deploy blocks (docs/REDEEM_SETTLEMENT_DEPLOYMENT.md): the default start for a known address. */
const DEPLOY_BLOCKS: Record<string, bigint> = {
  '0x3ecd734eb53370c2795db6ca3cb2b1de0bedf8a3': BigInt(87108715),
  '0x934a3f266e68dfbff8ed4f02aa393a36048170a0': BigInt(81169553),
};

/** `Settled` is the same in version 1 and 2 (RoyaltyPaid is a separate event), so one filter serves both. */
const SETTLED_EVENT = SETTLED_EVENT_ABI.find((e) => e.name === 'Settled')!;
const MIN_CHUNK = BigInt(100);

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

async function main() {
  const address = (arg('address') ?? DEPLOYED_CONTRACTS.redeemSettlement ?? fail('No settlement address: set REDEEM_SETTLEMENT_ADDRESS (it lives in Netlify, not always in .env.local) or pass --address=0x….')).toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(address)) fail('--address is not an address.');
  const fromArg = arg('from-block');
  const fromBlock = fromArg ? BigInt(fromArg) : DEPLOY_BLOCKS[address] ?? fail('Unknown deploy block for this address: pass --from-block.');
  const chunk = BigInt(arg('chunk') ?? '10000');
  const graceSec = Number(arg('grace-sec') ?? '3600');
  if (!isSupabaseConfigured()) fail('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');

  // --public-rpc ignores ROBINHOOD_RPC_URL / RPC_URL_ROBINHOOD: a quick check of whether the configured provider is
  // the one rejecting a request.
  const usePublic = process.argv.includes('--public-rpc');
  const client = createPublicClient({ transport: http(usePublic ? ROBINHOOD_PUBLIC_RPC_URL : ROBINHOOD_RPC_URL, { timeout: 20_000, retryCount: 1 }) });
  console.log(`RPC: ${usePublic || ROBINHOOD_RPC_URL === ROBINHOOD_PUBLIC_RPC_URL ? 'public Robinhood RPC' : 'configured provider (URL not printed)'}`);
  let latest: bigint;
  try {
    if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) fail('RPC is not Robinhood Chain.');
    latest = await client.getBlockNumber();
  } catch (e) {
    return fail(`RPC error: ${(e as Error).message.split('\n')[0]}`);
  }

  console.error(`Scanning blocks ${fromBlock}–${latest} (${latest - fromBlock + BigInt(1)} blocks, up to ${chunk} per request)…`);
  const events: SettledEventRecord[] = [];
  let lastReport = Date.now();
  let requests = 0;
  const timestamps = new Map<bigint, number>();
  // Providers cap eth_getLogs (block range, result size) and some answer an over-large request with a generic
  // JSON-RPC error: on any error, retry the same window smaller, down to MIN_CHUNK.
  // A rejected size stays lowered for the rest of the scan, so a provider cap is learned once.
  let size = chunk;
  for (let start = fromBlock; start <= latest; ) {
    const end = start + size - BigInt(1) < latest ? start + size - BigInt(1) : latest;
    let logs;
    try {
      logs = await client.getLogs({ address, event: SETTLED_EVENT, fromBlock: start, toBlock: end });
    } catch (e) {
      if (size > MIN_CHUNK) {
        size = size / BigInt(4) > MIN_CHUNK ? size / BigInt(4) : MIN_CHUNK;
        console.error(`  range rejected at ${start} (${(e as Error).message.split('\n')[0]}); retrying with ${size} blocks`);
        continue;
      }
      return fail(`RPC error reading logs ${start}–${end}: ${(e as Error).message.split('\n')[0]}`);
    }
    for (const e of parseEventLogs({ abi: SETTLED_EVENT_ABI, logs, eventName: 'Settled' })) {
      const block = e.blockNumber as bigint;
      if (!timestamps.has(block)) timestamps.set(block, Number((await client.getBlock({ blockNumber: block })).timestamp));
      events.push({
        redemptionId: e.args.redemptionId,
        txHash: String(e.transactionHash),
        blockTimestampSec: timestamps.get(block)!,
        user: e.args.user,
        received: e.args.received.toString(),
        fee: e.args.fee.toString(),
      });
    }
    requests++;
    if (Date.now() - lastReport > 10_000 || end === latest) {
      console.error(`  … block ${end} of ${latest}: ${requests} request(s), ${events.length} event(s), ${size} blocks per request`);
      lastReport = Date.now();
    }
    start = end + BigInt(1);
  }

  const earliest = events.length ? Math.min(...events.map((e) => e.blockTimestampSec)) : Math.floor(Date.now() / 1000);
  // Intents are created before their settlement: start the lookup a day earlier than the first event.
  const intents = await listSettlementIntentsSince(supabaseAdmin(), new Date((earliest - 86400) * 1000).toISOString());
  const rows = auditSettlementEvents(
    events,
    intents.map((i) => ({
      redemptionId: computeOnChainBagId(i.id),
      intentId: i.id,
      walletAddress: i.walletAddress,
      bookedTxHash: i.settlementPlan?.result?.txHash ?? null,
    })),
    Math.floor(Date.now() / 1000),
    graceSec
  );

  const counts = rows.reduce<Record<string, number>>((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {});
  console.log(`Settlement ${address}: blocks ${fromBlock}–${latest}, ${rows.length} Settled event(s): ${JSON.stringify(counts)}`);
  for (const r of rows.filter(needsReview)) {
    console.log(`  ${r.status.padEnd(18)} tx ${r.txHash} intent ${r.intentId ?? '-'} received ${r.received} fee ${r.fee}`);
  }
  process.exit(rows.some(needsReview) ? 1 : 0);
}

main().catch((e) => fail(`SETUP_ERROR: ${(e as Error).message.split('\n')[0]}`));
