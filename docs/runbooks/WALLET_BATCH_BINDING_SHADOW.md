# Runbook: transaction binding, from off to shadow to enforce (M2)

**Who runs it:** the maintainer. Every stage change is a production configuration change and needs an explicit
decision. Nothing in this file has been executed. The flag ships **off**.

## What exists

| Binding | When | What it proves |
|---|---|---|
| Default (`off`) | always unless the flag says otherwise | sender = wallet; the built call is sent directly, or carried by the wallet's own batch or by the chain's **pinned** DelegationManager (F-01 fix); receipt success; a purchase's ERC-20 deposit left the wallet (F-01 fix); a sale's sold tokens left it. **Does not** exclude sibling calls in a batch (T-1) or unpinned wallet code. |
| Exact (`shadow` beside, `enforce` deciding) | `BAG_WALLET_BATCH_BINDING=shadow` / `enforce` | additionally: executions are exactly the built call once plus built approvals, canonical encodings, default execution mode, no redeemed delegation, and the wallet's code before the block is a plain EOA (direct calls) or the pinned MetaMask delegate, unchanged in the block. Unreadable state: `PENDING`. |

Decisions use one vocabulary in the app and the SDK: `ACCEPTED`, `REJECTED`, `INSUFFICIENT_EVIDENCE`
(`composerOutcomeDecision`, `purchaseReceiptDecision`, `walletExecutionDecision`).

## Stage A — off (current)

Keep production as it is until all of the following are done and reviewed:

- [ ] The F-01 fix and the M2 code are merged (PR review and CI green).
- [ ] Pins re-verified: `node scripts/audit/verify-smart-account-pins.mjs` shows `trustable: true` for every chain
      the app uses (2026-11-14: Robinhood, Base, Arbitrum, Ethereum).
- [ ] Historical replay (below) run and reviewed.

### Historical replay (read-only; BLOCKED in the 2026-11-14 session: database access was not authorized)

1. Export cases in the Supabase SQL editor (read-only `select`). The output links wallets to transactions: keep it
   outside the repository and delete it after review.

```sql
select json_agg(c) from (
  (select distinct on (p.id) json_build_object(
    'label', 'purchase:' || p.status || ':' || left(p.id::text, 8), 'flow', 'purchase',
    'chain', s->>'sourceChain', 'txHash', s->>'txHash', 'wallet', p.wallet_address,
    'expected', json_build_object('to', p.composer_transaction->>'to', 'data', p.composer_transaction->>'data', 'value', coalesce(p.composer_transaction->>'value', '0')),
    'approvals', coalesce(p.composer_transaction->'approvals', '[]'::jsonb),
    'deposit', case when lower(p.input_asset_address) = '0x0000000000000000000000000000000000000000' then null
      else json_build_object('token', p.input_asset_address, 'amountRaw', (
        select sum((x->>'inputAmountRaw')::numeric)::text from jsonb_array_elements(p.steps) x
        where x->>'action' = 'SWAP' and lower(x->'inputAsset'->>'address') = lower(p.input_asset_address))) end,
    'outputs', (select json_agg(x->'outputAsset'->>'address') from jsonb_array_elements(p.steps) x where x->>'action' = 'SWAP')) as c
  from purchase_intents p cross join lateral jsonb_array_elements(p.steps) s
  where p.composer_transaction is not null and s->>'txHash' is not null order by p.id)
  union all
  (select distinct on (r.id) json_build_object(
    'label', 'redeem:' || r.status || ':' || left(r.id::text, 8), 'flow', 'redeem',
    'chain', s->>'sourceChain', 'txHash', s->>'txHash', 'wallet', r.wallet_address,
    'expected', json_build_object('to', r.composer_transaction->>'to', 'data', r.composer_transaction->>'data', 'value', coalesce(r.composer_transaction->>'value', '0')),
    'approvals', coalesce(r.composer_transaction->'approvals', '[]'::jsonb),
    'sold', (select json_agg(json_build_object('token', x->'inputAsset'->>'address', 'amountRaw', x->>'inputAmountRaw')) from jsonb_array_elements(r.steps) x where x->>'action' = 'SWAP'),
    'outputs', case when lower(r.output_asset_address) = '0x0000000000000000000000000000000000000000' then '[]'::json else json_build_array(r.output_asset_address) end)
  from redeem_intents r cross join lateral jsonb_array_elements(r.steps) s
  where r.composer_transaction is not null and s->>'txHash' is not null order by r.id)
  union all
  (select json_build_object(
    'label', 'rebalance:' || b.status || ':' || left(b.id::text, 8), 'flow', 'rebalance',
    'chain', 'robinhood', 'txHash', b.tx_hash, 'wallet', b.wallet_address,
    'expected', json_build_object('to', b.composer_transaction->>'to', 'data', b.composer_transaction->>'data', 'value', coalesce(b.composer_transaction->>'value', '0')),
    'approvals', coalesce(b.composer_transaction->'approvals', '[]'::jsonb),
    'sold', (select json_agg(json_build_object('token', x->>'address', 'amountRaw', x->>'amountRaw')) from jsonb_array_elements(b.sells) x),
    'outputs', (select json_agg(x->>'address') from jsonb_array_elements(b.buys) x))
  from rebalance_intents b where b.tx_hash is not null)
) cases;
```

2. Replay with the server's RPC (archive state is needed for older blocks; the URL is read from the environment and
   never printed):

