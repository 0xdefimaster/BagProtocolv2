# RecurringPurchaseExecutor fork kanıtı

| | |
|---|---|
| Kanıt sınıfı | **TEST_KEY_FORK**: yalnızca bu süreçte üretilen test anahtarları. Cüzdan, insan imzası veya public işlem değildir |
| Çıkış | 0 COMPLETE |
| Uygulama commit'i | `ea47f313d94ca5b9fc6295b3f02275d5fa721118` (contracts/ ve SDK src kirli mi: hayır) |
| Fork | blok 97429487 (`0x276086b70744eaa1e92523010f9fe76e0dd0c11b022a6ddeda6c23c0169cde58`), tek fork bloğu; her alımın bütün bacakları tek işlemde |
| Executor | `0x008f01d056eb06d708eaeC1e2e27B82435910CB9` (anahtarsız; 4663'te kod 0x, nonce 0). Runtime artifact ile eşleşiyor: true |
| Gerçek kontratlar | USDG (impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F`), SwapRouter02, QuoterV2, BagFactory, StrategyRegistry. Router: uygulamanın BagExecutionRouter'ı, gerçek BagFactory ile; owner ve planSigner test anahtarı |
| Fiyat sınırı | Sahibin imzaladığı varlık başına azami fiyat. Testte: kurulumda gerçek zincirdeki en iyi QuoterV2 teklifi + 300 bps (A/B/C, keeper) veya + 100 bps (P). Bağımsız piyasa referansı **değildir** |
| Ağ | Composer/LI.FI isteği: **0**; reddedilen host: 0; upstream okuma: 1042; relay'in reddettiği yazma: 0; public yazma: 0 |
| Fonlar EOA'da | EVET: 6 alım × 5 USDG = 30000000 ham birim; executor ve router'da bakiye kalmadı |

## Yaşam döngüsü (dürüst işlemler): 7/7

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| L1-permit-first-run | LIFECYCLE | run 1 of A; EIP-2612 permit for exactly the total budget is consumed inside execute (real USDG) | VERIFIED, debit 5000000 raw, executions 1, gas 1236621 | — | PASS |
| L2-approve-first-run-B | LIFECYCLE | run 1 of B with a standard approve (no permit) | VERIFIED, debit 5000000 raw, executions 1, gas 1116880 | — | PASS |
| V1-revoke-B | REVOCATION | owner revoke(idB) on chain; allowance untouched by revoke | revoked=true, allowance 10000000 → 10000000 (revoke does not reset allowance) | — | PASS |
| L3-second-run-same-window-after-attacks | LIFECYCLE | run 2 of A in window 1: the refusals above did not consume the window | VERIFIED, debit 5000000 raw, executions 2, gas 1076361 | — | PASS |
| L4-C-after-reapprove | LIFECYCLE | C runs again after the owner re-approves one run | VERIFIED, debit 5000000 raw, executions 2, gas 1076363 | — | PASS |
| V4-revokeBySig-C | REVOCATION | owner signs Revocation off chain; a third party submits revokeBySig | revoked=true (submitted by 0x062d71DF841B7EDfc350782F550e3DD678c078Af) | — | PASS |
| L5-third-run-A | LIFECYCLE | run 3 of A (last), window 2 | VERIFIED, debit 5000000 raw, executions 3, gas 1076344 | — | PASS |

## Gerçek hatalı yürütme (fork'ta gönderildi ve mine edildi): 28/28

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| F1-same-window-again | SCHEDULE | NotDue; nothing changes | reverted (mined): NotDue() | true | PASS |
| V2-revoked-B-with-restored-allowance | REVOCATION | after revoke and approve(0), a third party submits B's unused permit (allowance restored); execute → RevokedAuthorization | reverted (mined): RevokedAuthorization(0x15fe1608976793de11f2379c645be99ee802ac7473d594af839dd20eeec722be) | true | PASS |
| U1-permit-front-run-C | FUNDING | a third party submits the permit first; execute still succeeds (the try/catch only skips the used nonce) | VERIFIED, debit 5000000 raw, executions 1, gas 1138180 | — | PASS |
| P1-recipient-to-attacker | PLAN_SIGNER_TRUST | leg output sent to the attacker instead of the router → RouteViolation(0,6) | reverted (mined): RouteViolation(0,6) | true | PASS |
| P2-min-below-owner-limit | PLAN_SIGNER_TRUST | leg 1 minimum set to 1 (calldata and router check) → RouteViolation(1,11) | reverted (mined): RouteViolation(1,11) | true | PASS |
| P3-spend-more | PLAN_SIGNER_TRUST | inputAmount doubled → PlanMismatch(3) | reverted (mined): PlanMismatch(3) | true | PASS |
| P4-other-bag | PLAN_SIGNER_TRUST | plan for another bagId → PlanMismatch(4) | reverted (mined): PlanMismatch(4) | true | PASS |
| P5-other-target | PLAN_SIGNER_TRUST | leg 0 sent to UniversalRouter (allowlisted by the malicious router owner) → RouteViolation(0,1) | reverted (mined): RouteViolation(0,1) | true | PASS |
| P6-other-token | PLAN_SIGNER_TRUST | leg 2 buys USDG→GME instead of COIN → RouteViolation(2,5) | reverted (mined): RouteViolation(2,5) | true | PASS |
| P7-price-limit-partial-fill | PLAN_SIGNER_TRUST | sqrtPriceLimitX96 set on leg 0 (partial fill) → RouteViolation(0,8) | reverted (mined): RouteViolation(0,8) | true | PASS |
| P8-shift-leg-amounts | PLAN_SIGNER_TRUST | leg 0 +1 raw, leg 1 −1 raw (same total) → RouteViolation(0,3) | reverted (mined): RouteViolation(0,3) | true | PASS |
| P9-wrong-window | PLAN_SIGNER_TRUST | execution claims window 2 while window 1 is current → WrongWindow | reverted (mined): WrongWindow(1,2) | true | PASS |
| P10-stale-quote | PLAN_SIGNER_TRUST | quoteDeadline in the past → QuoteExpired | reverted (mined): QuoteExpired(1792997962) | true | PASS |
| P11-forged-owner-signature | PLAN_SIGNER_TRUST | authorization signature from another key → InvalidOwnerSignature | reverted (mined): InvalidOwnerSignature() | true | PASS |
| P12-terms-swapped-recipient | PLAN_SIGNER_TRUST | keeper swaps the recipient in the terms, keeps the owner signature and id → AuthorizationMismatch | reverted (mined): AuthorizationMismatch(0xac1c145b2574ce33f59eb42d03e1e56741bc1a9b2baef056d7c5754d39a6d5fd,0x0a773b3cb66dd34cb504d7764919f66f589c71d571bd4091cafd85b193441385) | true | PASS |
| V3-allowance-reset-is-not-revocation | REVOCATION | C has allowance 0 (approve(0) on day 0) → the transfer fails; C is NOT revoked | reverted (mined): InsufficientAllowance() | true | PASS |
| V5-revoked-C | REVOCATION | C has allowance again but is revoked → RevokedAuthorization | reverted (mined): RevokedAuthorization(0x6ad355e8baf6f6fc79b02402b4741c4471227bc927a13d2598197af1e717f2a2) | true | PASS |
| F2-exhausted | SCHEDULE | A after 3 of 3 runs, allowance available → Exhausted | reverted (mined): Exhausted() | true | PASS |
| F3-expired | SCHEDULE | A at/after expiresAt → Expired (the SDK refuses to build first; the plan is built for the last valid second) | reverted (mined): Expired() | true | PASS |
| R1-a3caff05-signed-for-v1 | BAG_REGISTRY | authorization for a3caff05 version 1 (BagFactory history, block 92213308); the creator recorded v2 → BagChanged(2, current hash) | reverted (mined): BagChanged(2,0x2dbb1733ab3eb7f0a632d5a7ac51056625d2050bedfe9ee85ad2b9e0d935cde0) | true | PASS |
| R2-a3caff05-v2-registry-passes | BAG_REGISTRY | a3caff05 v2 with the registered strategyId and definitionHash: BagFactory and StrategyRegistry checks pass; the call stops at the plan check → PlanMismatch(5) | reverted (mined): PlanMismatch(5) | true | PASS |
| R3-a3caff05-wrong-definition | BAG_REGISTRY | a3caff05 v2 with another definitionHash → StrategyNotRegistered | reverted (mined): StrategyNotRegistered(0x72ec1d37c03f9bfb3dc369cf77f19841e7d0a7ca00ca3757605d97fb2f398cae,2) | true | PASS |
| R4-unknown-bag | BAG_REGISTRY | bagId not in BagFactory → UnknownBag | reverted (mined): UnknownBag(0x7d3114750f8342b1f512067eb9c9460beebdd01cbd9988ca7d89a5649e4398f4) | true | PASS |
| R5-955df6e0-wrong-composition | BAG_REGISTRY | 955df6e0 with a3caff05's composition hash → BagChanged(1, real hash) | reverted (mined): BagChanged(1,0xb01f70750ffa0fbcecf99958683aac3ceca89ff55e18f09913ecbf3dde5e0148) | true | PASS |
| R6-955df6e0-claims-registered | BAG_REGISTRY | 955df6e0 is not in StrategyRegistry; naming its derived strategyId → StrategyNotRegistered | reverted (mined): StrategyNotRegistered(0x37f16d57d87fcda8bc3c1863fc5b3d75fb7ad5e5ba89060ff20ce56b27be40eb,1) | true | PASS |
| M1-pre-move-plan-after-move | PRICE_POLICY | the plan quoted before the move, honestly signed, is submitted after it: the swap cannot meet the minimum → reverted, nothing changes | reverted (mined): Error(Too little received) | true | PASS |
| M3-planSigner-accepts-market | PRICE_POLICY | planSigner signs the post-move market price as the COIN minimum (below the owner limit) → RouteViolation(coin,11) | reverted (mined): RouteViolation(2,11) | true | PASS |
| M4-calldata-min-zero | PRICE_POLICY | planSigner keeps the router minimum at the owner floor but sets calldata amountOutMinimum = 0: the swap executes at the moved price and the measured-output check reverts it | reverted (mined): InsufficientOutput(0x6330D8C3178a418788dF01a47479c0ce7CCF450b,10416218669662688,11228264631961999) | true | PASS |

## SDK reddi (plan kurulmadı): 3/3

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| R0-sdk-refuses-fee-bearing-bag | FEE_SCOPE | a3caff05 declares performanceFeeBps 1000: the SDK refuses to build an authorization (fee-bearing BAGs are outside the first scope) | RECURRING_TERMS_INVALID: strategies with a performance fee are not supported by recurring purchases yet. | — | PASS |
| S1-a3caff05-no-v3-route | ROUTE_SCOPE | a3caff05 v2 cannot be bought with v3 exactInputSingle: some asset has no USDG pool at any allowed tier → NO_ROUTE | NO_ROUTE: No allowed Uniswap v3 fee tier quoted 0xeb61c0ed490a367d4e3631ccf8a74b3bfc7e775d. | — | PASS |
| M2-sdk-refuses-after-move | PRICE_POLICY | fresh quotes are below the owner limit → PRICE_LIMIT_NOT_MET, no plan | PRICE_LIMIT_NOT_MET: 0x6330d8c3178a418788df01a47479c0ce7ccf450b: every quotable fee tier reaches the owner's price limit. | — | PASS |

## Değiştirilmiş doğrulama beklentisi (iyi makbuz, yanlış beklenti): 4/4

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| E1-other-recipient | RECEIPT_VERIFIER | expect another recipient | FAILED: EVENT_MISSING, BELOW_PRICE_LIMIT | — | PASS |
| E2-other-amount | RECEIPT_VERIFIER | expect 6 USDG per run | FAILED: EVENT_MISSING, SOURCE_DEBIT_MISMATCH, BELOW_PRICE_LIMIT | — | PASS |
| E3-other-executor | RECEIPT_VERIFIER | expect another executor address | FAILED: NOT_EXECUTOR_TX, EVENT_MISSING, BELOW_PRICE_LIMIT | — | PASS |
| E4-tighter-limits | RECEIPT_VERIFIER | expect limits 10× tighter | FAILED: EVENT_MISSING, BELOW_PRICE_LIMIT | — | PASS |

## Kalıcı keeper (aynı fork): 6/6

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| K1-first-run | KEEPER | keeper A (file store) adds the signed authorization and buys window 0; the SDK verifies the real receipt | PENDING_TX → DONE_THIS_WINDOW, VERIFIED 0x65301564e78b755095ef26d80623622e3f08c5b59f612c5d8c71bba0ca4f848f | — | PASS |
| K2-restart-same-store | KEEPER | a new keeper process on the same file store in the same window: nothing is sent | DONE_THIS_WINDOW, nonce unchanged, chain executions 1 | — | PASS |
| K3-lost-store | KEEPER | a keeper with an EMPTY store re-adds the authorization: the chain counters keep the window closed; the earlier run is recovered from logs | DONE_THIS_WINDOW, confirmed recovered 1, nonce unchanged | — | PASS |
| K4-crash-after-send | KEEPER | window 1: the keeper crashes after sending, before storing the hash; the restart finds the purchase on chain and does not resend | crashed=true, write-ahead hash=null, after restart: DONE_THIS_WINDOW, confirmed 2, chain executions 2, nonce unchanged | — | PASS |
| K5-two-keepers | KEEPER | window 2: keeper B (own store, its node blind to A's pending tx) sends too; one purchase, B's mined revert is recorded, the owner is charged once | both sent; chain executions 3; owner charged 5000000; reverted attempts recorded 1 | — | PASS |
| K6-gas-shortage | KEEPER | window 3: the keeper account has no ETH → GAS_SHORTAGE and nothing sent; funded again → the last run; then COMPLETED | GAS_SHORTAGE (no tx) → confirmed 4 → COMPLETED; chain executions 4, grossUsed 20000000 | — | PASS |

Fork'a özel durum değişiklikleri (18): ARBSYS, GAS, IMPERSONATE, SET_CODE, SNAPSHOT, REVERT. Ayrıntı: results.json → forkChanges.
