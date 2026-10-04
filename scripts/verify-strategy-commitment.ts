import './load-env';
import fs from 'node:fs';
import { scriptRpcUrl } from './rpc-url';
import { createPublicClient, http, type Hex } from 'viem';
import { getViemChainFor } from '../lib/blockchain/evm/config';
import { readRegistryRecord, registryStrategyId, verifyBagJsonCommitment } from '../lib/domain/basket-protocol/strategy-registry';

// -----------------------------------------------------------------------------
// scripts/verify-strategy-commitment.ts — third-party check that a bag.json IS
// the definition its creator committed to in StrategyRegistry.
//
// Inputs are only public data: the bag.json (e.g. saved from
// GET /api/strategies/:id/versions/:version), the creator's address, the
// registry address and an RPC. Read-only: no key, no transaction. The
// bag.json's own `definitionHash` is not trusted — it is recomputed.
//
// USAGE
//   npx tsx scripts/verify-strategy-commitment.ts <chain> <registryAddress> <creatorAddress> <bag.json path>
//
// Exit code 0 when verified, 1 otherwise. Prints every check.
// -----------------------------------------------------------------------------

const SUPPORTED = ['ethereum', 'base', 'arbitrum', 'robinhood'] as const;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function main() {
  const [chain, registry, creator, file] = process.argv.slice(2);
  if (!(SUPPORTED as readonly string[]).includes(chain ?? '') || !ADDRESS_RE.test(registry ?? '') || !ADDRESS_RE.test(creator ?? '') || !file) {
    throw new Error('Usage: npx tsx scripts/verify-strategy-commitment.ts <chain> <registryAddress> <creatorAddress> <bag.json path>');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Accept a bare bag.json or a Strategy API response that wraps it as `definition`.
  const bagJson = raw.bagJson === 1 ? raw : raw.definition?.bagJson === 1 ? raw.definition : null;
  if (!bagJson) throw new Error(`${file} is not a bag.json v1 document.`);

  const client = createPublicClient({ chain: getViemChainFor(chain as (typeof SUPPORTED)[number]), transport: http(scriptRpcUrl(chain as (typeof SUPPORTED)[number])) });
  const id = registryStrategyId(creator, bagJson.ref.strategyId);
  const record = await readRegistryRecord(client as never, registry as Hex, id, bagJson.ref.version);
  const result = verifyBagJsonCommitment(bagJson, record);

  console.log(`strategy ${bagJson.ref.strategyId} v${bagJson.ref.version}`);
  console.log(`registry id ${id}`);
  if (record.fork) console.log(`fork of ${record.fork.parentStrategyId} v${record.fork.parentVersion}`);
  for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
  console.log(result.verified ? '\nVERIFIED' : '\nNOT VERIFIED');
  process.exit(result.verified ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
