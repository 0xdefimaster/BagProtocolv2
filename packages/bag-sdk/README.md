# @bagprotocol/sdk — bag.json v1

A BAG strategy as a portable object. This package reads, checks, canonicalizes
and hashes a **bag.json v1** document, and verifies it against StrategyRegistry.
It needs no BAG frontend, server or database.

- Required peer dependency: `viem` (`^2.0.0`). Optional peer dependency:
  `@lifi/composer-sdk` (`>=0.11.0 <0.12.0`) for the LI.FI adapter. No framework,
  database, environment variable, endpoint or key is required. A boundary test
  (`test/boundary.test.ts`) enforces the core boundary.
- **Strategy core ≠ transport.** The core (`@bagprotocol/sdk`) is
  parse → validate → normalize → hash → verify and never fetches anything.
  Getting the bytes is an adapter's job:
  - `@bagprotocol/sdk/http`: `fetchBag(url, { fetch })`.
  - `@bagprotocol/sdk/evm`: `readTokenDecimals(definition, clientFor)`.
  - `@bagprotocol/sdk/lifi`: `lifiComposer({ apiKey, baseUrl })`, a routing provider for quote/compile (optional peer `@lifi/composer-sdk` `>=0.11.0 <0.12.0`, tested with 0.11.3: `COMPOSER_SDK_COMPAT`).
  - Other sources (a local file, IPFS, wallet storage, a registry `uri`) end in the same `parseBag(text)`.