```bash
npx tsx --env-file=.env.local scripts/audit/wallet-binding-replay.ts /path/outside/repo/cases.json --out /path/outside/repo/report.json --quiet
```

3. Review per case: `legacyBefore` (default binding before the F-01 fix), `legacyAfter` (now, with the purchase
   deposit check), `exact` (`ACCEPT` / `REFUSE` / `INSUFFICIENT_EVIDENCE` and `exactCode`), `envelope`, `walletCode`
   (`EOA`, `EIP7702_PINNED`, `EIP7702_OTHER:…`, `CONTRACT`, `UNAVAILABLE`), `receiptStatus`, and `evidence`
   (`depositLeft`, `depositRefunded`, `soldInFull`, `soldTokenRefunded`, `outputsArrived`).

| Pattern | Class | Action |
|---|---|---|
| booked intent, `legacyBefore: ACCEPT`, `legacyAfter: REFUSE` | **compatibility** (F-01 fix would refuse a booked transaction) or a forged one | read the transaction; if legitimate, the fix needs widening before it ships |
| booked intent, `exact: REFUSE` with `UNEXPECTED_CALL`, `COMPILED_CALL_REPEATED`, `DELEGATED_EXECUTION` | **security** (T-1 / delegated) or a wallet behavior to understand | investigate before enforce |
| `exact: REFUSE` with `DELEGATE_NOT_TRUSTED` and `walletCode: EIP7702_OTHER` | **compatibility** | decide whether to verify and pin that implementation |
| `exact: REFUSE` with `NON_CANONICAL_ENVELOPE` or `UNSUPPORTED_ENVELOPE` on a booked MetaMask intent | **compatibility** (an encoding the binder does not know) | must be zero before enforce |
| `exact: INSUFFICIENT_EVIDENCE`, `walletCode: UNAVAILABLE` | RPC lacks historical state | use an archive RPC |
| `depositRefunded` or `soldTokenRefunded` true | accounting precision (gross sums) | quantify; feeds M3 (`DELIVERY_LOG`) |

## Stage B — shadow (approval required)

Set `BAG_WALLET_BATCH_BINDING=shadow` for production and redeploy. Properties (tested in
`lib/blockchain/__tests__/wallet-batch-binding.test.ts`):

- The legacy verdict decides; amounts, accounting and intent state are exactly those of `off`.
- One line per smart-account envelope or disagreement, once per transaction and verdict per process (bounded set of
  1,000), agreeing direct calls not logged:

```json
{"policy":"bag-wallet-envelope/v1","flow":"redeem","intentId":"…","chain":"robinhood","txRef":"0x1a2b3c4d",
 "receiptStatus":"success","legacy":"ACCEPT","exact":"BOUND","envelope":"SELF_EXECUTE_MODE","agree":true}
```

- No wallet address, no RPC URL, no full transaction hash (`txRef` is a 10-character prefix; `intentId` links a line
  to its intent for the operator).
- Each smart-account verification adds two historical reads (code and nonce at the previous block).

## Stage C — enforce (approval required)

Enable only when every gate holds over an observation window the maintainer sets (suggested: 14 days or 50
smart-account verifications, whichever is later):

| Gate | Measure |
|---|---|
| Historical replay reviewed | zero unexplained `compatibility` rows for booked intents |
| Legitimate MetaMask transactions pass | ≥ 1 live smart-account purchase, sale and rebalance each with `agree: true`, on each chain the app serves |
| Adversarial cases refused | the F-01 / T-1 / try / delegated / repeated / unpinned-delegate suites green in CI |
| Fail-closed state | zero `INSUFFICIENT_EVIDENCE` from `STATE_UNAVAILABLE` with the production RPC in the window |
| Accounting | no booked-vs-wallet discrepancy introduced in the window (reconciliation report unchanged) |
| Disagreements | every `agree: false` line explained in writing |
| Rollback ready | the rollback below rehearsed in a preview deploy |
| Checks | typecheck, lint, unit, SDK build and smoke, Next build, contract tests green on the release commit |

Then set `BAG_WALLET_BATCH_BINDING=enforce` and redeploy; watch intents that stay `PENDING` and new
`VERIFICATION_FAILED` messages naming an exact-binding code.

## Rollback

Set the variable to `off` (or remove it) and redeploy: the next verification uses the default binding, which keeps
the F-01 fix. The exact binding stores nothing, so there is no data to migrate back. An intent refused under
`enforce` stays failed; reopen it only after reviewing its transaction.

## Known limits of the exact binding

- Only the pinned MetaMask EIP7702StatelessDeleGator (v1.3.0) is accepted as wallet code; other EIP-7702 wallets are
  refused, plain EOAs use direct transactions.
- The wallet must send the transaction itself: ERC-4337 bundles and other relayed transactions are refused (other
  operations in the same bundle could move tokens to the wallet).
- Approvals must be the built (token, spender) pairs and at most the built amount.
- If the wallet sent an earlier transaction in the same block, the block's full transaction list is read; without it
  the result is `INSUFFICIENT_EVIDENCE`.
- `try` execution mode, delegate calls, redeemed (non-empty) delegations and non-canonical encodings are refused.
- MetaMask's self-authorized DelegationManager path has not been observed on chain yet (only the canonical encoding
  required by the verified contract is accepted); shadow mode must show it binding before enforce.
