# Question for LI.FI: Composer `priceImpact.impactBps` sign and rounding

Paste-ready (English). Contains no key, address book or account data.

---

**Subject:** Composer `/compose` — definition of `data.priceImpact.impactBps` (sign, formula, rounding)

Hi LI.FI team,

We integrate Composer 0.11.3 (`@lifi/composer-sdk` / `@lifi/compose-spec` 0.11.3) on Robinhood Chain (4663). A `/compose` response (HTTP 200, revision `9169cc8`, request `maxPriceImpactBps = 500`) returned:

```json
"priceImpact": {
  "inputValueUsd": 4.9918325034999995,
  "outputValueUsd": 4.99499414537114,
  "impactBps": -6,
  "unpricedInputs": [],
  "unpricedOutputs": []
}
```

The `PriceImpact` type and the docs ([FAQ](https://docs.li.fi/faqs/slippage-price-impact), [Composer SDK API](https://docs.li.fi/composer/composer-api/reference/sdk-api)) describe the USD-value comparison and the `maxPriceImpactBps` rejection bound, but not the exact contract of the returned field. Could you confirm:

1. **Formula:** is it `impactBps = (inputValueUsd − outputValueUsd) / inputValueUsd × 10 000`?
2. **Sign:** is a negative value valid and does it always mean the priced output is worth *more* than the priced input (favorable)?
3. **Rounding:** how is the value rounded to an integer: half-away-from-zero, half-even, truncation toward zero, or something else? Above, `−6.3336…` became `−6`; we also observed `−7` once.
4. **`maxPriceImpactBps`:** is the server-side check `impactBps > maxPriceImpactBps` (so any negative value always passes)?
5. **Unpriced assets:** when `unpricedInputs`/`unpricedOutputs` are non-empty, which assets are excluded from the USD values, and can `impactBps` then still be negative or omitted?
6. **Stability:** is this field part of the stable API contract, or still technical preview and subject to change?

Thank you!

---

## What we do with the answer
- The SDK guard (`packages/bag-sdk/src/execution.ts:226`, `PRICE_IMPACT_INVALID` for `< 0`) stays unchanged until LI.FI answers.
- If formula and sign are confirmed: a **separate** PR (not #126). That PR would accept a negative value only if it equals the confirmed formula, applied to the returned USD values, within the confirmed rounding, and only when `unpriced*` are empty. It would never clamp to 0, and the upper bound `maxPriceImpactBps` would stay as it is.
