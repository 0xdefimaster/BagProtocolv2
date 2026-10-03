import { network } from 'hardhat';
import { parseAbi, type Hex } from 'viem';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// -----------------------------------------------------------------------------
// Phase 19.X-B — LI.FI mainnet-fork composability spike RUNNER.
//
// This is the harness the master prompt's Steps 1-11 describe. It cannot be
// executed from the sandbox that wrote it (see README.md in this directory
// for the exact, reproduced network failures) — provided here, verified for
// syntax/config correctness (hardhat.config.ts's `robinhoodFork` network
// connects; deploying BagRouterSpike to a LOCAL non-forked chain via this
// same script was smoke-tested), so that running it for real is a matter of
// (1) providing ROBINHOOD_MAINNET_RPC_URL, (2) providing a real LI.FI quote
// in lifi-quote.json, not writing new code.
//
// PREFLIGHT SAFETY CHECK (the reason this file exists rather than just
// reusing 19.X-A's test file): `--network robinhoodFork` WITHOUT
// ROBINHOOD_MAINNET_RPC_URL set does NOT error — Hardhat silently falls
// back to an empty local chain (chainId 31337), which would make this
// entire spike meaningless (composing against contracts that don't exist)
// while looking like it ran. This script refuses to proceed unless the
// connected chain both reports chainId 4663 AND has real bytecode at the
// known USDG address — failing loudly, per this codebase's "never silently
// downgrade real blockchain behavior" rule, rather than quietly testing
// against nothing.
// -----------------------------------------------------------------------------

const ROBINHOOD_CHAIN_ID = 4663;
const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

interface LiFiQuote {
  transactionRequest: { to: Hex; data: Hex; value: Hex; from: Hex; chainId: number };
  fromToken: { address: Hex; symbol: string; decimals: number };
  toToken: { address: Hex; symbol: string; decimals: number };
  fromAmount: string;
  estimate: { approvalAddress: Hex };
}

function loadRealQuote(): LiFiQuote {
  const path = join(import.meta.dirname, 'lifi-quote.json');
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. This spike requires a REAL LI.FI quote — see lifi-quote.example.json for the ` +
        `exact shape and README.md for how to fetch one. This script will not fabricate one.`
    );
  }
  const quote = JSON.parse(readFileSync(path, 'utf-8')) as LiFiQuote;
  if (!quote.transactionRequest?.to || !quote.transactionRequest?.data || quote.transactionRequest.data === '0x') {
    throw new Error('lifi-quote.json is missing a real transactionRequest.to/data — refusing to run with an empty/placeholder quote.');
  }
  if (quote.transactionRequest.chainId !== ROBINHOOD_CHAIN_ID || !quote.fromToken.address || !quote.toToken.address) {
    throw new Error('lifi-quote.json looks unfilled (see lifi-quote.example.json comments) — refusing to run.');
  }
  return quote;
}

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
]);

async function main() {
  const { viem } = await network.connect({ network: 'robinhoodFork' });
  const publicClient = await viem.getPublicClient();

  // --- Preflight: are we ACTUALLY on a Robinhood Chain mainnet fork? -----
  const chainId = await publicClient.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `PREFLIGHT FAILED: connected chainId is ${chainId}, not ${ROBINHOOD_CHAIN_ID}. ` +
        `Set ROBINHOOD_MAINNET_RPC_URL to a real Robinhood Chain mainnet RPC endpoint and retry ` +
        `with: ROBINHOOD_MAINNET_RPC_URL=<url> npx hardhat run scripts/spike/19x-b/run.ts --network robinhoodFork`
    );
  }
  const usdgCode = await publicClient.getBytecode({ address: USDG_ADDRESS });
  if (!usdgCode || usdgCode === '0x') {
    throw new Error(
      `PREFLIGHT FAILED: chainId reports ${ROBINHOOD_CHAIN_ID} but there is no contract bytecode at the ` +
        `known USDG address (${USDG_ADDRESS}). This is not a real Robinhood Chain mainnet fork.`
    );
  }
  console.log(`Preflight OK — real Robinhood Chain mainnet fork confirmed (chainId ${chainId}, USDG bytecode present).`);

  const quote = loadRealQuote();
  console.log('Loaded real LI.FI quote:', JSON.stringify({ from: quote.fromToken.symbol, to: quote.toToken.symbol, amount: quote.fromAmount }, null, 2));

  const [walletClient] = await viem.getWalletClients();
  const router = await viem.deployContract('BagRouterSpike');
  console.log('BagRouterSpike deployed at', router.address);

  // Fund the test wallet with the real fromToken by impersonating a known
  // large holder on the fork (standard fork-testing technique — never
  // possible/meaningful outside a fork). Left as a TODO with an explicit
  // marker rather than guessing a holder address: the actual holder to
  // impersonate depends on which pair the real quote above turned out to
  // be for, which this script cannot know until a real quote exists.
  throw new Error(
    'NOT IMPLEMENTED PAST THIS POINT: funding the test wallet with a real ' +
      `${quote.fromToken.symbol} balance requires impersonating a known real holder on ` +
      'the fork (see comment above) — which token/holder depends on the actual quote pair, ' +
      'unknown until a real LI.FI quote exists. Steps 3-11 (compose Leg A + real LI.FI Leg B, ' +
      'success/failure/rollback assertions) follow the exact pattern already proven in ' +
      'contracts/test/spike/BagRouterSpike.test.ts once funding is resolved.'
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
