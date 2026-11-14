# F-01 historical replay: export the maintainer runs, nothing else needs database access

Purpose: before (or right after) the F-01 patch ships, check that no transaction BAG already booked would be refused by
the new default binding, and that no booked transaction looks forged. The assistant has **no** database access and
must not get any; the maintainer runs both steps and shares only the counts (step 3).

## 1. Export (maintainer, Supabase SQL editor, read-only `select`)

Pseudonymous: no user id, no intent id, no wallet address. The wallet is exported only as `sha256(lowercase
address)`; the replay compares it with the mined sender's hash. Transaction hashes and the built calldata are already
public on chain, so the file can still be linked to wallets through an explorer: keep it outside the repository, do
not upload or paste it anywhere, delete it after the review.

```sql
select json_agg(c) from (
  (select distinct on (p.id) json_build_object(
    'label', 'purchase:' || p.status || ':' || row_number() over (order by p.created_at), 'flow', 'purchase',
    'chain', s->>'sourceChain', 'txHash', s->>'txHash',
    'walletSha256', encode(sha256(convert_to(lower(p.wallet_address), 'UTF8')), 'hex'),
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
    'label', 'redeem:' || r.status || ':' || row_number() over (order by r.created_at), 'flow', 'redeem',
    'chain', s->>'sourceChain', 'txHash', s->>'txHash',
    'walletSha256', encode(sha256(convert_to(lower(r.wallet_address), 'UTF8')), 'hex'),
    'expected', json_build_object('to', r.composer_transaction->>'to', 'data', r.composer_transaction->>'data', 'value', coalesce(r.composer_transaction->>'value', '0')),
    'approvals', coalesce(r.composer_transaction->'approvals', '[]'::jsonb),
    'sold', (select json_agg(json_build_object('token', x->'inputAsset'->>'address', 'amountRaw', x->>'inputAmountRaw')) from jsonb_array_elements(r.steps) x where x->>'action' = 'SWAP'),
    'outputs', case when lower(r.output_asset_address) = '0x0000000000000000000000000000000000000000' then '[]'::json else json_build_array(r.output_asset_address) end)
  from redeem_intents r cross join lateral jsonb_array_elements(r.steps) s
  where r.composer_transaction is not null and s->>'txHash' is not null order by r.id)
) cases;
```

Save the single JSON value as e.g. `C:\bag-replay\cases.json` (outside the repository).

If the editor's role can write, the query still only reads. A stricter option is a dedicated read-only database role
with `select` on `purchase_intents` and `redeem_intents` only; creating it is a separate owner decision.

## 2. Replay (maintainer's machine; never signs or sends)

From a checkout of the audit branch that contains `scripts/audit/wallet-binding-replay.ts` (walletSha256 support):

```powershell
npx tsx --env-file=.env.local scripts/audit/wallet-binding-replay.ts C:\bag-replay\cases.json --out C:\bag-replay\report.json --quiet
```

RPC URLs come from `<CHAIN>_RPC_URL` (archive state helps for older blocks) and are never printed. `--quiet` prints one
line of counts.

## 3. What to share

Only the `--quiet` line, for example
`{"replayed":N,"legacyBefore":{...},"legacyAfter":{...},"exact":{...},"walletCode":{...},"acceptedBeforeRefusedAfterF01":K}`.
Not the export, not the report.

## 4. Decision

| Result | Meaning | Action |
|---|---|---|
| `acceptedBeforeRefusedAfterF01 = 0` | F-01 refuses nothing BAG booked | merge stands |
| `K > 0` | a booked transaction the fix would refuse | maintainer opens those rows in `report.json` (`envelope`, `walletCode`, `evidence.depositLeft`): a legitimate one (e.g. a DelegationManager on an unpinned chain) widens the fix before release; a forged one is an F-01 exploitation to investigate (positions and fees of that wallet) |
| many `ERROR` / `INSUFFICIENT_EVIDENCE` | RPC could not serve historical state | rerun with an archive RPC |

Verified locally on 2026-11-14 against a public Base transaction: matching hash → `ACCEPT`, other hash → `REFUSE
NOT_FROM_WALLET`.
