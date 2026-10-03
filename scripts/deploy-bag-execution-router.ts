import './load-env';
import { scriptRpcUrl } from './rpc-url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import routerArtifact from '../artifacts/contracts/BagExecutionRouter.sol/BagExecutionRouter.json' with { type: 'json' };
import { getViemChainFor } from '../lib/blockchain/evm/config';
import { UNISWAP_ROUTER_ADDRESS, ROBINHOOD_REWARD_TOKEN } from '../lib/config/robinhood-chain';
import { getCanonicalInputTokensForChain } from '../lib/server/canonical-input-tokens';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

// -----------------------------------------------------------------------------
// scripts/deploy-bag-execution-router.ts
//
// Deploys contracts/BagExecutionRouter.sol AND, in the same run, configures
// the two allowlists it needs before it can execute a single real leg
// (`setAllowedTarget(UNISWAP_ROUTER_ADDRESS, true)` and `setAllowedToken(...)`
// for every canonical asset for this chain). Skipping the allowlist step is
// the single most common way to deploy this contract and then have every
// purchase silently refuse to route through it — the router accepts
// NOTHING by default (see the contract's own NatSpec).
//
// H1 follow-up (security audit) — the token list itself now comes from
// `getCanonicalInputTokensForChain()` (lib/server/canonical-input-tokens.ts:
// this chain's fixed settlement currency + every VERIFIED registry asset
// for this chain), never a hand-typed list a human has to keep in sync
// with the Asset Registry by memory. `CANONICAL_TOKEN_ADDRESSES` still
// exists but is now purely a SUPPLEMENT (e.g. an asset genuinely not yet
// modeled as a registry row) — set it only when you have a real reason;
// nothing here still needs it to just cover "the registry's own assets".
//
// PREREQUISITE: `BagFactory` must already be deployed on the SAME chain —
// this script needs its address as `_bagFactory` (see
// scripts/deploy-bag-factory.ts). Deploy the factory first.
//
// CANNOT BE RUN FROM THIS SANDBOX — same network restriction as
// scripts/deploy-bag-factory.ts's own doc. Not broadcast or verified from
// here; run it yourself with real RPC AND Supabase access.
//
// IMPORTANT — read before running against real mainnet:
//   `owner` (this script's `DEPLOYER_PRIVATE_KEY` account) can rotate
//   `planSigner` and the allowlists at any time afterward, but can NEVER
//   move funds directly — see the contract's own comment above
//   `setOwner`/`setAllowedTarget`/`setAllowedToken` ("None of these can
//   move funds"). Still: whoever holds this key can add/remove allowlisted
//   swap targets and tokens, so treat it with the same care as any other
//   privileged protocol key. `planSigner` is a SEPARATE key/wallet from
//   `owner` — see lib/blockchain/bag-execution-router-signer.ts's doc for
//   what it's used for (signing execution plans, never broadcasting admin
//   transactions). Do not reuse the same key for both roles in production;
//   this script lets you pass them separately.
//
// USAGE
//   export DEPLOYER_PRIVATE_KEY=0x...      # becomes `owner`, broadcasts everything below
//   export PLAN_SIGNER_ADDRESS=0x...       # the planSigner's ADDRESS (not its key — that key never touches this script)
//   export CANONICAL_TOKEN_ADDRESSES=0xabc...,0xdef...   # OPTIONAL — extra tokens the registry doesn't model yet
//   npx tsx scripts/deploy-bag-execution-router.ts robinhood <bagFactoryAddress>
//
// Once already deployed, keeping the on-chain allowlist in sync with LATER
// registry additions is `scripts/sync-router-token-allowlist.ts`'s job —
// this script only ever runs once, at deploy time.
//
// OUTPUT
//   Deployed BagExecutionRouter address + confirmation of every allowlist
//   entry set, with the exact env lines to paste into .env
//   (BAG_EXECUTION_ROUTER_ADDRESS=...). BAG_ROUTER_PLAN_SIGNER_KEY is NOT
//   printed or generated here — that's a private key you manage yourself,
//   this script only ever sees/uses the planSigner's public ADDRESS.
// -----------------------------------------------------------------------------

const SUPPORTED = ['robinhood', 'ethereum', 'base', 'arbitrum'] as const;
type SupportedChain = (typeof SUPPORTED)[number];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseArgs(): { chain: SupportedChain; bagFactoryAddress: `0x${string}` } {
  const [chainArg, factoryArg] = process.argv.slice(2);
  if (!chainArg || !(SUPPORTED as readonly string[]).includes(chainArg) || !factoryArg) {
    throw new Error(`Usage: npx tsx scripts/deploy-bag-execution-router.ts <${SUPPORTED.join('|')}> <bagFactoryAddress>`);
  }
  return { chain: chainArg as SupportedChain, bagFactoryAddress: factoryArg as `0x${string}` };
}

