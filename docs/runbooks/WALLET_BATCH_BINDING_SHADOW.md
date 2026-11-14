# Runbook: exact smart-account binding, from shadow to enforce (M2)

**Who runs it:** the maintainer. Steps 3, 5 and 7 change production configuration and need an explicit decision.
Nothing in this file has been executed. The flag ships **off**.

## What the flag does

`BAG_WALLET_BATCH_BINDING` (lib/config/execution.ts), read on every verification:

| Value | Verdict that decides | Extra work |
|---|---|---|
| `off` (default, unset, anything else) | legacy calldata containment (known gaps T-1 and F-01) | none |
| `shadow` | legacy | the exact binding runs beside it (two state reads per smart-account envelope) and logs `[wallet-binding-shadow] {…}` for every smart-account envelope and every disagreement |
| `enforce` | exact binding (`@bagprotocol/sdk` `verifyWalletExecution`) | refusals fail the intent with `VERIFICATION_FAILED` and the issue code in the message; unreadable historical state keeps it `PENDING` |

It covers Composer purchases (`flow: purchase`), sales (`redeem`) and rebalances (`rebalance`). Direct calls bind
the same way in every mode and read no wallet state.

## 1. Pins still valid (read-only)

```bash
node scripts/audit/verify-smart-account-pins.mjs
```

Every chain the app uses must show `trustable: true` (pinned DelegationManager and EIP7702StatelessDeleGator code
identical to the Sourcify-verified build apart from the chain id and EIP-712 domain hash, and the implementation
bound to the pinned DelegationManager). 2026-11-14: Robinhood, Base and Arbitrum all `true`
(`evidence/smart-account/metamask-delegation-pins-2026-11-14.json`).

## 2. Replay past transactions (read-only)

Export the stored expectations in the Supabase SQL editor (read-only `select`; the output contains wallet addresses,
keep it local and do not commit it):

```sql
select json_agg(c) from (
  (select distinct on (p.id) json_build_object(
    'label', 'purchase ' || p.id, 'chain', s->>'sourceChain', 'txHash', s->>'txHash', 'wallet', p.wallet_address,
    'expected', json_build_object('to', p.composer_transaction->>'to', 'data', p.composer_transaction->>'data', 'value', coalesce(p.composer_transaction->>'value', '0')),
    'approvals', coalesce(p.composer_transaction->'approvals', '[]'::jsonb)) as c
  from purchase_intents p cross join lateral jsonb_array_elements(p.steps) s
  where p.composer_transaction is not null and s->>'txHash' is not null order by p.id)
  union all
  (select distinct on (r.id) json_build_object(
    'label', 'redeem ' || r.id, 'chain', s->>'sourceChain', 'txHash', s->>'txHash', 'wallet', r.wallet_address,
    'expected', json_build_object('to', r.composer_transaction->>'to', 'data', r.composer_transaction->>'data', 'value', coalesce(r.composer_transaction->>'value', '0')),
    'approvals', coalesce(r.composer_transaction->'approvals', '[]'::jsonb))
  from redeem_intents r cross join lateral jsonb_array_elements(r.steps) s
  where r.composer_transaction is not null and s->>'txHash' is not null order by r.id)
  union all
  (select json_build_object(
    'label', 'rebalance ' || b.id, 'chain', 'robinhood', 'txHash', b.tx_hash, 'wallet', b.wallet_address,
    'expected', json_build_object('to', b.composer_transaction->>'to', 'data', b.composer_transaction->>'data', 'value', coalesce(b.composer_transaction->>'value', '0')),
    'approvals', coalesce(b.composer_transaction->'approvals', '[]'::jsonb))
  from rebalance_intents b where b.tx_hash is not null)
) cases;
```

Save the array as `cases.json` outside the repository, then:

```bash
npx tsx scripts/audit/wallet-binding-replay.ts cases.json
```

Expected: every transaction the maintainer knows to be a legitimate MetaMask smart-account (or direct) one is
`BOUND`. Read every `REFUSED` and `INDETERMINATE` row before step 3. Already observed on public Base traffic
(`evidence/smart-account/base-7702-batch-replay-2026-11-14.json`): three real MetaMask EIP-5792 batches `BOUND`; two
from another EIP-7702 implementation refused as `DELEGATE_NOT_TRUSTED`.

## 3. Shadow in production (configuration change: approval required)

Set `BAG_WALLET_BATCH_BINDING=shadow` for the production context in the hosting environment and redeploy. The
production RPC must serve the previous block's code and nonce for each chain (Alchemy archive does; a pruned node
logs `STATE_UNAVAILABLE`).

## 4. Read the shadow log

Filter function logs for `[wallet-binding-shadow]`. Each line:

```json
{"policy":"bag-wallet-envelope/v1","flow":"redeem","chain":"robinhood","txHash":"0x…","receiptStatus":"success",
 "legacy":"ACCEPT","exact":"BOUND","envelope":"SELF_EXECUTE_MODE","agree":true}
```

| Pattern | Meaning | Action |
|---|---|---|
| `agree: true`, `exact: BOUND` | the exact binding accepts what legacy accepted | none |
| `legacy: ACCEPT`, `exact: REFUSED`, `code: UNEXPECTED_CALL / COMPILED_CALL_REPEATED / UNSUPPORTED_ENVELOPE` | a T-1 or F-01 shape was booked by legacy | investigate the transaction; it should not have been booked |
| `legacy: ACCEPT`, `exact: REFUSED`, `code: DELEGATE_NOT_TRUSTED` | a wallet with another EIP-7702 implementation | decide whether to verify and pin that implementation (as in step 1) |
| `code: APPROVAL_NOT_ALLOWED` | the wallet approved more than built, or another spender | usually a user-edited spending cap; decide policy before enforcing |
| `exact: INDETERMINATE`, `code: STATE_UNAVAILABLE` | the RPC could not serve historical state | fix the RPC before enforcing |
| `exact: ERROR` | a stored expectation could not be evaluated | inspect the intent row |

## 5. Exit criteria for enforce (decision required)

- At least one live smart-account purchase, sale and rebalance from MetaMask observed in shadow with `agree: true`.
- No `REFUSED` for a transaction the maintainer confirms legitimate; every disagreement explained in writing.
- Zero `STATE_UNAVAILABLE` over the observation window with the production RPC.
- Replay (step 2) of all historical smart-account intents shows no unexplained refusals.

## 6. Enforce

Set `BAG_WALLET_BATCH_BINDING=enforce`, redeploy. Watch intents that stay `PENDING` (state reads) and new
`VERIFICATION_FAILED` messages with an exact-binding code.

## 7. Rollback

Set the variable to `off` (or remove it) and redeploy: the next verification uses the legacy binding. Nothing is
stored by the exact binding, so there is no data to migrate back. An intent failed by `enforce` stays failed; reopen
it only after reviewing its transaction.

## Known limits of the exact binding

- Only the pinned MetaMask EIP7702StatelessDeleGator (v1.3.0) is accepted as wallet code; other EIP-7702 wallets are
  refused, plain EOAs use direct transactions.
- The wallet must send the transaction itself: ERC-4337 bundles and other relayed transactions are refused (other
  operations in the same bundle could move tokens to the wallet).
- Approvals must be the built (token, spender) pairs and at most the built amount.
- If the wallet sent an earlier transaction in the same block, the block's full transaction list is read; without it
  the result is `STATE_UNAVAILABLE`.
- `try` execution mode, delegate calls, redeemed (non-empty) delegations and non-canonical encodings are refused.
