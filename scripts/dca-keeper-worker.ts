/**
 * DCA v1 keeper worker (lib/dca/keeper). Long-running; one process per keeper account.
 *
 *   npx tsx scripts/dca-keeper-worker.ts migrate
 *   npx tsx scripts/dca-keeper-worker.ts add <job.json>     # { authorization, ownerSignature, deployment }
 *   npx tsx scripts/dca-keeper-worker.ts status
 *   npx tsx scripts/dca-keeper-worker.ts run
 *
 * Modes (DCA_KEEPER_MODE):
 *   PAPER (default)  reads the chain, quotes and simulates every due run; never sends a transaction, holds no key.
 *   FORK             sends, but ONLY to a local development node (Hardhat/EDR/anvil, chain id 31337 unless
 *                    DCA_FORK_CHAIN_ID says otherwise), e.g. `npx hardhat node --fork <robinhood rpc>`.
 *   LIVE is not available in this build: sending to Robinhood Chain needs a separate, explicit production decision
 *   (deployed and verified executor, audit, funded keeper account, monitoring), see docs/dca/DCA_V1_TYPED_ADAPTER.md.
 *
 * Environment (never logged): DCA_KEEPER_DATABASE_URL (Postgres; the keeper's OWN database), DCA_RPC_URL,
 * DCA_EXECUTOR, DCA_QUOTER (default Robinhood QuoterV2), DCA_V3_FACTORY (default Robinhood v3 factory),
 * DCA_KEEPER_PRIVATE_KEY (FORK only; a local test key), DCA_KEEPER_HOLDER, DCA_KEEPER_INTERVAL_MS (15000),
 * DCA_KEEPER_HEALTH_PORT (8787, bound to 127.0.0.1), DCA_KEEPER_ALERT_WEBHOOK, DCA_LOG_CHUNK (10000).
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Pool } from 'pg';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createViemKeeperChain } from '../lib/dca/keeper/chain';
import { DcaKeeper, type KeeperMode } from '../lib/dca/keeper/keeper';
import { PostgresKeeperStore } from '../lib/dca/keeper/postgres-store';
import { consoleAlertSink, KeeperWorker, webhookAlertSink, type AlertSink } from '../lib/dca/keeper/worker';
import { UNISWAP_QUOTER_V2_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS } from '../lib/config/robinhood-chain';

const env = (k: string, required = true) => {
  const v = process.env[k]?.trim();
  if (!v && required) throw new Error(`${k} is not set`);
  return v || undefined;
};
const BIG = '__bigint';
const reviveBig = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v && typeof v === 'object' && BIG in (v as object) ? BigInt((v as any)[BIG]) : v);

/** FORK mode only talks to a local development node. Refuses anything else (a real RPC reports e.g. "nitro/..."). */
async function assertLocalDevNode(rpc: (m: string) => Promise<unknown>) {
  const version = String(await rpc('web3_clientVersion'));
  const chainId = Number(await rpc('eth_chainId'));
  const allowed = Number(process.env.DCA_FORK_CHAIN_ID ?? 31337);
  if (!/hardhat|edr|anvil/i.test(version) || chainId !== allowed) {
    throw new Error(`FORK mode refuses this node (client "${version.slice(0, 40)}", chain ${chainId}); it sends only to a local dev node with chain id ${allowed}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const pool = new Pool({ connectionString: env('DCA_KEEPER_DATABASE_URL') });
  const store = new PostgresKeeperStore(pool);
  try {
    if (cmd === 'migrate') {
      await store.migrate();
      console.log('dca_keeper schema is up to date');
      return;
    }
    if (cmd === 'status') {
      for (const j of await store.list()) {
        const live = j.confirmed.filter((c) => !c.reorged);
        console.log(JSON.stringify({ id: j.id, state: j.state, detail: j.stateDetail, runs: live.length, verified: live.filter((c) => c.verification === 'VERIFIED').length, missed: j.missed.length, pending: j.pending?.hash ?? (j.pending ? `nonce ${j.pending.nonce}` : null) }));
      }
      return;
    }
    const mode = (env('DCA_KEEPER_MODE', false) ?? 'PAPER').toUpperCase();
    if (mode !== 'PAPER' && mode !== 'FORK') throw new Error(`DCA_KEEPER_MODE ${mode} is not available in this build (PAPER or FORK only)`);
    const transport = http(env('DCA_RPC_URL'));
    const publicClient = createPublicClient({ transport });
    const rpc = (method: string) => publicClient.request({ method: method as any });
    let walletClient = null;
    if (mode === 'FORK') {
      await assertLocalDevNode(rpc);
      const account = privateKeyToAccount(env('DCA_KEEPER_PRIVATE_KEY') as Hex);
      walletClient = createWalletClient({ account, transport });
    }
    const chain = createViemKeeperChain({
      publicClient: publicClient as any,
      walletClient: walletClient as any,
      quoter: (env('DCA_QUOTER', false) ?? UNISWAP_QUOTER_V2_ADDRESS) as Hex,
      v3Factory: (env('DCA_V3_FACTORY', false) ?? UNISWAP_V3_FACTORY_ADDRESS) as Hex,
      logChunk: BigInt(env('DCA_LOG_CHUNK', false) ?? '10000'),
    });
    const sinks: AlertSink[] = [consoleAlertSink];
    const hook = env('DCA_KEEPER_ALERT_WEBHOOK', false);
    if (hook) sinks.push(webhookAlertSink(hook));
    let worker: KeeperWorker | null = null;
    const keeper = new DcaKeeper({
      store, chain, mode: (mode === 'FORK' ? 'SEND' : 'PAPER') as KeeperMode,
      holder: env('DCA_KEEPER_HOLDER', false) ?? `${hostname()}:${process.pid}`,
      onAlert: (a) => worker?.alert(a),
    });
    worker = new KeeperWorker(keeper, { mode, intervalMs: Number(env('DCA_KEEPER_INTERVAL_MS', false) ?? 15_000), sinks });

    if (cmd === 'add') {
      const input = JSON.parse(readFileSync(arg, 'utf8'), reviveBig);
      const executor = env('DCA_EXECUTOR') as Hex;
      if (input.deployment?.executor?.toLowerCase() !== executor.toLowerCase()) throw new Error('job deployment.executor is not DCA_EXECUTOR');
      const job = await keeper.addJob(input);
      console.log(`added ${job.id} (state ${job.state})`);
      return;
    }
    if (cmd === 'run') {
      await store.migrate();
      worker.serve(Number(env('DCA_KEEPER_HEALTH_PORT', false) ?? 8787));
      worker.start();
      console.log(`dca keeper running: mode ${mode}${chain.keeper ? `, keeper ${chain.keeper}` : ''}`);
      const stop = async () => {
        await worker!.stop();
        await pool.end();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => {});
    }
    throw new Error('usage: dca-keeper-worker.ts migrate | add <job.json> | status | run');
  } finally {
    if (cmd !== 'run') await pool.end();
  }
}

main().catch((e) => {
  console.error(`dca keeper: ${(e as Error).message.replace(/https?:\/\/\S+/g, '<url>')}`);
  process.exit(1);
});
