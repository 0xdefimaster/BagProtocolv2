# Phase 19.X-A spike — running it for real

Everything in `contracts/spike/` and `contracts/test/spike/` was written,
compiled, and test-executed in this environment — see
`docs/PHASE_19X_REPORT.md`. What could **not** be done here is broadcasting
to the actual Robinhood Chain Testnet (chain id `46630`): this sandbox's
network egress is limited to package registries (npm, PyPI, GitHub) and
cannot reach `rpc.testnet.chain.robinhood.com` or any other RPC endpoint.

`deploy-19x-a.ts` is the script that produces the real STEP 9 evidence
(deployed addresses, tx hash, block number). To run it yourself:

1. `cp .env.example .env.local` (if you haven't already) and add:
   ```
   SPIKE_RPC_URL=https://rpc.testnet.chain.robinhood.com
   SPIKE_DEPLOYER_PRIVATE_KEY=0x...   # a NEW, throwaway, testnet-only key
   ```
2. Fund that address at https://faucet.testnet.chain.robinhood.com
   (0.1 test ETH/day, no real value).
3. `npx hardhat compile` (uses the local `solc` WASM build already wired up
   in `hardhat.config.ts` — works with or without network access to
   soliditylang.org).
4. `npx tsx scripts/spike/deploy-19x-a.ts`

The script deploys everything, seeds the two test pools, submits the one
composed transaction, and writes `scripts/spike/19x-a-results.json` plus an
explorer link. Paste the resulting JSON back so the Phase 19.X-A report's
STEP 9 section can cite real testnet evidence instead of only the local
Hardhat-network test run.

Phase 19.X-B (the LI.FI mainnet-fork leg) is intentionally not started —
per the phase instructions, it's gated on 19.X-A's results being reviewed,
and separately needs an officially-obtained LI.FI quote (this sandbox can't
reach `li.quest` either — see the report).
