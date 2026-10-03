import './load-env';
import { scriptRpcUrl } from './rpc-url';
import { createPublicClient, createWalletClient, http, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import bagRouterArtifact from '../artifacts/contracts/BagExecutionRouter.sol/BagExecutionRouter.json' with { type: 'json' };
import redeemRouterArtifact from '../artifacts/contracts/RedeemFeeRouter.sol/RedeemFeeRouter.json' with { type: 'json' };
import { getViemChainFor } from '../lib/blockchain/evm/config';
import { getCanonicalInputTokensForChain, computeAllowlistDrift } from '../lib/server/canonical-input-tokens';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';
import { ChainId } from '../types/basket-protocol';

// -----------------------------------------------------------------------------
// scripts/sync-router-token-allowlist.ts
//
// H1 follow-up (security audit) — "router allowlist must not silently
// diverge from the registry". A deploy script only ever sets the
// allowlist ONCE, at deploy time; every asset the registry adds AFTER
// that (a new coingecko-import.ts/robinhood-import.ts run) needs a
// SEPARATE step to actually reach the on-chain router, or it silently
// stays un-purchasable/un-redeemable even though the app's own UI thinks
// it's VERIFIED. This is that step — a real diff between "what the
// registry says should be allowed" and "what the chain currently allows",
// reconstructed from the router's own `TokenAllowlistUpdated`/
// `InputTokenAllowlistUpdated` events (Solidity mappings aren't
// enumerable, so replaying every allowlist-changed event in order is the
// only way to know the CURRENT on-chain set without a subgraph).
//
// Dry-run by default, same convention as every other importer/sync script
// in this repo (scripts/import-lifi-assets.ts, import-robinhood-assets.ts):
// prints the diff, writes nothing unless run with --apply.
//
// `missing` (registry says allowed, chain doesn't have it yet) is the only
// direction `--apply` ever touches — it is unambiguously safe, since it
// only ever ADDS an allowlist entry a real purchase/redemption already
// needs. `extra` (chain has it allowed, current registry fetch doesn't
// name it) is NEVER auto-removed, printed only for a human to review: a
// redemption-side allowlist (RedeemFeeRouter) legitimately keeps a
// DEPRECATED asset allowed forever if any Bag might still hold it, so
// "not in today's registry answer" is not the same claim as "unsafe to
// leave allowed" — see lib/server/canonical-input-tokens.ts's own module
// doc for the full reasoning.
//
// CANNOT BE RUN FROM THIS SANDBOX for the same network-egress reason every
// other deploy/apply script here can't be — run it yourself with real RPC
// (and, for --apply, a real DEPLOYER_PRIVATE_KEY holding the router's
// `owner` role) access.
//
// USAGE
//   npx tsx scripts/sync-router-token-allowlist.ts <robinhood|ethereum|base|arbitrum> \
//     <bag-execution-router|redeem-fee-router> <routerAddress> [--apply] [--from-block=N]
//
//   RPC: <CHAIN>_RPC_URL, else ALCHEMY_API_KEY, else the public RPC (same
//   resolver as the app). --from-block defaults to 0 — pass the router's real
//   deployment block in production so this doesn't scan the entire chain
//   history on every run.
// -----------------------------------------------------------------------------

const SUPPORTED_CHAINS = ['robinhood', 'ethereum', 'base', 'arbitrum'] as const;
type SupportedChain = (typeof SUPPORTED_CHAINS)[number];
const ROUTER_TYPES = ['bag-execution-router', 'redeem-fee-router'] as const;
type RouterType = (typeof ROUTER_TYPES)[number];

interface Args {
  chain: SupportedChain;
  routerType: RouterType;
  routerAddress: `0x${string}`;
  apply: boolean;
  fromBlock: bigint;
}

function parseArgs(): Args {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const [chainArg, routerTypeArg, addressArg] = positional;

  if (
    !chainArg ||
    !(SUPPORTED_CHAINS as readonly string[]).includes(chainArg) ||
    !routerTypeArg ||
    !(ROUTER_TYPES as readonly string[]).includes(routerTypeArg) ||
    !addressArg
  ) {
    throw new Error(
      `Usage: npx tsx scripts/sync-router-token-allowlist.ts <${SUPPORTED_CHAINS.join('|')}> ` +
        `<${ROUTER_TYPES.join('|')}> <routerAddress> [--apply] [--from-block=N]`
    );
  }

  const fromBlockFlag = flags.find((f) => f.startsWith('--from-block='));
  const fromBlock = fromBlockFlag ? BigInt(fromBlockFlag.slice('--from-block='.length)) : 0n;

  return {
    chain: chainArg as SupportedChain,
    routerType: routerTypeArg as RouterType,
    routerAddress: addressArg as `0x${string}`,
    apply: flags.includes('--apply'),
    fromBlock,
  };
}

const EVENT_NAME: Record<RouterType, string> = {
  'bag-execution-router': 'TokenAllowlistUpdated',
  'redeem-fee-router': 'InputTokenAllowlistUpdated',
};
const SET_FUNCTION: Record<RouterType, string> = {
  'bag-execution-router': 'setAllowedToken',
  'redeem-fee-router': 'setAllowedInputToken',
};
const ARTIFACT: Record<RouterType, { abi: unknown[] }> = {
  'bag-execution-router': bagRouterArtifact as { abi: unknown[] },
  'redeem-fee-router': redeemRouterArtifact as { abi: unknown[] },
};

/**
 * Reconstructs the CURRENT on-chain allowlist set by replaying every
 * `event(address indexed token, bool allowed)` this router has ever
 * emitted for it, in order — Solidity mappings have no "list every key"
 * query, so this event replay is the only way to answer "what does the
 * chain currently allow" without a subgraph/indexer.
 */
async function reconstructOnChainAllowlist(
  publicClient: ReturnType<typeof createPublicClient>,
  routerAddress: `0x${string}`,
  eventName: string,
  fromBlock: bigint
): Promise<Set<string>> {
  const logs = await publicClient.getLogs({
    address: routerAddress,
    event: parseAbiItem(`event ${eventName}(address indexed token, bool allowed)`),
    fromBlock,
    toBlock: 'latest',
  });

  const state = new Set<string>();
  for (const log of logs) {
    const args = log.args as { token: `0x${string}`; allowed: boolean };
    const token = args.token.toLowerCase();
    if (args.allowed) state.add(token);
    else state.delete(token);
  }
  return state;
}

async function main() {
  const { chain, routerType, routerAddress, apply, fromBlock } = parseArgs();

  const key = chain.toUpperCase();
  const rpcUrl = scriptRpcUrl(chain);

  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured — the canonical token list is sourced from the Asset Registry.');
  }

  const viemChain = getViemChainFor(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

  console.log(`Reconstructing on-chain allowlist for ${routerType} @ ${routerAddress} (${chain}, from block ${fromBlock})...`);
  const onChain = await reconstructOnChainAllowlist(publicClient, routerAddress, EVENT_NAME[routerType], fromBlock);
  console.log(`  ${onChain.size} token(s) currently allowed on-chain.`);

  const admin = supabaseAdmin();
  // redeem-fee-router is the redemption side — must also cover DEPRECATED
  // assets a Bag might still be holding (see this file's own module doc,
  // and canonical-input-tokens.ts's).
  const canonical = await getCanonicalInputTokensForChain(admin, chain as ChainId, {
    includeDeprecated: routerType === 'redeem-fee-router',
  });
  console.log(`  ${canonical.length} canonical token(s) from the registry.`);

  const drift = computeAllowlistDrift(canonical, onChain);

  console.log(`\nMissing (registry says allowed, chain does not have it yet) — ${drift.missing.length}:`);
  for (const t of drift.missing) console.log(`  ${t.symbol} (${t.address}) [${t.purpose}]`);

  console.log(`\nExtra (chain currently allows it, this fetch's registry answer doesn't name it) — ${drift.extra.length}:`);
  console.log('  NEVER auto-removed — review each manually before deciding whether to disable it:');
  for (const addr of drift.extra) console.log(`  ${addr}`);

  if (drift.missing.length === 0) {
    console.log('\nNothing to apply — on-chain allowlist already covers every canonical token.');
    return;
  }

  if (!apply) {
    console.log('\nDry run only — re-run with --apply to write the missing entries on-chain.');
    return;
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!deployerKey) throw new Error('Missing required env var: DEPLOYER_PRIVATE_KEY (must hold this router\'s `owner` role).');

  const account = privateKeyToAccount(deployerKey);
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
  const artifact = ARTIFACT[routerType];
  const fnName = SET_FUNCTION[routerType];

  console.log(`\nApplying ${drift.missing.length} missing entr(y/ies) as ${account.address}:`);
  for (const token of drift.missing) {
    const hash = await walletClient.writeContract({
      address: routerAddress,
      abi: artifact.abi,
      functionName: fnName,
      args: [token.address, true],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${token.symbol} (${token.address}) — tx: ${hash} (confirmed)`);
  }
}

main().catch((err) => {
  console.error('\nsync-router-token-allowlist FAILED:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
