# Independent integration results + LI.FI response

Reviewed #127 @ a879ff12960ab73fa1345625bfb81483e06aec29 and tested the unchanged integration SDK @ f8d73b487929d196ff83ac09dee260987e171a40 (contains #126 @ 3f85a4c).

- Build PASS, root tsc --noEmit PASS, SDK 312/312 PASS. Whole-repository tests were not independently rerun here.
- FRESH LIVE Composer compilations executed on an isolated Robinhood fork: 34/34 PASS. Four 5-USDG purchases (A twice, B twice), all forwarded receipts VERIFIED; legacy receipts still INPUT_BALANCE_BELOW_PLAN.
- Successful purchase impactBps: A-4=13, A-6=13, B-4=15, B-6=15.
- negativeQuotesUsed=0; negative live-path status=NOT_TESTED_NO_NEGATIVE_QUOTE_IN_THIS_RUN. Keep this separate from signed-impact unit fixtures. No retry/quote selection, threshold changes or guard bypasses.
- Selected raw API priceImpact fields and version headers are recorded for every compile attempt. Execution-associated price impact appears in the successful purchase cases and forwarded-verdict entries.
- Failed swaps roll back funding and plan counters, including delegation enforcer counters in B. Authorization mismatch cases still reject.

## Leo's reply, supplied by the user

Leo confirmed on 24 October at 18:30-18:31 that Composer compares total input/output values, that negative price impact is valid, and that the max impact bound is applied at quote time. This resolves the pending validity/sign-acceptance question. Exact rounding was not specified; keep ±1 bps documented as the compatibility policy rather than an official rounding rule. Update the draft's stale 'negative validity not answered' wording accordingly.

No tracked SDK source edits, merge, publication or public-network transactions were performed. Real MetaMask/Rabby signatures remain NOT TESTED.

The v2 prototype runner was instrumented only for metadata capture and linking quotes to verified purchases. Both the runner and its diff are included; use it beside the original composer/contracts/ in the existing prototype. Version pins, hashes and reproduction command are in review-manifest.json.
