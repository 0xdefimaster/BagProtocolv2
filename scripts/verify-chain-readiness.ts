import './load-env';
import { createPublicClient, http } from 'viem';
import { scriptRpcUrl } from './rpc-url';
import { isBagChain } from '../lib/config/chains';
import { checkChainReadiness, summarizeGates, type ReadinessClient } from '../lib/blockchain/chain-readiness';
import { loadRuntimeArtifact } from '../lib/blockchain/chain-readiness-artifacts';

// -----------------------------------------------------------------------------
// scripts/verify-chain-readiness.ts — READ-ONLY chain qualification report
// (docs/chains/BASE_READINESS.md). No key, no signature, no transaction.
//
//   npx hardhat compile                       # for the bytecode comparison
//   npx tsx scripts/verify-chain-readiness.ts base
//
// Reads (all optional except the RPC; unset → NOT_CONFIGURED, never defaulted):
//   <CHAIN>_RPC_URL (or ALCHEMY_API_KEY)                     — scripts/rpc-url.ts
//   STRATEGY_REGISTRY_ADDRESS_<CHAIN>                               — B_CORE (SDK provenance)
//   FACTORY_ADDRESS_<CHAIN>, STRATEGY_COMPOSITIONS_ADDRESS_<CHAIN>   — B_APP (only if the BAG app runs there)
//   COMPOSER_FACTORY_<CHAIN>, COMPOSER_FACTORY_CODE_HASH_<CHAIN>   — a pin YOU reviewed for this chain
//   COMPOSER_TEST_SIGNER                                    — any address; only read
//
// Exit 0: no check FAILED (NOT_CONFIGURED / UNSUPPORTED are not failures, and
// are not qualification either). Exit 1: at least one FAIL.
// -----------------------------------------------------------------------------

async function main() {
  const chain = process.argv[2];
  if (!chain || !isBagChain(chain)) throw new Error('Usage: npx tsx scripts/verify-chain-readiness.ts <ethereum|base|arbitrum|robinhood>');
  const client = createPublicClient({ transport: http(scriptRpcUrl(chain), { retryCount: 1, timeout: 20_000 }) }) as unknown as ReadinessClient;
  const checks = await checkChainReadiness({
    chain,
    client,
    env: process.env,
    artifacts: { StrategyRegistry: loadRuntimeArtifact('StrategyRegistry'), BagFactory: loadRuntimeArtifact('BagFactory'), StrategyCompositions: loadRuntimeArtifact('StrategyCompositions') },
  });
  for (const c of checks) console.log(`${c.gate.padEnd(6)} ${c.status.padEnd(14)} ${c.name.padEnd(32)} ${c.detail}`);
  const summary = summarizeGates(checks);
  console.log(JSON.stringify({ chain, ...summary, liveReceiptProof: 'OWNER_STEP', independentConsumer: 'OWNER_STEP' }));
  console.log('sdkPath needs A, B_CORE (StrategyRegistry), C; appPath also B_APP (BagFactory, StrategyCompositions). D and E are owner steps: neither path is "qualified" from this report.');
  if (checks.some((c) => c.status === 'FAIL')) process.exitCode = 1;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
