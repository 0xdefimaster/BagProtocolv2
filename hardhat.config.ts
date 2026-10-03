import { fileURLToPath } from 'node:url';
import { defineConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

// Minimal Hardhat 3 config for the Phase 4 protocol layer (BagFactory + Bag).
// Local-only for now — no network config beyond Hardhat's built-in in-memory
// chain. Real network RPC endpoints (base, arbitrum, ...) are read from env
// at deploy time via lib/blockchain/evm/config.ts, not hardcoded here; see
// that file for why.
export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: '0.8.24',
    // Sandbox note (Phase 19.X-A): the environment that wrote this file
    // has no network access to binaries.soliditylang.org, so Hardhat's
    // normal solc download fails (HHE905). Pointing at the `solc` npm
    // package's bundled WASM build lets `hardhat compile`/`hardhat test`
    // run fully offline. Safe to remove this `path` once run somewhere
    // with normal network access — Hardhat will just download 0.8.24
    // itself instead.
    // fileURLToPath, not URL.pathname: on Windows .pathname yields an invalid
    // "/C:/..." path and the compiler cannot be loaded.
    path: fileURLToPath(new URL('./node_modules/solc/soljson.js', import.meta.url)),
  },
  paths: {
    tests: {
      nodejs: 'contracts/test',
    },
  },
  networks: {
    // -------------------------------------------------------------------
    // Phase 19.X-B — Robinhood Chain MAINNET fork, for the LI.FI
    // composability spike ONLY. Never used for a real broadcast (no
    // accounts/private key configured here on purpose — forking gives you
    // Hardhat's own funded dummy accounts, never real signers).
    //
    // Requires ROBINHOOD_MAINNET_RPC_URL to be set to a real Robinhood
    // Chain mainnet RPC endpoint — this sandbox's network egress allowlist
    // does not include rpc.mainnet.chain.robinhood.com (confirmed via a
    // direct curl returning 403 during this session), so `npx hardhat test
    // --network robinhoodFork` cannot actually run from here. It CAN run
    // anywhere with normal internet access once that env var is set — see
    // scripts/spike/19x-b/README.md.
    // -------------------------------------------------------------------
    robinhoodFork: {
      type: 'edr-simulated',
      chainType: 'l1',
      forking: process.env.ROBINHOOD_MAINNET_RPC_URL
        ? { url: process.env.ROBINHOOD_MAINNET_RPC_URL }
        : undefined,
    },
  },
});
