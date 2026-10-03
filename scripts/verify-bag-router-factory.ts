import './load-env';
import { createPublicClient, http } from 'viem';
import { getEvmChainConfig, getViemChainFor } from '../lib/blockchain/evm/config';
import { verifyRouterFactoryMatchesConfig, RouterFactoryMismatchError } from '../lib/blockchain/evm/verify-router-factory';

// -----------------------------------------------------------------------------
// scripts/verify-bag-router-factory.ts
//
// Item 8's preflight check: reads the DEPLOYED BagExecutionRouter's immutable
// `bagFactory` and confirms it equals the application's configured
// `FACTORY_ADDRESS_<CHAIN>`. Run this:
//   - after deploying/redeploying BagExecutionRouter, before setting
//     BAG_EXECUTION_ROUTER_ADDRESS in production;
//   - after redeploying BagFactory (a new registry — see
//     scripts/deploy-bag-factory.ts's own warning), before leaving the old
//     BAG_EXECUTION_ROUTER_ADDRESS in place;
//   - as a deploy-pipeline gate, so a testnet/production or router/factory
//     mismatch is caught here, not by every purchase reverting in production.
//
// Exits 0 (and prints the match) on success, exits 1 with a clear message on
// mismatch or misconfiguration. Read-only — sends no transaction, needs no key.
//
// USAGE
//   npx tsx scripts/verify-bag-router-factory.ts robinhood 0x<routerAddress>
//   # or omit the address to read it from BAG_EXECUTION_ROUTER_ADDRESS
// -----------------------------------------------------------------------------

const SUPPORTED = ['robinhood', 'ethereum', 'base', 'arbitrum'] as const;
type SupportedChain = (typeof SUPPORTED)[number];

function parseArgs(): { chain: SupportedChain; routerAddress: `0x${string}` } {
  const [chainArg, routerArg] = process.argv.slice(2);
  if (!chainArg || !(SUPPORTED as readonly string[]).includes(chainArg)) {
    throw new Error(`Usage: npx tsx scripts/verify-bag-router-factory.ts <${SUPPORTED.join('|')}> [routerAddress]`);
  }
  const routerAddress = (routerArg || process.env.BAG_EXECUTION_ROUTER_ADDRESS) as `0x${string}` | undefined;
  if (!routerAddress) {
    throw new Error('No router address given and BAG_EXECUTION_ROUTER_ADDRESS is not set.');
  }
  return { chain: chainArg as SupportedChain, routerAddress };
}

async function main() {
  const { chain, routerAddress } = parseArgs();
  const config = getEvmChainConfig(chain); // throws ChainNotConfiguredError if FACTORY_ADDRESS_<CHAIN>/RPC_URL_<CHAIN> is missing — fail closed, same as the app itself.
  const viemChain = getViemChainFor(chain);
  const client = createPublicClient({ chain: viemChain, transport: http(config.rpcUrl) });

  console.log(`Checking BagExecutionRouter ${routerAddress} on ${chain} (chain id ${viemChain.id})`);
  console.log(`  configured BagFactory (FACTORY_ADDRESS_${chain.toUpperCase()}): ${config.factoryAddress}`);

  await verifyRouterFactoryMatchesConfig(client, routerAddress, config.factoryAddress);

  console.log('\nOK — the router is bound to the currently configured BagFactory.');
}

main().catch((err) => {
  if (err instanceof RouterFactoryMismatchError) {
    console.error('\nMISMATCH — do not enable this router in production:');
    console.error(`  ${err.message}`);
  } else {
    console.error('\nFAILED:');
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
