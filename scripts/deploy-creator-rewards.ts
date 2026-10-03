import './load-env';
import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_REWARD_TOKEN,
  UNISWAP_ROUTER_ADDRESS,
  assertRobinhoodChainMainnetLike,
} from '../lib/config/robinhood-chain';
import vaultArtifact from '../artifacts/contracts/CreatorRewardsVault.sol/CreatorRewardsVault.json' with { type: 'json' };
import routerArtifact from '../artifacts/contracts/RedeemFeeRouter.sol/RedeemFeeRouter.json' with { type: 'json' };
import { getCanonicalInputTokensForChain } from '../lib/server/canonical-input-tokens';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

// -----------------------------------------------------------------------------
// Deploys CreatorRewardsVault + RedeemFeeRouter to Robinhood Chain mainnet
// ONLY (section 21/29/49 of the production settlement brief). Wires the
// router in as a vault settler. Prints every address/tx hash so they can be
// pasted into .env / lib/config/robinhood-chain.ts's DEPLOYED_CONTRACTS —
// this script does NOT write files or persist state itself, on purpose:
// a deploy script that silently overwrites its own config on every run is
// how a wrong/duplicate deployment quietly becomes "the" address.
//
// CANNOT BE RUN FROM THIS SANDBOX: the container's network egress allowlist
// does not include rpc.mainnet.chain.robinhood.com (see the top-level
// system network_configuration — only npm/pypi/github domains are open).
// This script compiles and its preflight assertions are unit-tested
// (see lib/config/__tests__/robinhood-chain.test.ts's chain-id-guard
// coverage), but an actual broadcast to Robinhood Chain has NOT been
// performed or verified from here — run it yourself with real RPC access,
// per section 42's "never claim mainnet integration was verified when it
// was not".
// -----------------------------------------------------------------------------

