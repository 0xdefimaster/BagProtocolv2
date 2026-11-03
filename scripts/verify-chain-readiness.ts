import './load-env';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { scriptRpcUrl } from './rpc-url';
import { isBagChain } from '../lib/config/chains';
import { checkChainReadiness, summarizeGates, type ReadinessClient, type RuntimeArtifact } from '../lib/blockchain/chain-readiness';

// -----------------------------------------------------------------------------
// scripts/verify-chain-readiness.ts — READ-ONLY chain qualification report
// (docs/chains/BASE_READINESS.md). No key, no signature, no transaction.
//
//   npx hardhat compile                       # for the bytecode comparison
//   npx tsx scripts/verify-chain-readiness.ts base
//
// Reads (all optional except the RPC; unset → NOT_CONFIGURED, never defaulted):
//   <CHAIN>_RPC_URL (or ALCHEMY_API_KEY)                     — scripts/rpc-url.ts
//   STRATEGY_REGISTRY_ADDRESS_<CHAIN>, FACTORY_ADDRESS_<CHAIN>, STRATEGY_COMPOSITIONS_ADDRESS_<CHAIN>
//   COMPOSER_FACTORY_<CHAIN>, COMPOSER_FACTORY_CODE_HASH_<CHAIN>   — a pin YOU reviewed for this chain
//   COMPOSER_TEST_SIGNER                                    — any address; only read
//
// Exit 0: no check FAILED (NOT_CONFIGURED / UNSUPPORTED are not failures, and
// are not qualification either). Exit 1: at least one FAIL.
// -----------------------------------------------------------------------------

function loadArtifact(name: string): RuntimeArtifact | undefined {
  const file = join('artifacts', 'contracts', `${name}.sol`, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RuntimeArtifact) : undefined;
}

async function main() {
  const chain = process.argv[2];
  if (!chain || !isBagChain(chain)) throw new Error('Usage: npx tsx scripts/verify-chain-readiness.ts <ethereum|base|arbitrum|robinhood>');
  const client = createPublicClient({ transport: http(scriptRpcUrl(chain), { retryCount: 1, timeout: 20_000 }) }) as unknown as ReadinessClient;
  const checks = await checkChainReadiness({
    chain,
    client,
    env: process.env,
    artifacts: { StrategyRegistry: loadArtifact('StrategyRegistry'), BagFactory: loadArtifact('BagFactory'), StrategyCompositions: loadArtifact('StrategyCompositions') },
  });
  for (const c of checks) console.log(`${c.gate}  ${c.status.padEnd(14)} ${c.name.padEnd(28)} ${c.detail}`);
  const gates = summarizeGates(checks);
  console.log(JSON.stringify({ chain, gates, liveReceiptProof: 'OWNER_STEP', independentConsumer: 'OWNER_STEP' }));
  if (checks.some((c) => c.status === 'FAIL')) process.exitCode = 1;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
