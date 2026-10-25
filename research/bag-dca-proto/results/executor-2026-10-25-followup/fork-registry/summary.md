# RecurringPurchaseExecutor fork kanıtı

| | |
|---|---|
| Aşama | registry (her aşama kendi fork'unda: public RPC fork bloğunun durumunu ~10 dakika tutuyor) |
| Kanıt sınıfı | **TEST_KEY_FORK**: yalnızca bu süreçte üretilen test anahtarları. Cüzdan, insan imzası veya public işlem değildir |
| Çıkış | 0 COMPLETE |
| Uygulama commit'i | `7008d18df6b4aeaf31bf7060f7a22872b619a802` (contracts/ ve SDK src kirli mi: hayır) |
| Fork | blok 97881875 (`0xe918ae99a2f586589e8f099a8802430c19f976d94e6c588851c27051da46dab3`), tek fork bloğu; her alımın bütün bacakları tek işlemde |
| Executor | `0x008f01d056eb06d708eaeC1e2e27B82435910CB9` (anahtarsız; 4663'te kod 0x, nonce 0). Runtime artifact ile eşleşiyor: true |
| Gerçek kontratlar | USDG (impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F`), SwapRouter02, QuoterV2, BagFactory, StrategyRegistry. Router: uygulamanın BagExecutionRouter'ı, gerçek BagFactory ile; owner ve planSigner test anahtarı |
| Alım doğrulaması | SDK `verifyRecurringPurchase`: mine edilen calldata bu koşucunun hazırladığı çağrıyla bayt bayt aynı (PREPARED_INTENT); kaynak borcu, alıcı teslimleri ve executor/router kalıntısı işlem kapsamlı bakiyelerden (okuyucu: SINGLE_TRANSACTION_BLOCK; yalnızca bloktaki tek işlem için geçerli). Koşucunun kendi bakiye okumaları ikinci, bağımsız kontrol. Gerçek zincir için Nitro okuyucusu bu koşuda denenmedi |
| Fiyat sınırı | Sahibin imzaladığı varlık başına azami fiyat. Testte: kurulumda gerçek zincirdeki en iyi QuoterV2 teklifi + 300 bps (A/B/C, keeper) veya + 100 bps (P). Bağımsız piyasa referansı **değildir** |
| Ağ | Composer/LI.FI isteği: **0**; reddedilen host: 0; upstream okuma: 654; relay'in reddettiği yazma: 0; public yazma: 0 |

## Gerçek hatalı yürütme (fork'ta gönderildi ve mine edildi): 11/11

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| R1-a3caff05-signed-for-v1 | BAG_REGISTRY | authorization for a3caff05 version 1 (BagFactory history, block 92213308); the creator recorded v2 → BagChanged(2, current hash) | reverted (mined): BagChanged(2,0x2dbb1733ab3eb7f0a632d5a7ac51056625d2050bedfe9ee85ad2b9e0d935cde0) | true | PASS |
| R2-a3caff05-v2-registry-passes | BAG_REGISTRY | a3caff05 v2 with the registered strategyId and definitionHash: BagFactory and StrategyRegistry checks pass; the call stops at the plan check → PlanMismatch(5) | reverted (mined): PlanMismatch(5) | true | PASS |
| R3-a3caff05-wrong-definition | BAG_REGISTRY | a3caff05 v2 with another definitionHash → StrategyNotRegistered | reverted (mined): StrategyNotRegistered(0x72ec1d37c03f9bfb3dc369cf77f19841e7d0a7ca00ca3757605d97fb2f398cae,2) | true | PASS |
| R4-unknown-bag | BAG_REGISTRY | bagId not in BagFactory → UnknownBag | reverted (mined): UnknownBag(0x7d3114750f8342b1f512067eb9c9460beebdd01cbd9988ca7d89a5649e4398f4) | true | PASS |
| R5-955df6e0-wrong-composition | BAG_REGISTRY | 955df6e0 with a3caff05's composition hash → BagChanged(1, real hash) | reverted (mined): BagChanged(1,0xb01f70750ffa0fbcecf99958683aac3ceca89ff55e18f09913ecbf3dde5e0148) | true | PASS |
| R7-955df6e0-with-a3caff05-list | BAG_REGISTRY | 955df6e0 id, version and its REAL composition hash, signed with a3caff05's asset list (the SDK refuses to build this) → CompositionMismatch(signed list, registered) | reverted (mined): CompositionMismatch(0x2dbb1733ab3eb7f0a632d5a7ac51056625d2050bedfe9ee85ad2b9e0d935cde0,0xb01f70750ffa0fbcecf99958683aac3ceca89ff55e18f09913ecbf3dde5e0148) | true | PASS |
| R8-955df6e0-weights-swapped | BAG_REGISTRY | 955df6e0 with its own tokens but two weights swapped (same total) → CompositionMismatch | reverted (mined): CompositionMismatch(0xf3f18771f1773c893c28bd00701d7268fded80cc9b36aac0d337177e298a1478,0xb01f70750ffa0fbcecf99958683aac3ceca89ff55e18f09913ecbf3dde5e0148) | true | PASS |
| R6-955df6e0-claims-registered | BAG_REGISTRY | 955df6e0 is not in StrategyRegistry; naming its derived strategyId → StrategyNotRegistered | reverted (mined): StrategyNotRegistered(0x37f16d57d87fcda8bc3c1863fc5b3d75fb7ad5e5ba89060ff20ce56b27be40eb,1) | true | PASS |
| M1-pre-move-plan-after-move | PRICE_POLICY | the plan quoted before the move, honestly signed, is submitted after it: the swap cannot meet the minimum → reverted, nothing changes | reverted (mined): Error(Too little received) | true | PASS |
| M3-planSigner-accepts-market | PRICE_POLICY | planSigner signs the post-move market price as the COIN minimum (below the owner limit) → RouteViolation(coin,11) | reverted (mined): RouteViolation(2,11) | true | PASS |
| M4-calldata-min-zero | PRICE_POLICY | planSigner keeps the router minimum at the owner floor but sets calldata amountOutMinimum = 0: the swap executes at the moved price and the measured-output check reverts it | reverted (mined): InsufficientOutput(0x6330D8C3178a418788dF01a47479c0ce7CCF450b,10398044732306698,11197086736921471) | true | PASS |

## SDK reddi (plan veya yetki kurulmadı): 4/4

| Senaryo | Kapı | Beklenen | Gözlenen | Durum değişmedi | Sonuç |
|---|---|---|---|---|---|
| R0-sdk-refuses-fee-bearing-bag | FEE_SCOPE | a3caff05 declares performanceFeeBps 1000: the SDK refuses to build an authorization (fee-bearing BAGs are outside the first scope) | RECURRING_TERMS_INVALID: strategies with a performance fee are not supported by recurring purchases yet. | — | PASS |
| R9-sdk-refuses-other-list | BAG_REGISTRY | the SDK refuses before signing when the bag.json assets do not reproduce the registered composition: (a) 955df6e0's document with a3caff05's registered hash, (b) 955df6e0 with one symbol changed in its metadata | (a) RECURRING_TERMS_INVALID: the bag.json assets do not reproduce registry.compositionHash: this document is not the registered content of that Bag version. \| (b) RECURRING_TERMS_INVALID: the bag.json assets do not reproduce registry.compositionHash: this document is not the registered content of that Bag version. | — | PASS |
| S1-a3caff05-no-v3-route | ROUTE_SCOPE | a3caff05 v2 cannot be bought with v3 exactInputSingle: some asset has no USDG pool at any allowed tier → NO_ROUTE | NO_ROUTE: No allowed Uniswap v3 fee tier quoted 0xeb61c0ed490a367d4e3631ccf8a74b3bfc7e775d. | — | PASS |
| M2-sdk-refuses-after-move | PRICE_POLICY | fresh quotes are below the owner limit → PRICE_LIMIT_NOT_MET, no plan | PRICE_LIMIT_NOT_MET: COIN (0x6330d8c3178a418788df01a47479c0ce7ccf450b): the pool price is at or above the FIXED max price 166293255 at every allowed fee tier; no purchase in this window (not made up later). | — | PASS |

Fork'a özel durum değişiklikleri (14): ARBSYS, GAS, IMPERSONATE, SET_CODE, SNAPSHOT, REVERT. Ayrıntı: results.json → forkChanges.
