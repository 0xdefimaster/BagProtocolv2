import './load-env';
import { scriptRpcUrl } from './rpc-url';
import { createWalletClient, createPublicClient, http, isAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import artifact from '../artifacts/contracts/StrategyCompositions.sol/StrategyCompositions.json' with { type: 'json' };
import { getViemChainFor } from '../lib/blockchain/evm/config';
import { isStrategyRegistry, verifyCompositionsDeployment } from '../lib/blockchain/strategy-compositions-deploy';

// -----------------------------------------------------------------------------
// scripts/deploy-strategy-compositions.ts — deploys contracts/StrategyCompositions.sol
// (docs/STRATEGY_COMPOSITIONS_DESIGN.md) next to an existing StrategyRegistry.
//
// One constructor argument, the StrategyRegistry address, read from
// STRATEGY_REGISTRY_ADDRESS_<CHAIN> and checked to be a StrategyRegistry before
// anything is sent. No owner, no admin, no fee: after this transaction the
// deployer has no power over it. Creators publish from their own wallets.
//
// `DEPLOYER_PRIVATE_KEY` is a ONE-TIME key used only to broadcast this
// transaction; never printed, never written. Remove it afterwards.
//
// USAGE
//   npx hardhat compile
//   npx tsx scripts/deploy-strategy-compositions.ts robinhood            # deploy + verify
//   npx tsx scripts/deploy-strategy-compositions.ts robinhood --verify 0x… # verify an existing deployment (no key)
//
// OUTPUT
//   The address, every read-back check, and the env line to set (STRATEGY_COMPOSITIONS_ADDRESS_<CHAIN>=...).
//   Prints addresses and transaction hashes only; never a key or the RPC URL.
// -----------------------------------------------------------------------------

const SUPPORTED = ['ethereum', 'base', 'arbitrum', 'robinhood'] as const;
type SupportedChain = (typeof SUPPORTED)[number];

function refuse(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

function deployerKey(): `0x${string}` {
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) refuse('Missing required env var: DEPLOYER_PRIVATE_KEY');
  let key = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) refuse('DEPLOYER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key (value not shown).');
  return key as `0x${string}`;
}

async function main() {
  const chain = process.argv[2] as SupportedChain;
  if (!(SUPPORTED as readonly string[]).includes(chain)) refuse(`Usage: npx tsx scripts/deploy-strategy-compositions.ts <${SUPPORTED.join('|')}> [--verify 0x…]`);
  const registry = process.env[`STRATEGY_REGISTRY_ADDRESS_${chain.toUpperCase()}`];
  if (!registry || !isAddress(registry)) refuse(`set STRATEGY_REGISTRY_ADDRESS_${chain.toUpperCase()} to the deployed StrategyRegistry.`);
  const viemChain = getViemChainFor(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(scriptRpcUrl(chain)) });
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== viemChain.id) refuse(`the RPC for ${chain} reports chain id ${liveChainId}, expected ${viemChain.id}.`);
  if (!(await isStrategyRegistry(publicClient, registry as Hex))) refuse(`${registry} is not a StrategyRegistry on ${chain}.`);

  const verifyIdx = process.argv.indexOf('--verify');
  let address: Hex;
  if (verifyIdx > 0) {
    const a = process.argv[verifyIdx + 1];
    if (!a || !isAddress(a)) refuse('--verify needs an address.');
    address = a as Hex;
  } else {
    const account = privateKeyToAccount(deployerKey());
    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(scriptRpcUrl(chain)) });
    console.log(`deployer ${account.address} · registry ${registry} · chain ${chain} (${viemChain.id})`);
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex, args: [registry as Hex] });
    console.log(`deploy tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) refuse('deployment transaction failed or returned no contract address.');
    address = receipt.contractAddress;
    console.log(`StrategyCompositions: ${address} (block ${receipt.blockNumber})`);
  }

  const checks = await verifyCompositionsDeployment(publicClient, address, { chainId: viemChain.id, registry: registry as Hex });
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.actual}${c.ok ? '' : ` (expected ${c.expected})`}`);
  if (!checks.every((c) => c.ok)) {
    console.log('NOT VERIFIED — do not configure this address.');
    process.exit(1);
  }
  console.log('VERIFIED');
  console.log(`Set (server, not secret): STRATEGY_COMPOSITIONS_ADDRESS_${chain.toUpperCase()}=${address}`);
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
