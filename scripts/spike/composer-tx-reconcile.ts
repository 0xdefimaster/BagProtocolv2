/**
 * P1 reconciliation — READ-ONLY. Did the whole swap output reach the probe, and did anything stay on the Composer
 * proxy? Reads one transaction's receipt and nets every ERC-20 Transfer per party (proxy, probe, wallet, others).
 * A party's net from the logs is exactly its balance change in that transaction (standard ERC-20s), so no archive
 * state is needed. No key, no transaction.
 *
 *   npx tsx scripts/spike/composer-tx-reconcile.ts --tx 0x… --wallet 0x… --proxy 0x… --probe 0x…
 *
 * Checks: the proxy's net is 0 for every token (nothing left behind); the probe's net is 0 (it forwarded everything);
 * the USDG that entered the proxy from the swap equals the USDG that reached the probe plus anything the proxy
 * returned to the wallet (residual explicitly refunded). Env: ROBINHOOD_RPC_URL / RPC_URL_ROBINHOOD (never printed).
 */
import '../load-env';
import { createPublicClient, erc20Abi, http, parseEventLogs, type Hex } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, ROBINHOOD_RPC_URL } from '../../lib/config/robinhood-chain';
import { redactRpcUrl } from '../../lib/domain/basket-protocol/redeem/fee-router-executability';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]?.toLowerCase() : undefined;
};
const isAddr = (v?: string) => !!v && /^0x[0-9a-f]{40}$/.test(v);

async function main() {
  const [tx, wallet, proxy, probe] = [arg('tx'), arg('wallet'), arg('proxy'), arg('probe')];
  if (!tx || !/^0x[0-9a-f]{64}$/.test(tx) || !isAddr(wallet) || !isAddr(proxy) || !isAddr(probe)) {
    console.error('Usage: --tx 0x<hash> --wallet 0x… --proxy 0x… --probe 0x…');
    process.exit(2);
  }
  const usdg = ROBINHOOD_REWARD_TOKEN.address.toLowerCase();
  const client = createPublicClient({ transport: http(ROBINHOOD_RPC_URL) });
  if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) throw new Error(`RPC ${redactRpcUrl(ROBINHOOD_RPC_URL)} is not Robinhood Chain.`);
  const receipt = await client.getTransactionReceipt({ hash: tx as Hex });
  console.log(`tx ${tx} · status ${receipt.status} · block ${receipt.blockNumber} · from ${receipt.from} · to ${receipt.to}`);

  const label = (a: string) => (a === wallet ? 'WALLET' : a === proxy ? 'PROXY' : a === probe ? 'PROBE' : a);
  const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' }).map((l) => ({
    token: l.address.toLowerCase(),
    from: l.args.from.toLowerCase(),
    to: l.args.to.toLowerCase(),
    value: l.args.value,
  }));
  const symbols = new Map<string, string>();
  for (const t of new Set(transfers.map((x) => x.token))) {
    symbols.set(t, await client.readContract({ address: t as Hex, abi: erc20Abi, functionName: 'symbol' }).catch(() => t));
  }

  console.log('\nTransfers, in log order:');
  for (const t of transfers) console.log(`  ${symbols.get(t.token)!.padEnd(6)} ${label(t.from)} → ${label(t.to)}  ${t.value}`);

  const net = new Map<string, bigint>(); // `${token}|${party}`
  const add = (token: string, party: string, v: bigint) => net.set(`${token}|${party}`, (net.get(`${token}|${party}`) ?? BigInt(0)) + v);
  for (const t of transfers) {
    add(t.token, t.from, -t.value);
    add(t.token, t.to, t.value);
  }
  const netOf = (token: string, party: string) => net.get(`${token}|${party}`) ?? BigInt(0);

  console.log('\nNet balance change in this transaction:');
  for (const token of symbols.keys()) {
    for (const party of [wallet!, proxy!, probe!]) console.log(`  ${symbols.get(token)!.padEnd(6)} ${label(party).padEnd(7)} ${netOf(token, party)}`);
  }

  const usdgIntoProxyFromOthers = transfers.filter((t) => t.token === usdg && t.to === proxy && t.from !== wallet && t.from !== probe).reduce((a, t) => a + t.value, BigInt(0));
  const usdgProxyToProbe = transfers.filter((t) => t.token === usdg && t.from === proxy && t.to === probe).reduce((a, t) => a + t.value, BigInt(0));
  const usdgProbePulled = usdgProxyToProbe; // pull and push both appear as proxy → probe transfers
  const usdgProxyToWallet = transfers.filter((t) => t.token === usdg && t.from === proxy && t.to === wallet).reduce((a, t) => a + t.value, BigInt(0));
  const checks: Record<string, boolean | string> = {
    'proxy kept nothing (net 0 for every token)': [...symbols.keys()].every((t) => netOf(t, proxy!) === BigInt(0)),
    'probe kept nothing (net 0 for every token)': [...symbols.keys()].every((t) => netOf(t, probe!) === BigInt(0)),
    'USDG into proxy from the swap': usdgIntoProxyFromOthers.toString(),
    'USDG proxy → probe': usdgProbePulled.toString(),
    'USDG proxy → wallet (residual refunded)': usdgProxyToWallet.toString(),
    'USDG proxy → anyone else (fees, venues)': transfers.filter((t) => t.token === usdg && t.from === proxy && t.to !== probe && t.to !== wallet).reduce((a, t) => a + t.value, BigInt(0)).toString(),
    'swap output = to probe + refunded to wallet': usdgIntoProxyFromOthers === usdgProbePulled + usdgProxyToWallet,
  };
  console.log(`\nChecks: ${JSON.stringify(checks, null, 2)}`);
  console.log('\nPROXY / PROBE / WALLET are the addresses passed in; other parties (swap venues, fee recipients) are printed as addresses.');
}

main().catch((e) => {
  console.error((e as Error).message.split(ROBINHOOD_RPC_URL).join(redactRpcUrl(ROBINHOOD_RPC_URL)).split('\n')[0]);
  process.exit(2);
});
