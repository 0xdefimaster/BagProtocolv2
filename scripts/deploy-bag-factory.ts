import './load-env';
import { scriptRpcUrl } from './rpc-url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import factoryArtifact from '../artifacts/contracts/BagFactory.sol/BagFactory.json' with { type: 'json' };
import { getViemChainFor } from '../lib/blockchain/evm/config';

// -----------------------------------------------------------------------------
// scripts/deploy-bag-factory.ts — deploys contracts/BagFactory.sol to ONE of
// the four EVM chains lib/blockchain/evm/config.ts knows how to talk to
// (ethereum | base | arbitrum | robinhood).
//
// USER-SIGNED MODEL: `createBag()` is permissionless and binds each Bag to
// whichever wallet signs it. The factory's OWNER can only change the protocol
// creation fee (never above the immutable cap set here) and the treasury
// address — it cannot create or touch any Bag. `DEPLOYER_PRIVATE_KEY` is a
// ONE-TIME key used only to broadcast this contract-creation transaction.
//
// CREATION FEE: paid in native ETH as the createBag transaction's value (one
// signature, no approval) and forwarded straight to the treasury. The fee is
// a fixed wei amount; keep it near your USD target with setCreationFee as the
// ETH price moves.
//
// Routes through `getEvmChainConfig()`-adjacent helpers (`getViemChainFor`)
// so this script and the deployment verification path can never drift apart
// on what "robinhood is configured" means.
//
// Same shape as scripts/deploy-creator-rewards.ts: plain viem, one-shot
// script that only prints — it never writes env files or any other state.
//
// IMPORTANT: a new factory means a NEW registry. Bags created through an
// older (deployer-restricted) factory are not registered here, and
// `BagExecutionRouter.bagFactory` is immutable, so the router must be
// redeployed against the new factory address (scripts/deploy-bag-execution-
// router.ts) before Bag Router execution works for Bags created through it.
//
// CANNOT BE RUN FROM THE DEVELOPMENT SANDBOX (no RPC-provider egress). Compile
// and behavior are covered by contracts/test/BagFactory.test.ts (in-process
// EVM); an actual broadcast to a real chain has NOT been performed here.
//
// USAGE
//   export DEPLOYER_PRIVATE_KEY=0x...      # one-time; never commit
//   export PROTOCOL_TREASURY_ADDRESS=0x... # receives creation fees (required; must accept ETH)
//   export FACTORY_OWNER=0x...             # fee/treasury admin; a multisig in production (default: deployer)
//   export BAG_CREATION_FEE_ETH=0.00015    # creation fee in ETH (required)
//   export BAG_CREATION_FEE_CAP_ETH=0.01   # immutable upper bound in ETH (default 0.01)
//   npx tsx scripts/deploy-bag-factory.ts robinhood
//   # RPC: <CHAIN>_RPC_URL, else ALCHEMY_API_KEY, else the chain's public RPC
//
// OUTPUT
//   Deployed BagFactory address plus the exact env line to paste into .env
//   (FACTORY_ADDRESS_<CHAIN>=...). Nothing is written to disk.
// -----------------------------------------------------------------------------

const SUPPORTED = ['ethereum', 'base', 'arbitrum', 'robinhood'] as const;
type SupportedChain = (typeof SUPPORTED)[number];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseChainArg(): SupportedChain {
  const arg = process.argv[2];
  if (!arg || !(SUPPORTED as readonly string[]).includes(arg)) {
    throw new Error(`Usage: npx tsx scripts/deploy-bag-factory.ts <${SUPPORTED.join('|')}>`);
  }
  return arg as SupportedChain;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** "0.00015" ETH -> wei, exact (no float). */
function toWei(name: string, value: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error(`${name} must be a non-negative ETH amount with at most 18 decimals, got "${value}"`);
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt(frac.padEnd(18, '0'));
}

/**
 * Accepts the usual copy-paste variants (surrounding quotes or whitespace, a
 * MetaMask export without the 0x prefix) and otherwise explains what is wrong
 * WITHOUT ever printing the key itself.
 */
function normalizePrivateKey(raw: string): `0x${string}` {
  let key = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) return key as `0x${string}`;
  const body = key.startsWith('0x') ? key.slice(2) : key;
  const problems = [
    `length ${key.length} (expected 66 = "0x" + 64 hex characters)`,
    key.startsWith('0x') ? null : 'no 0x prefix',
    /[^0-9a-fA-F]/.test(body) ? 'contains non-hex characters' : null,
    /your|\.\.\./i.test(key) ? 'looks like the .env.example placeholder' : null,
  ].filter(Boolean);
  throw new Error(
    `DEPLOYER_PRIVATE_KEY is not a valid private key: ${problems.join('; ')}. ` +
      'Check for a leftover placeholder line or a second DEPLOYER_PRIVATE_KEY line in .env.local / .env, ' +
      'and for a value set in this terminal with $env: (it overrides the file).'
  );
}

