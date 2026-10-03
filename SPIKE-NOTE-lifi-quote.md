# Spike note: LI.FI on Robinhood Chain (4663) — quote and real-chain E2E

## Scripts

| Script | What it does | Moves funds? |
|---|---|---|
| `npm run spike:lifi-quote` (`scripts/spike/lifi-quote-test.ts`) | Checks the RPC chain id, fetches LI.FI's token registry for 4663, verifies token contracts on-chain, then gets and freshness-checks one quote | No |
| `npx tsx scripts/spike/lifi-e2e-execute.ts` | Gets a quote for a disposable wallet, validates the returned transaction (chain, target contract, value cap, sender, freshness) and simulates it with `eth_estimateGas`. **Dry run by default.** | Only with `--send` and all safeguards (below) |

Every stop carries a precise **diagnosis** (`lib/blockchain/lifi-diagnostics.ts`,
unit-tested), so different failures are never collapsed into one:

| Diagnosis | Meaning |
|---|---|
| `EGRESS_BLOCKED` | A proxy (for example this sandbox) refused the host. **Says nothing about LI.FI or the chain.** |
| `RPC_UNREACHABLE` / `RPC_HTTP_ERROR` / `RPC_JSONRPC_ERROR` | The RPC transport, HTTP or JSON-RPC layer failed |
| `RPC_WRONG_CHAIN` | The RPC answers, but not as chain 4663 |
| `LIFI_UNREACHABLE` | li.quest is not reachable (network error) |
| `LIFI_UNSUPPORTED_CHAIN` | LI.FI lists no tokens for 4663, or rejects the chain |
| `LIFI_UNSUPPORTED_ROUTE` | The chain is known, but there is no route for the pair or amount (404 / "no available quotes") |
| `LIFI_RATE_LIMITED` / `LIFI_AUTH_ERROR` / `LIFI_SERVER_ERROR` / `LIFI_CLIENT_ERROR` | HTTP 429 / 401–403 / 5xx / other 4xx from LI.FI |
| `LIFI_RESPONSE_MISMATCH` | HTTP 200, but the body does not match the request (stale or wrong response) |
| `SIMULATION_FAILED`, `TX_REVERTED`, `TX_TIMEOUT`, `SEND_REFUSED` | E2E stages |

## Real-chain E2E: disposable wallet only

Never use a real or main wallet. Never commit a key: `.env*.local` is
git-ignored, and the script reads the key from the environment only and never
prints or writes it.

    # dry run (no key needed):
    ROBINHOOD_RPC_URL=… E2E_TO_TOKEN=0x<token> E2E_AMOUNT_WEI=1000000000000000 \
    E2E_FROM_ADDRESS=0x<disposable> npx tsx scripts/spike/lifi-e2e-execute.ts

    # broadcast (tiny amount, disposable wallet):
    ROBINHOOD_RPC_URL=… E2E_TO_TOKEN=0x<token> E2E_AMOUNT_WEI=1000000000000000 \
    E2E_PRIVATE_KEY=0x<disposable key> E2E_MAX_AMOUNT_WEI=2000000000000000 \
    E2E_CONFIRM=I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS \
    npx tsx scripts/spike/lifi-e2e-execute.ts --send

`--send` refuses to run without all three safeguards: the key,
`E2E_CONFIRM`, and an amount at or below `E2E_MAX_AMOUNT_WEI`. It supports
native-asset input only, so no ERC-20 approval is ever sent. It reports
success only from a mined, successful receipt.

## Results from this sandbox

**NOT VERIFIED.** Both scripts ran here and stopped at `EGRESS_BLOCKED`: the
sandbox proxy returned `403 x-deny-reason: host_not_allowed` for
`rpc.mainnet.chain.robinhood.com` and `li.quest`. Neither service was
reached, so nothing is known about LI.FI's support for chain 4663 from this
environment.

Evidence: `reports/lifi-quote-result.json`, `reports/lifi-e2e-result.json`.

To verify, run both scripts from a machine with normal internet access and
share the stdout and the two JSON reports.
