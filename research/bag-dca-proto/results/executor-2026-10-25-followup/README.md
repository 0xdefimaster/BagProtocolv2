# RecurringPurchaseExecutor kanıtları, takip turu (25.10.2026 akşam)

Bu klasör `../executor-2026-10-25/` klasörünün yerine geçer. Oradaki kanıt `ea47f31` içindir ve iki eksiği vardı:

- **SDK doğrulaması:** Yalnızca event ve Transfer kayıtlarına bakıyordu.
- **BAG–içerik bağlantısı:** İmzalanan liste BAG'in kayıtlı içeriğine bağlı değildi.

Her `results.json` kendi `build.appCommit` değerini, artifact kaynak hash'lerini ve SDK dist hash'lerini kaydeder.

| Klasör | Ne | Kanıt sınıfı | Yeniden çalıştırma |
|---|---|---|---|
| `fork-lifecycle/` | Yaşam döngüsü (izin ve approve ile alım, iptal), zamanlama ve iptal hataları, 12 kötü plan, değiştirilmiş doğrulama beklentileri (E0–E6) | `TEST_KEY_FORK` (K2) | `node research/bag-dca-proto/start.mjs executor --app .` (üç aşamayı sırayla çalıştırır) |
| `fork-registry/` | Gerçek BagFactory ve StrategyRegistry: sürüm, bileşim, **gerçek 955df6e0 kimliği başka bir listeyle (R7, R8)**, SDK reddi (R9). Rota kapsamı (S1). Piyasa kayması (M1–M4) | `TEST_KEY_FORK` (K2) | aynı komut, `--phase registry` |
| `fork-keeper/` | Yoğun blokta kanıt kapsamı (B1). Keeper (K1–K7). K7: sabit fiyat tavanı gerçek havuzlarla aşılınca dönem atlanır, kaydedilir, telafi edilmez | `TEST_KEY_FORK` (K2) | aynı komut, `--phase keeper` |
| `wallet-page-automated/` | Gerçek imza sayfası, Chromium'da otomatik test sağlayıcısı. İki uyarı ve onay kutusu gösterildi; 3 imza, 2 alım, 2 ret, 1 iptal. `screens/`: her ekranın görüntüsü | `TEST_KEY_VIA_SIGNING_PAGE`. İnsan imzası **değildir** | `executor-wallet/run.mjs --signer wallet` + `wallet-fork/page-e2e.mjs` |
| (yok) | Gerçek MetaMask veya Rabby imzası | `HUMAN_SIGNATURE_REQUIRED` | `start.cmd executor-wallet --app …` (`EXECUTOR_START_HERE.md`) |

## Neden üç ayrı fork

Public Robinhood RPC, bir bloğun durumunu yaklaşık 6.000–8.000 blok (≈10 dakika) tutuyor. Fork, yeni okunan her depolama yuvasını sabitlenen fork bloğundan çeker; executor'ın yeni yetki yuvaları da buna dahil. Bütün senaryolar tek fork'ta yaklaşık 11 dakika sürdü. Bu yüzden koşu `historical state … is not available` hatasıyla `EXTERNAL` (çıkış 3) bitti. Bu turda üç tek-fork denemesi bu yüzden kesildi.

Her aşama artık kendi taze fork'unda çalışıyor. Arşiv RPC ile `--phase all` tek fork'ta hepsini çalıştırır.

## Alım doğrulaması nasıl yapıldı

- **SDK `verifyRecurringPurchase`:** Mine edilen calldata, koşucunun hazırladığı çağrıyla bayt bayt aynı olmalı (`PREPARED_INTENT`). Plan yetkiye karşı yeniden kontrol edilir. `PurchaseExecuted` event'i eşleşmeli.
- **Bakiyeler:** Kaynak borcu, alıcı teslimleri ve executor/router kalıntısı, işlem kapsamlı bakiyelerden okunur. Okuyucu `SINGLE_TRANSACTION_BLOCK`: üst blokta ve alım bloğunda `balanceOf`. Yalnızca alım bloktaki tek işlemse geçerlidir. B1, yoğun blokta bu okuyucunun `INDETERMINATE` döndüğünü gösterir.
- **Bağımsız ikinci kontrol:** Koşucunun kendi bakiye okumaları SDK sonucuyla karşılaştırıldı (`sdkSourceDebitEqualsFork`, `sdkDeliveriesEqualForkBalances`).
- **Kapsam dışı:** Robinhood Chain'in kendisinde alım doğrulaması. Bunun için qualified Nitro okuyucusu (`ROBINHOOD_NITRO_TRANSACTION_INDEX`) gerekir; bu koşularda denenmedi.

## Bu klasörde olmayanlar

- Paylaşılabilir dosyalarda imza yoktur; yalnızca imza hash'leri vardır. Kullanılabilir imzalar git'e girmeyen `executor-wallet/private/` klasöründedir.
- Fork önbelleği (`cache/`) git'e girmez.