- Network access only through what you pass in (a `fetch`, a viem client).
- Published on npm: [`@bagprotocol/sdk@0.2.0`](https://www.npmjs.com/package/@bagprotocol/sdk). The package is MIT-licensed; `bag.json` v1 semantics are frozen.

## JSON Schema

The package exports the portable v1 document schema at `@bagprotocol/sdk/schema`
(the JSON file is `schema/bag.v1.schema.json`). Use it for editor completion
and shape validation; then call `parseBag` and `validateBag` for the SDK's
strict parsing and cross-field rules. The schema accepts both minimal
`{ bagJson, definition }` files and BAG-enriched served documents.

## Quick start

Install the SDK and its required peer dependency in your app:

```bash
npm install @bagprotocol/sdk viem
```

Create a `bag.json` file. This is a **validation-only example**: the two addresses are placeholders, not recommended or executable assets.

```json
{
  "bagJson": 1,
  "definition": {
    "kind": "STATIC_BASKET",
    "chain": "ethereum",
    "mutability": "MUTABLE",
    "assets": [
      {
        "chain": "ethereum",
        "address": "0x0000000000000000000000000000000000000001",
        "decimals": 18,
        "weightBps": 5000
      },
      {
        "chain": "ethereum",
        "address": "0x0000000000000000000000000000000000000002",
        "decimals": 18,
        "weightBps": 5000
      }
    ],
    "rules": {
      "weightBounds": {
        "minBps": 100,
        "maxBps": 7000
      },
      "maxAssets": 10,
      "minInvestment": {
        "amount": "0",
        "measuredAs": "PAYMENT_TOKEN_AMOUNT"
      },
      "swapSlippageBps": 100,
      "rebalance": {
        "frequency": "MANUAL",
        "driftThresholdBps": 500
      },
      "performanceFeeBps": 0,
      "noRouteAssetPolicy": "BLOCK"
    }
  }
}
```

Create `index.mjs` next to `bag.json`:

```js
import { readFile } from 'node:fs/promises';
import {
  parseBag,
  validateBag,
  normalizeBag,
  hashBag
} from '@bagprotocol/sdk';

const text = await readFile('./bag.json', 'utf8');
const parsed = parseBag(text);

if (!parsed.ok) {
  console.error('Invalid bag.json syntax or shape:', parsed.issues);
  process.exit(1);
}

const validation = validateBag(parsed.bag);

if (!validation.valid) {
  console.error('Invalid strategy definition:', validation.errors);
  process.exit(1);
}

const canonical = normalizeBag(parsed.bag);
const definitionHash = hashBag(canonical);

console.log('bag.json: valid');
console.log('definitionHash:', definitionHash);
console.log('warnings:', validation.warnings.map(({ code, path }) => ({ code, path })));
```

Run it:

```bash
node index.mjs
```

The `DECIMALS_NOT_CHECKED` warning is expected in this minimal example because no on-chain token metadata was supplied. Before using a strategy for execution, replace the placeholder addresses and verify the assets and decimals against the target chain. Successful parsing, validation and hashing do **not** prove that assets have liquidity or that a trade can execute safely.

## API overview

```ts
import { parseBag, validateBag, normalizeBag, hashBag, resolveV1Rules, verifyRegistryCommitment } from '@bagprotocol/sdk';
import { fetchBag } from '@bagprotocol/sdk/http';   // optional transport adapter

const parsed = parseBag(fileText);            // or: await fetchBag(url)
if (!parsed.ok) throw new Error(parsed.issues.map((i) => `${i.code} ${i.path}`).join('\n'));
const check = validateBag(parsed.bag, { tokens });  // tokens: optional { chain, address, decimals }[] (see readTokenDecimals)
const canonical = normalizeBag(parsed.bag);
const definitionHash = hashBag(canonical);    // == check.definitionHash
const rules = resolveV1Rules(parsed.bag.definition);  // what the strategy means, every null resolved

// Optional: is this exactly what <creator> committed on-chain?
const v = await verifyRegistryCommitment({ bag: parsed.bag, expectedCreator, registry, client });
```

Pipeline steps:
- `parseBag`: shape and types only.
- `validateBag`: rules.
- `normalizeBag`: canonical copy.
- `hashBag`: `definitionHash`.

Quoting, simulating and compiling a purchase are a separate layer on top of the artifact (see "Execution" below).

## Document

```jsonc
{
  "bagJson": 1,            // required
  "definition": { … },     // required — the only hashed part
  "metadata": { … },       // optional, display only
  // Added by BAG when it serves a stored version; optional, never hashed, never authority:
  "definitionHash": "0x…", "ref": { … }, "network": { … }, "commitments": { … }, "forkedFrom": { … }
}
```

A file with only `bagJson` and `definition` is a complete bag.json. It can be
parsed, validated and hashed with no record anywhere. A registry check also
needs `ref` (strategyId and version).

### Definition (hashed)

All keys are required. `null` means "not set by the creator". It is never
replaced by a default. A missing key is an error, not `null`.

| Field | Type |
|---|---|
| `kind` | `"STATIC_BASKET"` \| null |
| `chain` | v1 chain slug (below) |
| `mutability` | `"MUTABLE"` \| `"IMMUTABLE"` \| null |
| `assets[]` | `{ chain, address, decimals, weightBps }`: identity is `chain + address` |
| `rules.weightBounds` | `{ minBps, maxBps }`, each integer \| null |
| `rules.maxAssets` | integer \| null |
| `assets[].weightBps` | integer 1–10000; the weights sum to **exactly** 10000 |
| `rules.minInvestment` | `{ amount: canonical decimal string, measuredAs: "PAYMENT_TOKEN_AMOUNT" }` \| null |
| `rules.swapSlippageBps` | integer 1–10000 \| null (0 is recorded as null) |
| `rules.rebalance` | `{ frequency: MANUAL\|DAILY\|WEEKLY\|MONTHLY\|THRESHOLD_ONLY \| null, driftThresholdBps }` \| null |
| `rules.performanceFeeBps` | integer 0–3000 \| null; `0` (no fee) and `null` (not set) hash differently |
| `rules.noRouteAssetPolicy` | `BLOCK` \| `HOLD_INPUT` \| `REFUND` \| null |

Not hashed:
- Display (`metadata`, asset symbols).
- Identity and lineage (`ref`, `forkedFrom`).
- `network`, `commitments`.
- The creator.

## Hash

```
definitionHash = keccak256(utf8("bag.json/v1\n" + JCS(normalize(definition))))
```

- JCS is RFC 8785: keys sorted by UTF-16 code unit, no whitespace, numbers by value.
- `normalize`:
  - EVM addresses are trimmed and lowercased;
  - assets are sorted by `chain`, then `address`, by code unit (never `localeCompare`);
  - exactly the definition's keys are kept, nothing is added.
- Golden vectors: `docs/schemas/bag-json.v1.vectors.json`. They are computed independently (Python JCS + js-sha3) and checked by the tests.

Consequences:
- Asset order, address case and key order do not change the hash.
- Any committed value does change it.
- A fork that changes nothing has the same `definitionHash`. Content identity is not strategy identity.

## Chain and token identity

| Slug | EIP-155 chain id |
|---|---|
| `ethereum` | 1 |
| `base` | 8453 |
| `arbitrum` | 42161 |
| `robinhood` | 4663 |

- The table is closed and defined once (`BAG_V1_CHAINS`). The hash covers the slug, so every reader maps it with this table.
- Adding a chain changes what v1 accepts. It comes only with a controlled spec version.
- A v1 strategy is single-chain: every `assets[].chain` must equal `definition.chain`.
- A token is `chain + address`. The address is 20-byte hex, compared lowercase; the EIP-55 checksum is display only.
- `0x0000000000000000000000000000000000000000` is the native asset.
- `decimals` is hashed. `validateBag` compares it with the token when you pass `tokens`, for example from `readTokenDecimals(definition, clientFor)`. Without `tokens` it warns `DECIMALS_NOT_CHECKED`; it never claims a check it did not do.

## Strict parsing

`parseBag` rejects each of these instead of guessing:

| Input | Code |
|---|---|
| Unknown key | `UNKNOWN_FIELD` |
| Missing key | `MISSING_FIELD` |
| Wrong type | `WRONG_TYPE` |
| A fraction or exponent where an integer is required (`1.0`, `1e0`, `1.5`) | `NOT_AN_INTEGER` |
| A duplicate JSON key | `DUPLICATE_KEY` |
| A non-canonical decimal (`"10.0"`, `"010"`) | `NON_CANONICAL_DECIMAL` |
| A chain outside the table | `UNSUPPORTED_CHAIN` |

Notes:
- `JSON.parse` silently keeps the last duplicate key. That is why duplicate keys are refused.
- Pass the file's **text** to `parseBag`: `1.0` and duplicate keys are only visible there.
- All problems are returned at once.

## Validation

`validateBag` applies BAG's version-creation rules. It is pure and deterministic, with findings in a fixed order.

Definition rules:

| Code | Rule |
|---|---|
| `NO_ASSETS` | At least one asset |
| `TOO_MANY_ASSETS` | At most `maxAssets` and at most 100 |
| `ASSET_CHAIN_MISMATCH` | Asset on another chain |
| `DUPLICATE_ASSET` | Same chain + address, any case |
| `INVALID_DECIMALS` | Decimals 0–18 |
| `DECIMALS_MISMATCH` | Against supplied tokens |
| `INVALID_WEIGHT` | Weight 1–10000 |
| `WEIGHTS_NOT_100` | Weights sum to exactly 10000 |
| `BELOW_MIN_WEIGHT`, `ABOVE_MAX_WEIGHT`, `INVALID_WEIGHT_BOUNDS` | Weight bounds |
| `INVALID_PERFORMANCE_FEE` | Fee cap 3000 |
| `INVALID_SLIPPAGE` | Slippage range |
| `INVALID_DRIFT_THRESHOLD` | Drift range |

Document rules:

| Code | Rule |
|---|---|
| `DEFINITION_HASH_MISMATCH` | A stated `definitionHash` must equal the recomputed one |
| `NETWORK_MISMATCH` | `network.chainId` must match the chain table |
| `INVALID_PARENT_VERSION` | `ref.parentVersion` must be `version − 1` (null for version 1) |
| `SELF_FORK` | A fork must be another strategy |
| `METADATA_ASSET_UNKNOWN` | `metadata.assets` may only name definition assets |

Not checked here: BAG's asset allowlist, routes, prices, price impact and deposit size. They depend on the market or a deployment.

## Weights: exactly 10000, no remainder (normative)

The weights of a v1 definition sum to **exactly 10000 bps**. There is no tolerance:
- `9998` would leave 2 bps of every deposit unallocated;
- `10002` would allocate more than was deposited.

A definition that does not sum to 10000 is invalid (`WEIGHTS_NOT_100`) and must not be executed.

**Target allocation (normative, exact).** The amount each asset should receive:
1. For each asset, `floor(amount × weightBps / 10000)` in the input token's smallest unit.
2. The units lost to flooring (always fewer than the number of assets) go one unit each to the assets with the largest remainder.
3. Ties are broken by `chain:address` ascending.

The parts always sum to the deposit, with nothing left over and nothing created. The SDK implements this as `splitByWeight`; a test in the app checks it gives exactly the same result as BAG's `distributeExactByWeight`. Every implementation must compute the same target.

**Execution (normative bound).** An executor must:
- spend the **whole** deposit, with no unallocated remainder and nothing created;
- give each asset its target amount, within **2 bps of the deposit**.

An executor that splits off-chain into fixed per-asset amounts (BAG's sequential path) hits the target exactly. An executor that splits on-chain by basis-point ratios cannot. This is the case for LI.FI Composer: `core.partition` divides one input into 2–16 shares by whole-bp ratios (each share rounded down, the last one takes the remainder). BAG and the SDK build it the same way, with one implementation (`partition.ts`):

1. **Leg weights:** the exact target amounts become whole-bp weights by largest remainder, in bigint (`largestRemainderBps`): `floor(10000 × amount_i / total)`, the bps lost to flooring one each to the largest remainders, ties by token address ascending. They sum to exactly 10000.
2. **Partition:** one node for 2–16 legs. Above 16, an outer node over at most 16 groups (sizes as even as possible) and one node per group, its members' weights rescaled to 10000 by the same rule (`planPartition`).
3. **Legs** are in canonical order (token address ascending, `planPartitionLegs`), so the same targets always build the same nodes.

Each leg then lands within 1 bp of the swapped amount of its target (below 2 bps with the second level above 16 legs), plus a few raw units of flooring. The bound is pinned by tests (`bag-sdk-consistency.test.ts`, `split-weight-adversarial.test.ts`). On a 10 USDG purchase, 2 bps is at most 0.2 cents per asset. A leg whose share would round below 1 bp cannot be expressed: the SDK refuses the plan (`AMOUNT_TOO_SMALL`); BAG buys that purchase per asset instead.

Before v1 was frozen, BAG accepted 9998–10002 at version creation but its purchase path already refused anything but exactly 10000. Both now require exactly 10000. The create UI always sent whole percents summing to 100.

## `null` and its default (normative)

A `null` rule means "not set by the creator". The default is **never written** into the document, so it is not in the hash. But every reader must give `null` the same meaning, otherwise one `definitionHash` would mean two strategies. So the resolution is part of the standard: `resolveV1Rules` applies this table.

| Field | `null` resolves to |
|---|---|
| `kind` | `STATIC_BASKET` |
| `mutability` | `MUTABLE` |
| `rules.weightBounds.minBps` | 100 |
| `rules.weightBounds.maxBps` | 7000 |
| `rules.maxAssets` | max(asset count, 10), at most 100 |
| `rules.minInvestment` | `"0"` (no minimum) |
| `rules.swapSlippageBps` | 100 |
| `rules.rebalance.frequency` (or `rebalance: null`) | `THRESHOLD_ONLY` |
| `rules.rebalance.driftThresholdBps` (or `rebalance: null`) | 500 |
| `rules.performanceFeeBps` | 0 (no fee) |
| `rules.noRouteAssetPolicy` | `BLOCK` |

- Each resolved value is labelled `DECLARED` or `V1_DEFAULT`.
- A declared `0` (for example `performanceFeeBps: 0`) is a value, not "unset".
- **v1 default resolution semantics are normative and frozen.** Changing any value in this table is `bag.json/v2`. These values equal BAG's own defaults, and a test in the app (`bag-sdk-consistency.test.ts`) fails if they ever diverge.

The definition states what the creator allows. An executor may enforce a rule **more strictly, never more loosely**. For example, BAG caps the per-swap slippage it applies at 300 bps even if a definition declares more.

## Version, fork and registry

- **Versions:** `1, 2, 3…` inside one strategy, with no gaps. The parent of version N is N−1.
- **Forks:** a fork is a **new** strategy with its own version 1. It records once the exact `(parent strategy, parent version)`.
- **Registry identity:** `registryStrategyId = keccak256(abi.encode(creator, uuidAsBytes32))`. This equals `StrategyRegistry.deriveStrategyId` and `BagFactory.deriveBagId`.

**`creator` is a verification input, not an attested field from the JSON.** The
creator is not in `definitionHash`. `verifyRegistryCommitment` takes the creator
*you expect* and does the following:

1. Derive the strategy id from it.
2. Read the registry.
3. Require that the entry was registered by that creator.
4. Require that `definitionHashOf(id, ref.version)` equals the hash recomputed from `definition`.

Before reading the record, the SDK also requires the caller's RPC chain to match `definition.chain`, checks the supplied address against BAG's known deployment when one is recorded, and requires non-empty contract code. A wrong chain/address or empty-code address fails closed without reading registry records. The caller still supplies its own read-only client; the SDK has no RPC credentials.

`commitments.registry` in a served bag.json, including its `creator`, and the
stated `definitionHash` are never used as authority. If you copy the creator
from the JSON, you only verify what the JSON claims.

**Deployments** (`STRATEGY_REGISTRY_DEPLOYMENTS`):

| Chain | Chain id | StrategyRegistry | Deployed at block |
|---|---|---|---|
| robinhood | 4663 | `0x907cc27d644c8ea1c24b8320ad09ecf2819209a8` | 85332074 |

No other chain has a registry; there, verification needs an address you trust.

**Live check, read-only** (`examples/verify-registry.ts`): it checks that the RPC is on the registry's chain, that the
registry has contract code, and that the registry holds the recomputed `definitionHash` for your expected creator. It
uses a public client only and sends nothing. For the `feetest` v1 commitment:

```
RPC_URL=… npx tsx packages/bag-sdk/examples/verify-registry.ts \
  <BAG app origin>/api/strategies/170e5e72-d5d5-4f16-b180-24b3dc525b37/versions/1 \
  0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46
```

The bag.json can also be a local file: `packages/bag-sdk/test/fixtures/feetest.v1.bag.json` is that document as served.

Each check prints `PASS` or `FAIL`, then `VERDICT PASS|FAIL|BLOCKED`. Exit code 0 PASS, 1 FAIL, 3 BLOCKED (the RPC or
the URL could not be reached; nothing was checked). The RPC URL is never printed.

## Execution: quote, simulate, compile

```ts
import { compileBag, simulateBag } from '@bagprotocol/sdk';
import { lifiComposer } from '@bagprotocol/sdk/lifi';

const provider = lifiComposer({ apiKey: process.env.LIFI_API_KEY!, baseUrl: 'https://composer.li.quest' });  // your own key
const trust = {
  chainId: 4663,
  allowedTransactionTargets: ['0x…'], // contracts you have verified for this chain
  allowedApprovalSpenders: ['0x…'],   // contracts you have verified for this chain
};
const compiled = await compileBag(bag, { inputToken, amountRaw, inputTokenDecimals, signer }, { provider, trust });
const check = await simulateBag(compiled, { client });   // your viem client: OK | NEEDS_APPROVAL | INSUFFICIENT_BALANCE | REVERTED
// your wallet sends compiled.approvals, then signs and sends compiled.transaction
```

**Native ETH or an ERC-20.** `inputToken` is either an ERC-20 address or `NATIVE_TOKEN`
(`0x0000000000000000000000000000000000000000`, the chain's ETH). The plan says which: `plan.inputKind` is
`'native'` or `'erc20'`. If `minInvestment` is positive, pass the payment token's `inputTokenDecimals` for an ERC-20; native ETH uses 18 decimals automatically. The minimum is compared exactly against `amountRaw` without floating-point arithmetic.

| | ERC-20 (e.g. USDG) | Native ETH |
|---|---|---|
| Paid as | the approved token amount | the transaction's `value` |
| `compiled.transaction.value` | must be `0` | must equal `amountRaw` exactly |
| `compiled.approvals` | the spender's allowance, if needed | must be empty |
| Kept (unswapped) share | the asset that is the input token | none: ETH is never a basket asset (`NATIVE_INPUT_KEPT`) |
| `simulateBag` balance | `balanceOf(signer)` | `getBalance(signer)` (the network fee comes on top) |

A provider answer that breaks any row is refused with `ProviderResponseError`.

| Function | What it does |
|---|---|
| `planPurchase` | Pure plan: enforces `minInvestment` in payment-token units, then computes exact target allocation (`splitByWeight`), keeps any matching input asset, builds whole-bp legs and the `core.partition`, and applies slippage and price-impact limits |
| `quoteBag` / `compileBag` | Ask the provider for the route and return the quote, or the quote plus the **unsigned** transaction and the approvals it needs |
| `simulateBag` | Dry run with `eth_call` from the signer on your client: input balance, then approvals, then the call. A point-in-time check, not a guarantee |

**Never signs, never sends.**
- The SDK holds no key. It has no signing or sending call (a boundary test checks this).
- It builds the transaction; your wallet signs it.
- The assets are swept straight to the signer.

**Limits a caller can only tighten:**
- **Slippage:** the definition's slippage (or its v1 default), capped at **300 bps**. The cap is the same as BAG's.
- **Price impact:** at most **500 bps** for the whole purchase.

A looser value is refused (`LOOSER_THAN_POLICY`). An optional `allowedTokens` restricts the assets to your own allowlist.

**Validation happens on both sides of the provider call:**

- **Before calling the provider:** the SDK validates the strategy and purchase inputs, builds the plan, checks its slippage and price-impact policy, and requires a caller trust policy whose chain matches the plan. The target/spender allowlist contents are also checked for valid addresses.
- **After the provider responds:** the SDK checks the returned transaction's chain and target, native value, approval token/spender/amount, planned output tokens on every leg, and reported price impact. A target or spender that is not allowlisted is rejected here, before the unsigned transaction is returned to the caller.

Anything else throws `ProviderResponseError`.

The caller must provide a chain-scoped `ExecutionTrustPolicy`. A mismatched policy chain or malformed/empty target allowlist is rejected before the provider call. The SDK cannot know the provider's compiled target or approval spender until the provider responds, so disallowed returned targets/spenders are rejected after that call and before any unsigned transaction is returned. The SDK does not decode arbitrary transaction calldata to prove its full economic behavior; use a provider and endpoint you trust, simulate the compiled call, and let the wallet show the transaction before signing.

No partial purchases: if any asset cannot be routed, the compile fails and nothing is built. This is the strictest no-route behaviour (`BLOCK`).

**Accounting boundary (normative).** A strategy definition is portable and permissionless to execute. BAG fees apply only to executions explicitly originated and accounted for by BAG.

| Path | What it is | BAG ledger / fee |
|---|---|---|
| SDK → your script, wallet or another app → your wallet | An execution of the strategy into your own wallet | No |
| BAG app → BAG purchase intent → BAG ledger | A BAG position: cost basis, P&L, redemption, creator fee | Yes |

Every plan carries `accounting: "NOT_BAG_ACCOUNTED"`. BAG never infers a position or a fee from tokens in a wallet. Adopting externally bought assets into a BAG position is out of scope: it would need cost basis, provenance and fee-eligibility rules first.

**End to end, no BAG app:** `examples/compile-purchase.ts` takes a bag.json (file or URL) through parse → validate → normalize → hash → verify → quote → simulate → compile and prints the unsigned transaction. Run it with your own key and RPC:

```
LIFI_API_KEY=… RPC_URL=… COMPOSER_TRUSTED_TARGETS=0x… COMPOSER_TRUSTED_SPENDERS=0x… npx tsx packages/bag-sdk/examples/compile-purchase.ts <bag.json|URL> <inputToken> <amountRaw> <signer>
```

The target and spender values must be independently verified for the strategy's chain. If the transaction needs an approval and no trusted spender is configured, compilation fails closed.

The test suite runs the same script with the real `@lifi/composer-sdk` and the network mocked. That proves the
pipeline, **not** the live API.

**Live compile test** (`examples/live-compile.ts`): the same script against the real LI.FI Composer API and a real
RPC, quote and compile only. It asserts the unsigned result (chain id, trusted target, calldata, `value` = amount for
ETH and 0 for an ERC-20, no approval for ETH, trusted spenders, every leg's minimum output ≤ its expected output) and
prints `VERDICT PASS|FAIL|BLOCKED`. It never signs or sends, and never prints the key or the RPC URL.

```
LIFI_API_KEY=… RPC_URL=… COMPOSER_TRUSTED_TARGETS=0x… npx tsx packages/bag-sdk/examples/live-compile.ts \
  <bag.json|URL> 0x0000000000000000000000000000000000000000 1000000000000000 <your address>
```

`COMPOSER_TRUSTED_TARGETS` is **your wallet's own LI.FI Composer proxy**, not one shared contract: Composer sends each
signer's transaction to that signer's proxy, so the target differs per wallet (seen live: two wallets, two targets).
Before a wallet's first Composer transaction the target is a Composer entry contract instead. Verify the address
yourself, for example as the `to` of a Composer purchase this wallet already made, on the block explorer. Run with a
placeholder such as `0x0000000000000000000000000000000000000001` and the refusal names the target Composer returned;
trust it only after that check. Exit code 0 PASS, 1 FAIL, 3 BLOCKED (credentials not set, or the network unreachable).

How LI.FI derives the proxy address is not documented, so the SDK cannot yet check it on its own.
`scripts/spike/composer-proxy-probe.ts` (read-only) collects the on-chain facts such a check would need.

**Verified live (2026-10-10, Robinhood Chain):** `verify-registry.ts` on the served `feetest` v1 document: 7/7 PASS.
`live-compile.ts`, 0.001 ETH into `feetest` for a wallet with its proxy as the trusted target: 8/8 PASS, simulation OK.
Nothing was signed or sent.

## Package

```
cd packages/bag-sdk
npm run typecheck   # tsc, no output
npm run build       # dist/: ES2022 ESM .js + .d.ts for ".", "./http", "./evm", "./lifi"
npm pack --dry-run  # what a tarball would contain: dist/, README.md, package.json
npm run smoke:consumer  # packs, installs the tarball in a fresh temp project, imports every entry point, typechecks a TS consumer
```

No build dependency beyond TypeScript. The package is configured for public npm distribution under the MIT license; it has not yet been published to npm.

## v1 freeze

bag.json v1 semantics are frozen. Changing any of the following requires
**bag.json/v2**, with a new hash domain:
- a hash-relevant field;
- a normalization rule;
- the sorting rule;
- the numeric rule;
- the chain table;
- the validation rules, the weight-sum rule, the target allocation or the execution bound;
- the `null` default table;
- the interpretation of a field.

This holds even when the bytes would not change: a change of meaning is a new version.