async function main() {
  const { chain, bagFactoryAddress } = parseArgs();
  const key = chain.toUpperCase();

  const rpcUrl = scriptRpcUrl(chain);

  const deployerKey = requireEnv('DEPLOYER_PRIVATE_KEY') as `0x${string}`;
  const planSignerAddress = requireEnv('PLAN_SIGNER_ADDRESS') as `0x${string}`;

  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — the canonical ' +
        'token list is sourced from the Asset Registry, so this script needs a real connection to read it.'
    );
  }
  const admin = supabaseAdmin();
  const canonicalTokens = (await getCanonicalInputTokensForChain(admin, chain)).map((t) => t.address as `0x${string}`);
  const extraTokens = (process.env.CANONICAL_TOKEN_ADDRESSES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as `0x${string}`[];
  const allTokens = Array.from(new Set([...canonicalTokens, ...extraTokens].map((a) => a.toLowerCase())))
    .map((a) => a as `0x${string}`);
  if (allTokens.length === 0) {
    throw new Error(
      `No VERIFIED assets found in the registry for chain "${chain}" and CANONICAL_TOKEN_ADDRESSES was not set — ` +
        'nothing to allowlist. Run the asset importer(s) for this chain first, or set CANONICAL_TOKEN_ADDRESSES explicitly.'
    );
  }

  const viemChain = getViemChainFor(chain);
  const account = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== viemChain.id) {
    throw new Error(`The RPC for ${chain} reports chain id ${liveChainId}, expected ${viemChain.id} for "${chain}". Refusing to deploy.`);
  }

  console.log(`Deploying BagExecutionRouter to ${chain} (chain id ${viemChain.id})`);
  console.log(`  owner (broadcasting wallet): ${account.address}`);
  console.log(`  bagFactory: ${bagFactoryAddress}`);
  console.log(`  planSigner: ${planSignerAddress}`);

  const deployHash = await walletClient.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode as `0x${string}`,
    args: [bagFactoryAddress, account.address, planSignerAddress],
  });
  console.log(`  deploy tx: ${deployHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Deployment failed. Receipt: ${JSON.stringify(receipt)}`);
  }
  const routerAddress = receipt.contractAddress;
  console.log(`\nDeployed BagExecutionRouter: ${routerAddress}`);

  // Allowlist the DEX target — this is what makes the router willing to
  // call `UNISWAP_ROUTER_ADDRESS` at all. On Robinhood Chain this is
  // already a VERIFIED constant (lib/config/robinhood-chain.ts); on any
  // other chain, set ROUTER_TARGET_ADDRESS to override.
  const swapTarget = (process.env.ROUTER_TARGET_ADDRESS as `0x${string}` | undefined) || UNISWAP_ROUTER_ADDRESS;
  if (!swapTarget) {
    throw new Error('No swap target configured — set ROUTER_TARGET_ADDRESS or use a chain with a known Uniswap router.');
  }
  console.log(`\nAllowlisting swap target: ${swapTarget}`);
  const targetTxHash = await walletClient.writeContract({
    address: routerAddress,
    abi: routerArtifact.abi,
    functionName: 'setAllowedTarget',
    args: [swapTarget, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: targetTxHash });
  console.log(`  tx: ${targetTxHash} (confirmed)`);

  console.log(`\nAllowlisting ${allTokens.length} canonical token(s) (${canonicalTokens.length} from the registry, ${extraTokens.length} extra):`);
  for (const token of allTokens) {
    const tokenTxHash = await walletClient.writeContract({
      address: routerAddress,
      abi: routerArtifact.abi,
      functionName: 'setAllowedToken',
      args: [token, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: tokenTxHash });
    console.log(`  ${token} — tx: ${tokenTxHash} (confirmed)`);
  }
  // Defensive, not load-bearing: getCanonicalInputTokensForChain() already
  // includes the chain's settlement token (ROBINHOOD_REWARD_TOKEN for
  // 'robinhood') — this only fires if that lookup somehow didn't (e.g. a
  // future chain with no settlement token configured yet).
  if (chain === 'robinhood' && !allTokens.some((t) => t.toLowerCase() === ROBINHOOD_REWARD_TOKEN.address.toLowerCase())) {
    console.log(`\nWARNING: ${ROBINHOOD_REWARD_TOKEN.symbol} (${ROBINHOOD_REWARD_TOKEN.address}) was not allowlisted — ` +
      'this is almost certainly required as the purchase input token. Add it via setAllowedToken manually.');
  }

  console.log('\n--- Deployed & configured ---');
  console.log(`BagExecutionRouter (${chain}): ${routerAddress}`);
  console.log('\nPaste into .env:');
  console.log(`BAG_EXECUTION_ROUTER_ADDRESS=${routerAddress}`);
  console.log('BAG_ROUTER_PLAN_SIGNER_KEY=<the private key for the planSigner address above — never printed by this script>');
  console.log('\nBefore enabling this in production, verify it is bound to the SAME BagFactory the app is configured');
  console.log('with (item 8 — a stale/mismatched factory makes every Bag Router purchase revert with UnknownBag):');
  console.log(`  npx tsx scripts/verify-bag-router-factory.ts ${chain} ${routerAddress}`);
  console.log('\nWhen the registry gains new VERIFIED assets later, re-sync this router\'s allowlist with:');
  console.log(`  npx tsx scripts/sync-router-token-allowlist.ts ${chain} bag-execution-router ${routerAddress} --apply`);
}

main().catch((err) => {
  console.error('\nDeployment FAILED:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
