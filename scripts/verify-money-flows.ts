import './load-env';
import { createPublicClient, http, type Hex } from 'viem';
import { DEPLOYED_CONTRACTS, ROBINHOOD_REWARD_TOKEN } from '../lib/config/robinhood-chain';
import { proveCredit, proveSale, proveWithdraw, type ProofResult } from '../lib/domain/proof/money-flow-proof';
import { scriptRpcUrl } from './rpc-url';

// -----------------------------------------------------------------------------
// scripts/verify-money-flows.ts — read-only proof that BAG's money flows ran
// live on Robinhood Chain (docs/LIVE_PROOF_FEES_ROYALTIES.md). Give it the
// transaction hashes from the live test; it reads their receipts and checks:
//
//   --sale=0x…      a fee-paying sale paid a positive performance fee to the creator
//   --credit=0x…    a fork royalty was credited to the creator in CreatorRewardsVault
//   --withdraw=0x…  the creator withdrew it
//   --creator=0x…   optional: the creator every event must name
//
// Contract addresses come from REDEEM_SETTLEMENT_ADDRESS / CREATOR_REWARDS_VAULT_ADDRESS
// (or --settlement= / --vault=), USDG from lib/config/robinhood-chain.ts. No key,
// no transaction. Exit code 0 when every given check passes, 1 otherwise.
//
//   npx tsx scripts/verify-money-flows.ts --sale=0x… --credit=0x… --withdraw=0x… --creator=0x…
// -----------------------------------------------------------------------------

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function print(label: string, r: ProofResult) {
  console.log(`\n${label}: ${r.ok ? 'PASS' : 'FAIL'}`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
  for (const [k, v] of Object.entries(r.facts)) console.log(`  ${k}: ${v}`);
}

async function main() {
  const sale = arg('sale');
  const credit = arg('credit');
  const withdraw = arg('withdraw');
  const creator = arg('creator');
  const settlement = arg('settlement') ?? DEPLOYED_CONTRACTS.redeemSettlement;
  const vault = arg('vault') ?? DEPLOYED_CONTRACTS.creatorRewardsVault;
  if (!sale && !credit && !withdraw) {
    console.error('Usage: npx tsx scripts/verify-money-flows.ts [--sale=0x…] [--credit=0x…] [--withdraw=0x…] [--creator=0x…]');
    process.exit(2);
  }
  for (const [name, v] of [['sale', sale], ['credit', credit], ['withdraw', withdraw]] as const) {
    if (v && !TX_RE.test(v)) throw new Error(`--${name} is not a transaction hash.`);
  }
  if (creator && !ADDRESS_RE.test(creator)) throw new Error('--creator is not an address.');
  if (sale && !settlement) throw new Error('No RedeemSettlement address: set REDEEM_SETTLEMENT_ADDRESS or pass --settlement=0x….');
  if ((credit || withdraw) && !vault) throw new Error('No CreatorRewardsVault address: set CREATOR_REWARDS_VAULT_ADDRESS or pass --vault=0x….');

  const client = createPublicClient({ transport: http(scriptRpcUrl('robinhood')) });
  const receipt = async (hash: string) => {
    const r = await client.getTransactionReceipt({ hash: hash as Hex });
    return { status: r.status, logs: r.logs };
  };
  const usdg = ROBINHOOD_REWARD_TOKEN.address;
  const results: ProofResult[] = [];
  if (sale) results.push(proveSale(await receipt(sale), { settlement: settlement!, usdg, expectedCreator: creator }));
  if (credit) results.push(proveCredit(await receipt(credit), { vault: vault!, usdg, expectedCreator: creator }));
  if (withdraw) results.push(proveWithdraw(await receipt(withdraw), { vault: vault!, usdg, expectedCreator: creator }));
  const labels = { sale: 'Performance fee (sale)', credit: 'Fork royalty (credit)', withdraw: 'Creator withdrawal' };
  for (const r of results) print(labels[r.kind], r);
  const ok = results.every((r) => r.ok);
  console.log(`\nVERDICT ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  // First line only, URLs stripped: an RPC URL can carry a key.
  console.error((err instanceof Error ? err.message : String(err)).split('\n')[0].replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'));
  process.exit(1);
});
