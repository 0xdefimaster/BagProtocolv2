import './load-env';
import { scriptRpcUrl } from './rpc-url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import registryArtifact from '../artifacts/contracts/StrategyRegistry.sol/StrategyRegistry.json' with { type: 'json' };
import { getViemChainFor } from '../lib/blockchain/evm/config';

// -----------------------------------------------------------------------------
// scripts/deploy-strategy-registry.ts — deploys contracts/StrategyRegistry.sol.
//
// The registry has no constructor arguments, no owner, no admin and no fee:
// after this one transaction the deployer has no special power over it. Every
// strategy is registered by its own creator's wallet (user-signed); BAG's
// server never signs a registration or a version.
//
// `DEPLOYER_PRIVATE_KEY` is a ONE-TIME key used only to broadcast this
// contract-creation transaction. Never commit it; never put it in Netlify.
//
// CANNOT BE RUN FROM THE DEVELOPMENT SANDBOX (no RPC-provider egress).
// Behavior is covered by contracts/test/StrategyRegistry.test.ts (in-process
// EVM); no broadcast to a real chain has been performed here.
//
// USAGE
//   npx hardhat compile
//   export DEPLOYER_PRIVATE_KEY=0x...   # one-time; never commit
//   npx tsx scripts/deploy-strategy-registry.ts robinhood
//
// OUTPUT
//   The deployed address and the env line to paste (STRATEGY_REGISTRY_ADDRESS_<CHAIN>=...). Nothing is written to disk.
// -----------------------------------------------------------------------------

const SUPPORTED = ['ethereum', 'base', 'arbitrum', 'robinhood'] as const;
type SupportedChain = (typeof SUPPORTED)[number];

function parseChainArg(): SupportedChain {
  const arg = process.argv[2];
  if (!arg || !(SUPPORTED as readonly string[]).includes(arg)) {
    throw new Error(`Usage: npx tsx scripts/deploy-strategy-registry.ts <${SUPPORTED.join('|')}>`);
  }
  return arg as SupportedChain;
}

/** Validates the key WITHOUT ever printing it. */
function deployerKey(): `0x${string}` {
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error('Missing required env var: DEPLOYER_PRIVATE_KEY');
  let key = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key (value not shown).');
  return key as `0x${string}`;
}

async function main() {
  const chain = parseChainArg();
  const rpcUrl = scriptRpcUrl(chain);
  const viemChain = getViemChainFor(chain);
  const account = privateKeyToAccount(deployerKey());
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== viemChain.id) {
    throw new Error(`The RPC for ${chain} reports chain id ${liveChainId}, expected ${viemChain.id}. Refusing to deploy.`);
  }

  console.log(`Deploying StrategyRegistry to ${chain} (chain id ${viemChain.id}) from ${account.address}`);
  const hash = await walletClient.deployContract({ abi: registryArtifact.abi, bytecode: registryArtifact.bytecode as `0x${string}`, args: [] });
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment transaction failed or returned no contract address.');

  console.log('\n--- Deployed ---');
  console.log(`StrategyRegistry (${chain}): ${receipt.contractAddress}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log('\nPaste into .env:');
  console.log(`STRATEGY_REGISTRY_ADDRESS_${chain.toUpperCase()}=${receipt.contractAddress}`);
}

main().catch((err) => {
  console.error('\nDeployment FAILED:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
