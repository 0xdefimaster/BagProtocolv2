# RecurringPurchaseExecutor fork kanıtı

| | |
|---|---|
| Aşama | keeper (her aşama kendi fork'unda: public RPC fork bloğunun durumunu ~10 dakika tutuyor) |
| Kanıt sınıfı | **TEST_KEY_FORK**: yalnızca bu süreçte üretilen test anahtarları. Cüzdan, insan imzası veya public işlem değildir |
| Çıkış | 0 COMPLETE |
| Uygulama commit'i | `9ebbf2459dccbb42d52095f6c40b8cebfcbb5152` (contracts/ ve SDK src kirli mi: hayır) |
| Fork | blok 97888876 (`0x7b9dd0864da7a3bd136f6fe4de6568255770aa0cd2c74aeebadce3d0706967a2`), tek fork bloğu; her alımın bütün bacakları tek işlemde |
| Executor | `0x008f01d056eb06d708eaeC1e2e27B82435910CB9` (anahtarsız; 4663'te kod 0x, nonce 0). Runtime artifact ile eşleşiyor: true |
| Gerçek kontratlar | USDG (impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F`), SwapRouter02, QuoterV2, BagFactory, StrategyRegistry. Router: uygulamanın BagExecutionRouter'ı, gerçek BagFactory ile; owner ve planSigner test anahtarı |
| Alım doğrulaması | SDK `verifyRecurringPurchase`: mine edilen calldata bu koşucunun hazırladığı çağrıyla bayt bayt aynı (PREPARED_INTENT); kaynak borcu, alıcı teslimleri ve executor/router kalıntısı işlem kapsamlı bakiyelerden (okuyucu: SINGLE_TRANSACTION_BLOCK; yalnızca bloktaki tek işlem için geçerli). Koşucunun kendi bakiye okumaları ikinci, bağımsız kontrol. Gerçek zincir için Nitro okuyucusu bu koşuda denenmedi |
| Fiyat sınırı | Sahibin imzaladığı varlık başına azami fiyat. Testte: kurulumda gerçek zincirdeki en iyi QuoterV2 teklifi + 300 bps (A/B/C, keeper) veya + 100 bps (P). Bağımsız piyasa referansı **değildir** |
| Ağ | Composer/LI.FI isteği: **0**; reddedilen host: 0; upstream okuma: 548; relay'in reddettiği yazma: 0; public yazma: 0 |

## Kanıt kapsamı (okuyucunun kanıtlayamadığı durum): 1/1

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| B1-busy-block | RECEIPT_VERIFIER | an honest purchase mined in the same block as another transaction: the SINGLE_TRANSACTION_BLOCK reader cannot isolate it → INDETERMINATE (BALANCE_EVIDENCE_UNAVAILABLE), never VERIFIED; event-only verification of the same transaction is VERIFIED and labelled TRANSACTION_AND_TRANSFER_LOGS | purchase success, same block as another tx: true; balance mode INDETERMINATE (BALANCE_EVIDENCE_UNAVAILABLE); event-only VERIFIED (TRANSACTION_AND_TRANSFER_LOGS) | — | PASS |

## Kalıcı keeper (aynı fork): 7/7

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| K1-first-run | KEEPER | keeper A (file store) adds the signed authorization and buys window 0; the SDK verifies the real receipt | PENDING_TX → DONE_THIS_WINDOW, VERIFIED (PREPARED_INTENT, SINGLE_TRANSACTION_BLOCK) 0x7064ea568d6182b8955f2576de2eae977038533ac94f8a3b304774a53e68aae5 | — | PASS |
| K2-restart-same-store | KEEPER | a new keeper process on the same file store in the same window: nothing is sent | DONE_THIS_WINDOW, nonce unchanged, chain executions 1 | — | PASS |
| K3-lost-store | KEEPER | a keeper with an EMPTY store re-adds the authorization: the chain counters keep the window closed; the earlier run is recovered from logs | DONE_THIS_WINDOW, confirmed recovered 1 (VERIFIED, DECODED_CALL: not prepared by this keeper), nonce unchanged | — | PASS |
| K4-crash-after-send | KEEPER | window 1: the keeper crashes after sending, before storing the hash; the restart finds the purchase on chain and does not resend | crashed=true, write-ahead hash=null, after restart: DONE_THIS_WINDOW, confirmed 2 (VERIFIED, PREPARED_INTENT from the write-ahead intent), chain executions 2, nonce unchanged | — | PASS |
| K5-two-keepers | KEEPER | window 2: keeper B (own store, its node blind to A's pending tx) sends too; one purchase, B's mined revert is recorded, the owner is charged once | both sent; chain executions 3; owner charged 5000000; reverted attempts recorded 1 | — | PASS |
| K6-gas-shortage | KEEPER | window 3: the keeper account has no ETH → GAS_SHORTAGE and nothing sent; funded again → the last run; then COMPLETED | GAS_SHORTAGE (no tx) → confirmed 4 → COMPLETED; chain executions 4, grossUsed 20000000 | — | PASS |
| K7-fixed-price-skips-window | KEEPER | a new 2-run authorization (limits 100 bps above the real quote): run 1 in window 0; in window 1 the COIN pool is moved above the fixed max price → WAITING_PRICE stating market vs max price, nothing sent; at expiry window 1 is recorded missed (WAITING_PRICE), not made up, and one run's budget is reported unspendable | 1 × 1000 USDG moved COIN; window 1: WAITING_PRICE (COIN (0x6330d8c3178a418788df01a47479c0ce7ccf450b): the pool price is at or above the FIXED max price 166293255 at every allowed fee tier; no purchase in this wi), no tx: true; at expiry: EXPIRED, missed 1:WAITING_PRICE, runs left 1, unspendable 5000000 raw; chain executions 1 | — | PASS |

Fork'a özel durum değişiklikleri (16): ARBSYS, GAS, IMPERSONATE, SET_CODE. Ayrıntı: results.json → forkChanges.
