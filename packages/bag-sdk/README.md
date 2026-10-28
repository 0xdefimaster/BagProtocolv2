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
- Public npm `latest` observed on 2026-10-22: [`@bagprotocol/sdk@0.2.1`](https://www.npmjs.com/package/@bagprotocol/sdk/v/0.2.1). Source release candidate: **0.3.0, not published**. The candidate includes later main-branch and SDK preparation work. The package is MIT-licensed; `bag.json` v1 semantics are frozen.

## JSON Schema

The package exports the SDK's EVM profile schema at `@bagprotocol/sdk/schema`
(the JSON file is `schema/bag.v1.schema.json`). Its chain enum deliberately
matches `BAG_V1_CHAINS`; BAG's wider API schema may include chains this SDK does
not implement. Use the package schema for editor completion and shape
validation, then call `parseBag` and `validateBag` for strict parsing and
cross-field rules. It accepts minimal `{ bagJson, definition }` files and
BAG-enriched served documents on supported EVM chains.

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
const check = await simulateBag(compiled, { client });   // OK | QUOTE_EXPIRED | NEEDS_APPROVAL | INSUFFICIENT_BALANCE | REVERTED
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
| `simulateBag` | Dry run with `eth_call` from the signer on your client: full input budget balance (swapped + kept), then approvals for the swapped portion, then the call. A point-in-time check, not a guarantee |

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
- **After the provider responds:** the SDK checks the returned transaction's chain and target, native value, approval token/spender/amount, planned output tokens and slippage bounds on every leg, and reported price impact. A target or spender that is not allowlisted is rejected here, before the unsigned transaction is returned to the caller.

#### Negative (favorable) price impact: LI.FI Composer only

Composer reports `priceImpact` as USD values of the priced input and outputs plus a signed `impactBps`. When the priced outputs are worth more than the priced input, `impactBps` is negative. This can happen with a stale reference price, an input token valued slightly off its peg, or a stock-token pool trading outside market hours. The SDK keeps the raw value and never clamps it. The quote exposes `priceImpactBps` (possibly negative) and `priceImpactUsd`.

A negative value is accepted only from a provider created by `lifiComposer`, and only when all of these hold:
- `inputValueUsd` is finite and positive;
- `outputValueUsd` is finite and above the input value;
- `impactBps` is a safe integer;
- no asset is listed as unpriced;
- `impactBps` lies within ±1 bps of `(inputValueUsd − outputValueUsd) / inputValueUsd × 10 000`.

Otherwise the quote fails with `PRICE_IMPACT_INVALID`.

The ±1 bps tolerance is a compatibility tolerance from observed API behavior. Composer 0.11.3 returned `-6` where that ratio is `-6.33`. It is **not** LI.FI's documented formula, and it is **not** an independent price check: the comparison uses the provider's own USD values. Other providers, including custom ones, keep the non-negative rule. The `maxPriceImpactBps` limit now applies in both directions: a negative value below `−maxPriceImpactBps` fails with `PRICE_IMPACT_EXCEEDED`, because a favorable gap that large more likely means a wrong reference price than a real gain. The per-leg minimum outputs, the slippage bound and all transaction checks apply unchanged. LI.FI has confirmed (2026-10-24) that the impact is the difference between total input and output value and that negative values are valid; the exact rounding was not specified.

Every swapped leg must report positive `expectedOutRaw` and `minOutRaw` in the same output-token units. The minimum must be no greater than the estimate and at least `floor(expectedOutRaw * (10000 - slippageBps) / 10000)`. Integer arithmetic permits less than one raw unit of rounding; a missing/zero estimate or an excessive gap is refused. This is a consistency check on the provider's reported quote, not proof of its calldata. Composer may report a simulated estimate and an operation-based minimum: an improved simulation can make that minimum fall outside this SDK bound, in which case compilation is conservatively refused rather than widening the caller's tolerance.

Anything else throws `ProviderResponseError`.

The caller must provide a chain-scoped `ExecutionTrustPolicy`. A mismatched policy chain or malformed/empty target allowlist is rejected before the provider call. The SDK cannot know the provider's compiled target or approval spender until the provider responds, so disallowed returned targets/spenders are rejected after that call and before any unsigned transaction is returned. The SDK does not decode arbitrary transaction calldata to prove its full economic behavior; use a provider and endpoint you trust, simulate the compiled call, and let the wallet show the transaction before signing.

### Choosing how the wallet pays

`selectExecutionPath` is a pure rule table: you supply what you know about the payment, the wallet, the executor and any relayer, and it returns the path with the fewest wallet prompts, every eligible path in fallback order, and for each other path the reasons it does not apply. The SDK reads nothing itself, and an omitted optional fact counts as false.

```ts
import { hasAtomicBatchCapability, selectExecutionPath } from '@bagprotocol/sdk';

const caps = await provider.request({ method: 'wallet_getCapabilities', params: [signer, [chainIdHex]] }).catch(() => null);
const selection = selectExecutionPath({
  payment: compiled.plan.inputKind,          // 'native' | 'erc20'
  approvalsNeeded: shortApprovals.length,    // compiled approvals your allowance read says are still short
  wallet: { atomicBatch: hasAtomicBatchCapability(caps, chainId), typedDataSigning: true },
});
// selection.path, selection.walletPrompts, selection.ranked (fallback order), selection.candidates[i].blockedBy
```

| Path | When | Wallet prompts | Payer transactions |
|---|---|---|---|
| `NATIVE` | Paid with ETH as the transaction value | 1 | 1 |
| `DIRECT` | ERC-20, every allowance already suffices | 1 | 1 |
| `ATOMIC_BATCH` | ERC-20, wallet reports atomic EIP-5792 batching: exact approvals and the purchase in one batch | 1 | 1 |
| `PERMIT2_RELAYED` | Executor accepts a Permit2 witness, wallet signs typed data, relayer available | 1 (+1 first use) | 0 (+1 first use) |
| `PERMIT2_SELF` | As above, submitted by the payer | 2 (+1 first use) | 1 (+1 first use) |
| `SEQUENTIAL` | ERC-20, one prompt per short approval, then the purchase | approvals + 1 | approvals + 1 |

Ties on prompts keep this table order, so paths that need nothing outside the wallet come first. "First use" is a one-time token approval to Permit2, reported as the note `PERMIT2_SETUP_REQUIRED`. LI.FI Composer purchases do not accept Permit2 (`executorAcceptsPermit2` omitted), so they resolve to `NATIVE`, `DIRECT`, `ATOMIC_BATCH` or `SEQUENTIAL`. If a wallet that reported batching refuses a batch as unsupported, select again with `atomicBatch: false`. Malformed or contradictory facts (a native payment with approvals) throw `BagSdkError` `INVALID_ARGUMENT`.

`hasAtomicBatchCapability(capabilities, chainId)` reads a `wallet_getCapabilities` result: EIP-5792 v2 `atomic.status` `supported`/`ready` or the older `atomicBatch.supported`, under the chain's hex or decimal key or the all-chains `0x0` entry. Anything malformed is `false`.

### Quote timing, fees and provider warnings

Both `quoteBag` and `compileBag(...).quote` include:

| Field | Meaning |
|---|---|
| `requestedAtMs` / `receivedAtMs` | Local Unix millisecond timestamps around the provider call. These are observations, not the provider's quote creation time. |
| `validUntilMs` | Provider-reported deadline, or `null` when unknown. The LI.FI adapter preserves `fill.validUntilMs`; it never invents a lifetime. |
| `fees[].recipient` | Existing provider recipient role/tag, e.g. Composer's `lifi` or `integrator`. It is not a wallet address. |
| `fees[].recipientAddress` | Actual fee recipient address, or `null` if the provider did not report it. |
| `warnings` | Provider warning data: `kind`, `message`, and optional `path`, `port`, `fix`. Missing warnings normalize to `[]`. |

Provider deadlines must be positive safe integers in Unix milliseconds. An already expired response is rejected during compilation. `simulateBag` returns `QUOTE_EXPIRED` for a known expired deadline before RPC reads; it rechecks before and after `eth_call` so a response that expires during simulation cannot become `OK`.

Applications can additionally choose their own age limit:

```ts
const simulation = await simulateBag(compiled, { client, maxQuoteAgeMs: 30_000 });
if (simulation.status === 'QUOTE_EXPIRED') {
  // source is PROVIDER or LOCAL_MAX_AGE; obtain a fresh compile before signing.
  console.log(simulation.source, simulation.expiresAtMs);
}
```

`maxQuoteAgeMs` is an optional nonnegative safe integer, measured conservatively from `requestedAtMs` and including provider latency. The earlier of the local age limit and a known provider deadline wins; zero expires immediately. This is the application's local policy, not an upstream guarantee. Applying it to an older stored quote without timing metadata is refused: recompile first. Without a known deadline or a local age limit, simulation still checks the call but cannot establish quote freshness. These checks use the local clock and do not lock prices or authorize wallet submission; recompile/resimulate near signing. A deadline is not proof that calldata enforces it. Receipt verification still evaluates the original submitted purchase after its quote has expired.

Existing custom providers may omit `validUntilMs`, `warnings` and fee `recipientAddress`; they normalize to `null`, `[]` and `null`. New metadata is validated and copied into the public quote. Malformed deadlines, warning fields, fee addresses, basis points or amounts are rejected with `ProviderResponseError`. Warning text remains untrusted provider content: display it as text and review it before logging. Reported fees are informational, not proof of total execution cost or an allowlist approval of their recipients.

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

If the optional `registry expectedCreator` arguments are supplied, registry verification must succeed before quoting, compiling or simulating. A failed check returns the verification report without an unsigned transaction. Omitting these arguments keeps registry verification optional.

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

### Independently resolve the Composer account

The recommended path derives the wallet target from a caller-pinned deployment, before reading any Composer compile response:

```ts
import { lifiComposer, resolveLifiComposerAccount } from '@bagprotocol/sdk/lifi';

const account = await resolveLifiComposerAccount({
  chainId, signer, client: publicClient,
  deployment: { chainId, factory: reviewedFactory, factoryCodeHash: reviewedRuntimeHash },
});
const compiled = await compileBag(bag, request, {
  provider: lifiComposer({ apiKey, baseUrl, account }),
  trust: account.trust,
});
```

The helper checks the RPC chain and pinned factory runtime, calls `predictProxyAddress(signer)` on that factory, and checks `owner()` / `factory()` for a deployed proxy. Reads are bound to one block and canonical inclusion is rechecked. The resulting policy allows the proxy as target if deployed, or only the pinned factory on first use. Direct-deposit approvals remain limited to the predicted proxy in both cases. Passing `account` to the adapter also binds the request chain/signer, returned `userProxy`, target and approval spenders. Every swap output must describe immediate terminal delivery to the signer on the requested chain.

Do not construct the deployment pin or account from `transactionRequest.to` / `userProxy`. Choose a reviewed deployment independently, and repeat resolution for every compile. An API rollout can change the factory: mismatches are refused, never automatically trusted. This verifies account routing against the selected deployment; it does not audit the VM program, internal calls, upgrade controls or fee economics.

The [official account model](https://docs.li.fi/composer/composer-api/overview) now documents CreateX CREATE3, and [Addresses](https://docs.li.fi/composer/composer-api/reference/addresses) publishes a production factory snapshot. **Observed on 2026-10-21:** that snapshot names factory `0xe174d02351656a883f6626497c86684e849efb35`, while actual production compile responses on Robinhood used `0xaceb3bb6c75488b5b806b9de4dcf78814465bdae`. Both factories are deployed and return different proxies for the same signer. The new guard rejected the snapshot factory against the observed server response; it accepted the independently pinned observed deployment. See [deployment evidence and remaining release checks](https://github.com/0xdefimaster/BagProtocolv2/blob/main/docs/SDK_COMPOSER_TRUST.md). Never use one unqualified factory for every deployment just because it appears in documentation or a compile response.

`examples/compile-verified-composer.mjs` runs this path from a local bag.json after the SDK build. Supply your own `LIFI_API_KEY`, `RPC_URL`, `COMPOSER_FACTORY` and `COMPOSER_FACTORY_CODE_HASH`; optional `COMPOSER_URL` chooses your Composer deployment:

```
npm run build --prefix packages/bag-sdk
node packages/bag-sdk/examples/compile-verified-composer.mjs <bag.json> <inputToken> <amountRaw> <signer>
```

It prints an unsigned purchase and a separate wallet-state simulation result. A successful compile does not mean the signer has enough balance or approvals. No transaction is signed or submitted; credentials and transport errors are not printed. The older explicit `COMPOSER_TRUSTED_TARGETS` / `COMPOSER_TRUSTED_SPENDERS` examples remain available for callers managing their own complete trust policy, but they do not independently resolve the account.

**Verified live (2026-10-10, Robinhood Chain):** `verify-registry.ts` on the served `feetest` v1 document: 7/7 PASS.
`live-compile.ts`, 0.001 ETH into `feetest` for a wallet with its proxy as the trusted target: 8/8 PASS, simulation OK.
Nothing was signed or sent.

## Verify a submitted purchase

Keep the original compiled purchase and the wallet-reviewed output minimums. After submission, use your trusted public client:

```ts
import { verifyPurchaseReceipt } from '@bagprotocol/sdk';
import { withReceiptEvidence } from '@bagprotocol/sdk/evm';

const verification = await verifyPurchaseReceipt(compiled, {
  client: withReceiptEvidence(publicClient),
  transactionHash: walletReportedHash,
  minimumReceived: reviewedWalletMinimums, // { token: string; amountRaw: bigint }[]
  confirmations: 3,
});
console.log(verification.status, verification.outputs, verification.issues);
```

The default `BALANCE_DELTA` mode checks actual ERC-20 `balanceOf` changes, never silently falling back to events. It binds the transaction hash, chain, target, calldata and native value to the compiled purchase, checks canonical inclusion and confirmations, and rechecks inclusion after collecting evidence. Each output reports event totals separately from `balanceBeforeRaw`, `balanceAfterRaw` and `balanceDeltaRaw`.

- `VERIFIED`: the compiled call executed successfully and every wallet balance delta meets its explicit minimum.
- `FAILED`: a transaction binding failed, execution reverted, an output is below minimum, or input spending violates the plan.
- `INDETERMINATE`: evidence is unavailable, malformed, ambiguous, noncanonical or insufficiently confirmed. This is never success.

### Historical state and RPC capabilities

`withReceiptEvidence` uses only the supplied client's read methods and JSON-RPC transport. Its default `SINGLE_TRANSACTION_BLOCK` mode reads balances at canonical parent/current block hashes using EIP-1898. It refuses blocks containing multiple transactions: a block-wide balance change cannot be attributed to one transaction.

For a trusted **Geth 1.16** reader with historical state and debug APIs, explicitly enable transaction-indexed reconstruction:

```ts
const evidenceClient = withReceiptEvidence(publicClient, {
  balanceState: 'GETH_TRANSACTION_INDEX',
});
```

This mode requires `web3_clientVersion` to identify Geth 1.16. It uses `debug_traceCall` with `callTracer` and `txIndex` to read the pre-state of the target transaction and of the next transaction; the last transaction's post-state comes from the canonical block. Other clients may silently ignore `txIndex`, so unknown implementations are refused. Client version is a compatibility check, not protection against a dishonest RPC. Trust your reader. A custom `PurchaseReceiptClient.getPurchaseBalanceChanges` can supply transaction-scoped evidence from another qualified backend; it must bind the exact hash, block, owner and token set. Arbitrary wallet snapshots are not evidence.

#### Robinhood Chain / Nitro

For a trusted Robinhood mainnet reader qualified for historical traces, use the explicit Nitro mode:

```ts
const evidenceClient = withReceiptEvidence(publicClient, {
  balanceState: 'ROBINHOOD_NITRO_TRANSACTION_INDEX',
});
const result = await verifyPurchaseReceipt(compiled, {
  client: evidenceClient,
  transactionHash: walletReportedHash,
  minimumReceived: reviewedWalletMinimums,
  confirmations: 3,
});
```

This mode requires Robinhood mainnet and the qualified `nitro/v3.12.1+70fa99a` build. It uses the same pre-transaction index reconstruction, with canonical block-hash reads for the final transaction's post-state. Receipt transaction index must agree with block membership. The mode is opt-in: the SDK never assumes that Nitro is Geth, selects a provider, embeds an endpoint, or falls back to event-only verification. Unknown builds are refused until separately qualified. The version check assumes an honest, correctly configured reader; it is not an independent cryptographic proof.

On 2026-10-21, read-only qualification against a caller-supplied QuickNode Robinhood mainnet endpoint succeeded for historical transaction `0x7550ac9d15cbab5947c96f6eca4c10d2d3c15ef1c027f3a8587b499606ad9d3d`, block 81204116 (8 transactions, target index 5). `callTracer`, `prestateTracer` diff mode, historical `eth_call` and transaction-indexed `debug_traceCall` were available. Before/after deltas for all three transferred tokens matched their net Transfer amounts, and an out-of-range transaction index was rejected. This qualifies the observed reader/build; it does not establish support on every QuickNode plan or Nitro installation, and it does not verify that historical sale against an original SDK purchase intent.

To repeat the read-only evidence observation with your own endpoint in `RPC_URL`:

```
npm run build --prefix packages/bag-sdk
node packages/bag-sdk/examples/live-receipt-evidence.mjs <transactionHash> <owner> <token> [token...]
```

It reports `OBSERVED_RECEIPT_EVIDENCE` and `purchaseVerification: NOT_PERFORMED`; no original compiled purchase is available to that CLI. Applications must keep the original `compiled` purchase and explicit reviewed minima and call `verifyPurchaseReceipt` as above. Keep private endpoint tokens in environment configuration, outside committed files and output. No signing or submission occurs.

Smart-account batches and relayed calls additionally require `debug_traceTransaction` with the full `callTracer` tree (or `tracePurchaseCall` on a custom trusted reader). The trace must match the actual outer transaction and prove exactly one successful `CALL` from the planned signer to the compiled target with exact calldata/value. Reverted calls, descendants of reverted calls, delegatecalls and duplicate matches do not qualify. A public endpoint without tracing/historical state returns `INDETERMINATE` for unsupported evidence; use a qualified reader rather than weakening the check.

### Minimums, retained input and evidence limits

Supply a positive uint256 wallet minimum for every planned swap output. Missing, extra or duplicate tokens are rejected before RPC access. Provider `minOutRaw` applies at the swap boundary; `expectedOutRaw` is an estimate. Neither is silently reused as a wallet guarantee.

For ERC-20 payment, balance mode checks that the pre-state covers the planned deposit, the net input debit does not exceed `swapAmountRaw`, and any planned retained input is present in the post-state. Only then is `keptBalanceVerified` true. These are net balance checks, not a gross allowance/spending audit. Native payment is bound by the compiled call value; native gas balance and native basket outputs are outside this verifier.

An explicit `verification: 'TRANSFER_LOGS'` selects weaker event-only verification (`TRANSACTION_AND_TRANSFER_LOGS`). It subtracts outbound transfers and ignores self-transfer net amounts, validates log identities and rejects malformed/duplicate logs. Token events can disagree with actual balances, so event-only success does not prove wallet balances or retained input (`keptBalanceVerified` stays false).

Use ERC-20 contracts and RPC readers you trust. Even actual `balanceOf` calls depend on token semantics; rebases or other side effects within the same transaction cannot be attributed uniquely to the compiled subcall. Verification does not prove arbitrary calldata semantics, fees or registry identity. It remains `NOT_BAG_ACCOUNTED`: no BAG position, cost basis or fee eligibility is created. This is one read-only observation without polling, signing or submission; choose confirmation depth for the chain and recheck as needed.

### Reproducible checks

The unit suite includes real local EVM execution: direct purchases, dishonest Transfer amounts, smart-wallet relays, reverted inner calls and busy-block refusal. After building, an optional integration check can exercise an independently started disposable Geth 1.16 dev node:

```
geth --dev --dev.period 2 --http --http.addr 127.0.0.1 --http.port 8547 --http.api eth,net,web3,debug --datadir <temporary-directory> --nodiscover --maxpeers 0 --ipcdisable
node packages/bag-sdk/scripts/receipt-geth-smoke.mjs
```

This local-only script deploys a fixture and submits three local transactions in one block, then checks each isolated delta and default busy-block refusal. It never submits transactions to a public chain. No Geth binary is bundled. The deployed chain's live RPC capabilities must still be checked independently; local execution is not a live purchase claim.

## Error handling and HTTP retrieval

SDK-owned execution, account-verification and argument failures expose a stable `BagSdkError.code`. `ProviderResponseError` and `PurchasePlanError` keep their existing names and `instanceof` behavior; purchase issues remain available. Parser/validator findings, registry checks, receipt findings and existing partition codes keep their structured contracts.

`getSdkErrorInfo(error)` returns a fixed `{ code, message }` summary suitable for display. It never copies detailed messages, URLs, stacks, causes or abort reasons. Unknown errors use `UNKNOWN_ERROR`. Composer's own typed upstream errors remain unchanged; use its documented type guards for private diagnosis. Do not log arbitrary errors or request configuration.

| Codes | Suggested action |
|---|---|
| `HTTP_TIMEOUT`, `HTTP_ABORTED`, `HTTP_NETWORK_ERROR`, `HTTP_STATUS_ERROR` | Retry when appropriate or let the caller cancel. |
| `HTTP_RESPONSE_TOO_LARGE`, `HTTP_INVALID_UTF8`, `HTTP_BODY_READ_ERROR` | Inspect the strategy source. |
| `TRUST_POLICY_INVALID`, `UNTRUSTED_TARGET`, `UNTRUSTED_SPENDER` | Review the independently configured deployment; never auto-allow a returned address. |
| `OUTPUT_INVALID`, `SLIPPAGE_EXCEEDED`, `PRICE_IMPACT_INVALID`, `PRICE_IMPACT_EXCEEDED` | Obtain a compliant route. |
| `QUOTE_EXPIRED`, `QUOTE_TIMING_INVALID` | Recompile. Simulation also reports expiry as `status: 'QUOTE_EXPIRED'`. |
| `ACCOUNT_*`, `CHAIN_MISMATCH`, `RPC_READ_FAILED` | Recheck the pin, wallet, chain or reader capabilities. |

The exported `BagSdkErrorCode` type / `SDK_ERROR_MESSAGES` map contain the complete code list. Messages are explanatory text; branch on codes or structured findings.

```ts
import { getSdkErrorInfo } from '@bagprotocol/sdk';
import { fetchBag } from '@bagprotocol/sdk/http';

const controller = new AbortController();
try {
  const parsed = await fetchBag(strategyUrl, { signal: controller.signal, timeoutMs: 10_000 });
  // Handle parsed.ok, validate, recompute the hash and verify provenance separately.
} catch (error) {
  const diagnostic = getSdkErrorInfo(error);
  console.log(diagnostic.code, diagnostic.message);
}
// Call controller.abort() when a newer request replaces this one.
```

`fetchBag` defaults to a 15-second deadline covering request and full streamed body. `timeoutMs` must be an integer from 1 to 2147483647. The response limit remains 1,000,000 UTF-8 bytes. The deadline is not reset per chunk. A pre-aborted caller signal prevents the fetch; cancellation rejects promptly and attempts to cancel the reader. A custom fetch that ignores signals is still bounded from the caller's perspective, but the SDK cannot stop that implementation's external work. Timers/listeners are removed after settlement. Strict parse failures remain `ParseResult` findings, not transport exceptions.

## Package

The [independent consumer starter](../../examples/sdk-consumer) uses public package imports in a separate NodeNext project. It covers original-intent persistence, explicitly reviewed wallet minima, caller-owned wallet integration and receipt verification. Run `npm run smoke:starter --prefix packages/bag-sdk` after building to install the tarball in a fresh directory, typecheck the consumer and run its explicitly synthetic offline demo. It does not submit transactions or establish live purchase proof.

```
cd packages/bag-sdk
npm run typecheck   # tsc, no output
npm run build       # dist/: ES2022 ESM .js + .d.ts for ".", "./http", "./evm", "./lifi"
npm pack --dry-run  # what a tarball would contain: dist/, README.md, package.json
npm run smoke:consumer  # packs, installs the tarball in a fresh temp project, imports every entry point, typechecks a TS consumer
```

Node >=24 is the declared runtime baseline. The current **0.3.0 candidate is not published**; npm latest was observed as 0.2.1 on 2026-10-22. See [CHANGELOG](./CHANGELOG.md) and [release preparation](../../docs/SDK_RELEASE_PREPARATION.md) for compatibility evidence and open publication gates. Run `npm run release:check --prefix packages/bag-sdk -- --out <absolute-new-directory>` to build, verify fresh consumers and pack a reviewable candidate without publishing. A passing candidate check does not approve a factory, establish live purchase proof or authorize publication.

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
