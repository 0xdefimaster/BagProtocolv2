# Deploying the security-hardening changes

What has to happen outside the code for the hardening changes on this branch
to take effect.

## 0. Set APP_ORIGIN

Set `APP_ORIGIN` to the site's public origin (e.g. `https://bagprotocol.xyz`)
in Netlify. The wallet sign-in message names this domain; without it the
domain comes from the request.

## 1. Rotate every secret that ever left the server

Any value that was in a `.env`/`.env.local` file shared outside the team
(zip, chat, screenshot) must be treated as public and replaced — not just
removed:

| Secret | Where to rotate |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API → roll the service role / secret key |
| `SESSION_SECRET` | New random value, **at least 32 characters** (`openssl rand -base64 48`). Rotating it signs everyone out. |
| `DEPLOYER_PRIVATE_KEY`, `CREATOR_REWARDS_DEPLOYER_PRIVATE_KEY`, `CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY`, `BAG_ROUTER_PLAN_SIGNER_KEY`, `REDEEM_FEE_ATTESTOR_PRIVATE_KEY` | New wallets. Move any funds off the old ones, then point the contracts at the new addresses (`setPlanSigner`, `setFeeAttestor`, `setSettler`). |
| `LIFI_API_KEY`, `ALCHEMY_API_KEY`, `COINGECKO_API_KEY` | Provider dashboards |
| `CRON_SECRET` | New random value |

`scripts/check-no-secrets.sh` runs in CI and fails on any tracked `.env`
file (other than `.env.example`) or private-key literal.

## 2. Database

Run `supabase/migrations/0040_security_hardening.sql` in the Supabase SQL
editor (it is also included in `supabase/schema.sql` for fresh projects).
It adds tx-hash single-use claims, the new nonce table shape, the
settlement-batch filter, and turns RLS on for the remaining tables.

## 3. Contracts

`BagExecutionRouter` and `RedeemFeeRouter` changed on-chain behaviour
(leftover refunds, mandatory output floors, swap-calldata binding). The
fee-attestation EIP-712 domain version is now `'3'`, so the backend signer
only works with a newly deployed `RedeemFeeRouter`. Redeploy both, then
update the deployed addresses, re-run the allowlist sync
(`npm run sync:router-token-allowlist`) and register the new
`RedeemFeeRouter` as a settler on `CreatorRewardsVault`.

### Privileged keys

`BAG_ROUTER_PLAN_SIGNER_KEY` and `REDEEM_FEE_ATTESTOR_PRIVATE_KEY` are not
just "attestation" keys. The plan signer chooses every swap leg's calldata,
and an allowlisted DEX's calldata can name the swap recipient. A stolen
signer can therefore author plans that route a user's swap output elsewhere,
limited only by the router's own output checks. Treat both as hot
execution-authorization keys:

- keep them in an isolated signer or HSM, not in a shared `.env`;
- know the rotation steps (`setPlanSigner`, `setFeeAttestor`) before you
  need them;
- alert on unexpected `ExecutionCompleted` / `Redeemed` volume;
- make the contracts' `owner` a multisig.

## 4. Scheduled jobs on Netlify

Netlify does not read `vercel.json` crons. `netlify/functions/` contains
Scheduled Functions that call the cron routes with `Authorization: Bearer
$CRON_SECRET`:

- `settle-pending-executions` — hourly
- `reconcile-wallets` — hourly (plus a check of each wallet when it connects)
- `snapshot-bag-navs` — hourly (a Bag page visit also records one when the last is over 15 minutes old)
- `settle-creator-rewards` — every 15 minutes; skipped while
  `CREATOR_REWARDS_VAULT_ADDRESS` or `CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY` is unset
- `refresh-asset-routes` — hourly
- `reconcile-creator-rewards` — hourly; skipped while `CREATOR_REWARDS_VAULT_ADDRESS` is unset

They need `CRON_SECRET` in the Netlify environment (`URL` is set by
Netlify). Without it they log and skip; the routes also refuse all calls.
Each run costs Netlify credits, so a job whose configuration is missing
returns before invoking its route.

`netlify.toml` skips builds whose changes cannot affect the site (docs,
Markdown, tests, CI workflows, contracts, operator scripts;
`scripts/netlify-skip-build.sh`). A manual redeploy of the same commit,
e.g. after changing an environment variable, always builds.
After deploying, check Netlify → Functions → Scheduled for their runs.
