/**
 * READ-ONLY: reconciles every `Settled` event of the configured settlement contract with BAG's redeem intents
 * (lib/domain/basket-protocol/redeem/settlement-event-audit.ts).
 *
 *   npx tsx scripts/audit-settlement-events.ts                         # REDEEM_SETTLEMENT_ADDRESS, from its deploy block
 *   npx tsx scripts/audit-settlement-events.ts --from-block=87108715   # explicit start
 *   npx tsx scripts/audit-settlement-events.ts --address=0x… --chunk=5000 --grace-sec=3600
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
import { DEPLOYED_CONTRACTS, ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL } from '../lib/config/robinhood-chain';
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

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

async function main() {
  const address = (arg('address') ?? DEPLOYED_CONTRACTS.redeemSettlement ?? fail('No settlement address: set REDEEM_SETTLEMENT_ADDRESS or pass --address.')).toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(address)) fail('--address is not an address.');
  const fromArg = arg('from-block');
  const fromBlock = fromArg ? BigInt(fromArg) : DEPLOY_BLOCKS[address] ?? fail('Unknown deploy block for this address: pass --from-block.');
  const chunk = BigInt(arg('chunk') ?? '10000');
  const graceSec = Number(arg('grace-sec') ?? '3600');
  if (!isSupabaseConfigured()) fail('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');

  const client = createPublicClient({ transport: http(process.env.RPC_URL_ROBINHOOD || ROBINHOOD_RPC_URL) });
  let latest: bigint;
  try {
    if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) fail('RPC is not Robinhood Chain.');
    latest = await client.getBlockNumber();
  } catch (e) {
    return fail(`RPC error: ${(e as Error).message.split('\n')[0]}`);
  }

  const events: SettledEventRecord[] = [];
  const timestamps = new Map<bigint, number>();
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - BigInt(1) < latest ? start + chunk - BigInt(1) : latest;
    let logs;
    try {
      logs = await client.getLogs({ address, fromBlock: start, toBlock: end });
    } catch (e) {
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