const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER_URL } },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main() {
  // Fails closed immediately if anyone points this at the wrong network by
  // accident (e.g. a stray testnet RPC left in the shell environment).
  assertRobinhoodChainMainnetLike(ROBINHOOD_CHAIN_ID);

  const deployerKey = requireEnv('CREATOR_REWARDS_DEPLOYER_PRIVATE_KEY') as `0x${string}`;
  const ownerAddress = requireEnv('CREATOR_REWARDS_OWNER_ADDRESS') as `0x${string}`;
  const settlementWalletAddress = requireEnv('CREATOR_REWARDS_SETTLEMENT_WALLET_ADDRESS') as `0x${string}`;
  const feeAttestorAddress = requireEnv('REDEEM_FEE_ATTESTOR_ADDRESS') as `0x${string}`;

  const account = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

  const liveChainId = await publicClient.getChainId();
  assertRobinhoodChainMainnetLike(liveChainId); // re-check against what the RPC ACTUALLY reports, not just our config constant

  console.log(`Deploying to Robinhood Chain mainnet (${ROBINHOOD_CHAIN_ID}) as ${account.address}`);
  console.log(`Reward token: ${ROBINHOOD_REWARD_TOKEN.symbol} @ ${ROBINHOOD_REWARD_TOKEN.address}`);

  // 1. CreatorRewardsVault — initial settler is the settlement worker wallet.
  const vaultDeployHash = await walletClient.deployContract({
    abi: vaultArtifact.abi,
    bytecode: vaultArtifact.bytecode as `0x${string}`,
    args: [ROBINHOOD_REWARD_TOKEN.address, ownerAddress, settlementWalletAddress],
  });
  const vaultReceipt = await publicClient.waitForTransactionReceipt({ hash: vaultDeployHash });
  const vaultAddress = vaultReceipt.contractAddress;
  if (!vaultAddress) throw new Error('CreatorRewardsVault deployment produced no contract address');
  console.log(`CreatorRewardsVault deployed: ${vaultAddress} (tx ${vaultDeployHash}, block ${vaultReceipt.blockNumber})`);

  // 2. RedeemFeeRouter — points at the vault + reward token + fee attestor.
  const routerDeployHash = await walletClient.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode as `0x${string}`,
    args: [ROBINHOOD_REWARD_TOKEN.address, vaultAddress, feeAttestorAddress, ownerAddress],
  });
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerDeployHash });
  const routerAddress = routerReceipt.contractAddress;
  if (!routerAddress) throw new Error('RedeemFeeRouter deployment produced no contract address');
  console.log(`RedeemFeeRouter deployed: ${routerAddress} (tx ${routerDeployHash}, block ${routerReceipt.blockNumber})`);

  // 3. Wire the router in as a second vault settler. Owner-only call, so
  // this only succeeds if `ownerAddress` above matches the deployer's own
  // key — in production ownerAddress is a multisig, so this step must
  // actually be executed separately, by the multisig, not by this script.
  // We still attempt it here for the common case (single-EOA staging
  // deploys) and print a clear instruction if it's skipped/fails.
  if (account.address.toLowerCase() === ownerAddress.toLowerCase()) {
    const setSettlerHash = await walletClient.writeContract({
      address: vaultAddress,
      abi: vaultArtifact.abi,
      functionName: 'setSettler',
      args: [routerAddress, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: setSettlerHash });
    console.log(`Vault.setSettler(router, true) confirmed (tx ${setSettlerHash})`);
  } else {
    console.log(
      `SKIPPED: owner (${ownerAddress}) is not the deploying key — the multisig must separately call ` +
        `vault.setSettler(${routerAddress}, true) before RedeemFeeRouter can settle any fee.`
    );
  }

  // H1 follow-up (security audit) — WITHOUT this step, RedeemFeeRouter
  // deploys with BOTH allowlists empty and every redemption reverts
  // immediately (`SwapTargetNotAllowed`/`InputTokenNotAllowed`) until
  // someone remembers to configure it by hand — exactly the same trap
  // `deploy-bag-execution-router.ts`'s own doc warns about. Input tokens
  // are sourced from the SAME canonical registry that script uses
  // (`getCanonicalInputTokensForChain`), scoped to `includeDeprecated:
  // true` here specifically: a Bag created while some asset was VERIFIED
  // can still be holding it after that asset is later marked DEPRECATED,
  // and that Bag's investors must still be able to redeem out of it — a
  // redemption-side allowlist that only covered currently-VERIFIED assets
  // would silently strand exactly those holders.
  if (account.address.toLowerCase() === ownerAddress.toLowerCase()) {
    if (!UNISWAP_ROUTER_ADDRESS) {
      console.log('\nSKIPPED allowlisting: UNISWAP_ROUTER_ADDRESS is not configured for this chain.');
    } else if (!isSupabaseConfigured()) {
      console.log(
        '\nSKIPPED allowlisting: Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / ' +
          'SUPABASE_SERVICE_ROLE_KEY) — the canonical input-token list is sourced from the Asset Registry. ' +
          `Configure it and re-run, or call setSwapTarget(${UNISWAP_ROUTER_ADDRESS}, true) and ` +
          'setAllowedInputToken(...) manually for every token this Bag holds.'
      );
    } else {
      const admin = supabaseAdmin();
      const setSwapTargetHash = await walletClient.writeContract({
        address: routerAddress,
        abi: routerArtifact.abi,
        functionName: 'setSwapTarget',
        args: [UNISWAP_ROUTER_ADDRESS, true],
      });
      await publicClient.waitForTransactionReceipt({ hash: setSwapTargetHash });
      console.log(`\nRedeemFeeRouter.setSwapTarget(${UNISWAP_ROUTER_ADDRESS}, true) confirmed (tx ${setSwapTargetHash})`);

      const inputTokens = await getCanonicalInputTokensForChain(admin, 'robinhood', { includeDeprecated: true });
      console.log(`Allowlisting ${inputTokens.length} canonical input token(s) (VERIFIED + DEPRECATED, includes ${ROBINHOOD_REWARD_TOKEN.symbol}):`);
      for (const token of inputTokens) {
        const setInputTokenHash = await walletClient.writeContract({
          address: routerAddress,
          abi: routerArtifact.abi,
          functionName: 'setAllowedInputToken',
          args: [token.address, true],
        });
        await publicClient.waitForTransactionReceipt({ hash: setInputTokenHash });
        console.log(`  ${token.symbol} (${token.address}) — tx: ${setInputTokenHash} (confirmed)`);
      }
    }
  } else {
    console.log(
      `\nSKIPPED allowlisting: owner (${ownerAddress}) is not the deploying key — the multisig must separately call ` +
        `router.setSwapTarget(${UNISWAP_ROUTER_ADDRESS}, true) and router.setAllowedInputToken(token, true) for every ` +
        'redeemable asset (see scripts/sync-router-token-allowlist.ts for the exact list) before any redemption can succeed.'
    );
  }

  console.log('\n--- Paste into your production env / lib/config/robinhood-chain.ts DEPLOYED_CONTRACTS ---');
  console.log(`CREATOR_REWARDS_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`REDEEM_FEE_ROUTER_ADDRESS=${routerAddress}`);
  console.log(`chainId=${ROBINHOOD_CHAIN_ID} owner=${ownerAddress} settlementWallet=${settlementWalletAddress} feeAttestor=${feeAttestorAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