function requireAddress(name: string, value: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) throw new Error(`${name} must be a 0x-prefixed 20-byte address, got "${value}"`);
  return value as `0x${string}`;
}

async function main() {
  const chain = parseChainArg();
  const key = chain.toUpperCase();
  const deployerKey = normalizePrivateKey(requireEnv('DEPLOYER_PRIVATE_KEY'));

  if (process.env.BAG_CREATION_FEE && !process.env.BAG_CREATION_FEE_ETH) {
    throw new Error(
      'BAG_CREATION_FEE (the old USDG setting) is set but BAG_CREATION_FEE_ETH is not. The fee is now paid in ETH — ' +
        'set BAG_CREATION_FEE_ETH (e.g. 0.00015) and remove BAG_CREATION_FEE.'
    );
  }
  const treasury = requireAddress('PROTOCOL_TREASURY_ADDRESS', requireEnv('PROTOCOL_TREASURY_ADDRESS'));
  const feeEth = requireEnv('BAG_CREATION_FEE_ETH');
  const capEth = process.env.BAG_CREATION_FEE_CAP_ETH ?? '0.01';
  const fee = toWei('BAG_CREATION_FEE_ETH', feeEth);
  const feeCap = toWei('BAG_CREATION_FEE_CAP_ETH', capEth);
  if (fee > feeCap) throw new Error(`BAG_CREATION_FEE_ETH (${feeEth}) exceeds BAG_CREATION_FEE_CAP_ETH (${capEth}).`);

  const rpcUrl = scriptRpcUrl(chain);

  const viemChain = getViemChainFor(chain);
  const account = privateKeyToAccount(deployerKey);

  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== viemChain.id) {
    throw new Error(
      `The RPC for ${chain} reports chain id ${liveChainId}, expected ${viemChain.id} for "${chain}". ` +
        'Refusing to deploy — this looks like the wrong RPC endpoint for this chain.'
    );
  }

  const owner = process.env.FACTORY_OWNER ? requireAddress('FACTORY_OWNER', process.env.FACTORY_OWNER) : account.address;

  console.log(`Deploying BagFactory to ${chain} (chain id ${viemChain.id}) from ${account.address}`);
  console.log(`  owner:        ${owner}${process.env.FACTORY_OWNER ? '' : '  (deployer — set FACTORY_OWNER to a multisig for production)'}`);
  console.log(`  creation fee: ${feeEth} ETH (${fee} wei; cap ${capEth} ETH)`);
  console.log(`  treasury:     ${treasury}`);

  const deployHash = await walletClient.deployContract({
    abi: factoryArtifact.abi,
    bytecode: factoryArtifact.bytecode as `0x${string}`,
    args: [owner, treasury, fee, feeCap],
  });
  console.log(`  tx: ${deployHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Deployment transaction failed or returned no contract address. Receipt: ${JSON.stringify(receipt)}`);
  }

  console.log('\n--- Deployed ---');
  console.log(`BagFactory (${chain}): ${receipt.contractAddress}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log('\nPaste into .env:');
  console.log(`FACTORY_ADDRESS_${key}=${receipt.contractAddress}`);
}

main().catch((err) => {
  console.error('\nDeployment FAILED:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

