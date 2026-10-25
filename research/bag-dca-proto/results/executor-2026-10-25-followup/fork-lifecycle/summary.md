# RecurringPurchaseExecutor fork kanıtı

| | |
|---|---|
| Aşama | lifecycle (her aşama kendi fork'unda: public RPC fork bloğunun durumunu ~10 dakika tutuyor) |
| Kanıt sınıfı | **TEST_KEY_FORK**: yalnızca bu süreçte üretilen test anahtarları. Cüzdan, insan imzası veya public işlem değildir |
| Çıkış | 0 COMPLETE |
| Uygulama commit'i | `d71d1db9c4809c3bef1e844f128f28d5ae82bca5` (contracts/ ve SDK src kirli mi: hayır) |
| Fork | blok 97879116 (`0xb06d35e83d9fd48fcebbd0a34f9a08a37dea27f4334bd58b5dd082bea3bdd7ad`), tek fork bloğu; her alımın bütün bacakları tek işlemde |
| Executor | `0x008f01d056eb06d708eaeC1e2e27B82435910CB9` (anahtarsız; 4663'te kod 0x, nonce 0). Runtime artifact ile eşleşiyor: true |
| Gerçek kontratlar | USDG (impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F`), SwapRouter02, QuoterV2, BagFactory, StrategyRegistry. Router: uygulamanın BagExecutionRouter'ı, gerçek BagFactory ile; owner ve planSigner test anahtarı |
| Alım doğrulaması | SDK `verifyRecurringPurchase`: mine edilen calldata bu koşucunun hazırladığı çağrıyla bayt bayt aynı (PREPARED_INTENT); kaynak borcu, alıcı teslimleri ve executor/router kalıntısı işlem kapsamlı bakiyelerden (okuyucu: SINGLE_TRANSACTION_BLOCK; yalnızca bloktaki tek işlem için geçerli). Koşucunun kendi bakiye okumaları ikinci, bağımsız kontrol. Gerçek zincir için Nitro okuyucusu bu koşuda denenmedi |
| Fiyat sınırı | Sahibin imzaladığı varlık başına azami fiyat. Testte: kurulumda gerçek zincirdeki en iyi QuoterV2 teklifi + 300 bps (A/B/C, keeper) veya + 100 bps (P). Bağımsız piyasa referansı **değildir** |
| Ağ | Composer/LI.FI isteği: **0**; reddedilen host: 0; upstream okuma: 706; relay'in reddettiği yazma: 0; public yazma: 0 |
| Fonlar EOA'da | EVET: 6 alım × 5 USDG = 30000000 ham birim; executor ve router'da bakiye kalmadı |

## Yaşam döngüsü (dürüst işlemler; SDK doğrulaması: hazırlanan çağrı + işlem kapsamlı bakiye): 7/7

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| L1-permit-first-run | LIFECYCLE | run 1 of A; EIP-2612 permit for exactly the total budget is consumed inside execute (real USDG) | VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK), debit 5000000 raw, executions 1, gas 1309003 | — | PASS |
| L2-approve-first-run-B | LIFECYCLE | run 1 of B with a standard approve (no permit) | VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK), debit 5000000 raw, executions 1, gas 1174771 | — | PASS |
| V1-revoke-B | REVOCATION | owner revoke(idB) on chain; allowance untouched by revoke | revoked=true, allowance 10000000 → 10000000 (revoke does not reset allowance) | — | PASS |
| L3-second-run-same-window-after-attacks | LIFECYCLE | run 2 of A in window 1: the refusals above did not consume the window | VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK), debit 5000000 raw, executions 2, gas 1127230 | — | PASS |
| L4-C-after-reapprove | LIFECYCLE | C runs again after the owner re-approves one run | VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK), debit 5000000 raw, executions 2, gas 1134152 | — | PASS |
| V4-revokeBySig-C | REVOCATION | owner signs Revocation off chain; a third party submits revokeBySig | revoked=true (submitted by 0xC5C8B3C4307b4ca3E113F1c04CBb221F6f9aA065) | — | PASS |
| L5-third-run-A | LIFECYCLE | run 3 of A (last), window 2 | VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK), debit 5000000 raw, executions 3, gas 1139519 | — | PASS |

## Gerçek hatalı yürütme (fork'ta gönderildi ve mine edildi): 19/19

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| F1-same-window-again | SCHEDULE | NotDue; nothing changes | reverted (mined): NotDue() | true | PASS |
| V2-revoked-B-with-restored-allowance | REVOCATION | after revoke and approve(0), a third party submits B's unused permit (allowance restored); execute → RevokedAuthorization | reverted (mined): RevokedAuthorization(0xab40b8c162d016a0b3e95ac7b8f03e36441b20cda5df3e9ea4270f9b6d9082a3) | true | PASS |
| U1-permit-front-run-C | FUNDING | a third party submits the permit first; execute still succeeds (the try/catch only skips the used nonce) | VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK), debit 5000000 raw, executions 1, gas 1196017 | — | PASS |
| P1-recipient-to-attacker | PLAN_SIGNER_TRUST | leg output sent to the attacker instead of the router → RouteViolation(0,6) | reverted (mined): RouteViolation(0,6) | true | PASS |
| P2-min-below-owner-limit | PLAN_SIGNER_TRUST | leg 1 minimum set to 1 (calldata and router check) → RouteViolation(1,11) | reverted (mined): RouteViolation(1,11) | true | PASS |
| P3-spend-more | PLAN_SIGNER_TRUST | inputAmount doubled → PlanMismatch(3) | reverted (mined): PlanMismatch(3) | true | PASS |
| P4-other-bag | PLAN_SIGNER_TRUST | plan for another bagId → PlanMismatch(4) | reverted (mined): PlanMismatch(4) | true | PASS |
| P5-other-target | PLAN_SIGNER_TRUST | leg 0 sent to UniversalRouter (allowlisted by the malicious router owner) → RouteViolation(0,1) | reverted (mined): RouteViolation(0,1) | true | PASS |
| P6-other-token | PLAN_SIGNER_TRUST | leg 2 buys USDG→GME instead of COIN → RouteViolation(2,5) | reverted (mined): RouteViolation(2,5) | true | PASS |
| P7-price-limit-partial-fill | PLAN_SIGNER_TRUST | sqrtPriceLimitX96 set on leg 0 (partial fill) → RouteViolation(0,8) | reverted (mined): RouteViolation(0,8) | true | PASS |
| P8-shift-leg-amounts | PLAN_SIGNER_TRUST | leg 0 +1 raw, leg 1 −1 raw (same total) → RouteViolation(0,3) | reverted (mined): RouteViolation(0,3) | true | PASS |
| P9-wrong-window | PLAN_SIGNER_TRUST | execution claims window 2 while window 1 is current → WrongWindow | reverted (mined): WrongWindow(1,2) | true | PASS |
| P10-stale-quote | PLAN_SIGNER_TRUST | quoteDeadline in the past → QuoteExpired | reverted (mined): QuoteExpired(1793045028) | true | PASS |
| P11-forged-owner-signature | PLAN_SIGNER_TRUST | authorization signature from another key → InvalidOwnerSignature | reverted (mined): InvalidOwnerSignature() | true | PASS |
| P12-terms-swapped-recipient | PLAN_SIGNER_TRUST | keeper swaps the recipient in the terms, keeps the owner signature and id → AuthorizationMismatch | reverted (mined): AuthorizationMismatch(0x43fe065ad0db7753fd04f1e06d1adbb62bae27a4d63f9511fbb77fba58e7f459,0x3a62c6ac70d5901ce0688df3bdb49a7f5f93c7300a8fe21c33fdb5802908ce5e) | true | PASS |
| V3-allowance-reset-is-not-revocation | REVOCATION | C has allowance 0 (approve(0) on day 0) → the transfer fails; C is NOT revoked | reverted (mined): InsufficientAllowance() | true | PASS |
| V5-revoked-C | REVOCATION | C has allowance again but is revoked → RevokedAuthorization | reverted (mined): RevokedAuthorization(0xa6f398138e2152a49ea1091502590014a66e3c884a1f43419fda31e95535df26) | true | PASS |
| F2-exhausted | SCHEDULE | A after 3 of 3 runs, allowance available → Exhausted | reverted (mined): Exhausted() | true | PASS |
| F3-expired | SCHEDULE | A at/after expiresAt → Expired (the SDK refuses to build first; the plan is built for the last valid second) | reverted (mined): Expired() | true | PASS |

## Değiştirilmiş doğrulama beklentisi (mine edilmiş işlem, yanlış beklenti): 7/7

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| E0-baseline | RECEIPT_VERIFIER | the good L1 transaction: VERIFIED with the prepared call and with the decoded call; event-only mode is VERIFIED but labelled TRANSACTION_AND_TRANSFER_LOGS | prepared call: VERIFIED \| decoded call: VERIFIED \| event-only: VERIFIED | — | PASS |
| E1-other-recipient | RECEIPT_VERIFIER | expect another recipient (another authorization id) → AUTHORIZATION_MISMATCH | prepared call: FAILED AUTHORIZATION_MISMATCH \| decoded call: FAILED AUTHORIZATION_MISMATCH | — | PASS |
| E2-other-amount | RECEIPT_VERIFIER | expect 6 USDG per run → AUTHORIZATION_MISMATCH | prepared call: FAILED AUTHORIZATION_MISMATCH \| decoded call: FAILED AUTHORIZATION_MISMATCH | — | PASS |
| E3-other-executor | RECEIPT_VERIFIER | expect another executor address → AUTHORIZATION_MISMATCH (prepared) / NOT_EXECUTOR_TX (decoded) | prepared call: FAILED AUTHORIZATION_MISMATCH \| decoded call: FAILED NOT_EXECUTOR_TX | — | PASS |
| E4-tighter-limits | RECEIPT_VERIFIER | expect limits 10× tighter → AUTHORIZATION_MISMATCH | prepared call: FAILED AUTHORIZATION_MISMATCH \| decoded call: FAILED AUTHORIZATION_MISMATCH | — | PASS |
| E5-other-prepared-call | RECEIPT_VERIFIER | same authorization, but the call prepared for another run (L3), or the L1 call without its permit proof → CALL_MISMATCH | L3 intent: FAILED CALL_MISMATCH \| permit proof dropped: FAILED CALL_MISMATCH | — | PASS |
| E6-mined-revert | RECEIPT_VERIFIER | F1's mined, reverted execute for A → FAILED TRANSACTION_REVERTED (nothing bought) | decoded call: FAILED TRANSACTION_REVERTED | — | PASS |

Fork'a özel durum değişiklikleri (12): ARBSYS, GAS, IMPERSONATE, SET_CODE. Ayrıntı: results.json → forkChanges.
