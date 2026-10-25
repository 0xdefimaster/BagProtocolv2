# RecurringPurchaseExecutor kanıtları (25.10.2026)

Kod commit'i: `ea47f31` (dal `claude/dca-keeper-evidence`). Her `results.json` dosyası kendi `build.appCommit` değerini ve artifact kaynak hash'lerini kaydeder.

> **Bu klasör eski kanıttır; güncel kanıt [`../executor-2026-10-25-followup/`](../executor-2026-10-25-followup/README.md) klasöründedir.**
>
> `ea47f31`'deki eksikler:
> - SDK doğrulayıcısı (`verifyRecurringPurchaseReceipt`) yalnızca event ve Transfer kayıtlarına bakıyordu. Gerçek kaynak/alıcı bakiye kontrolleri yalnızca bu koşucudaydı.
> - Executor, imzalanan token/ağırlık listesini BAG'in kayıtlı içeriğine bağlamıyordu.
>
> Buradaki G2 ifadesi ("işlem bazında bakiyeler SDK'da doğrulandı") bu commit için doğru değildi.

| Klasör | Ne | Kanıt sınıfı | Yeniden çalıştırma |
|---|---|---|---|
| `fork/` | Gerçek USDG, Uniswap v3 (SwapRouter02/QuoterV2), BagFactory ve StrategyRegistry ile fork. Composer/LI.FI erişilemez. Yaşam döngüsü, gerçek hatalı yürütmeler, SDK retleri, değiştirilmiş doğrulama beklentileri ve aynı fork'ta uygulamanın keeper'ı | `TEST_KEY_FORK` (K2) | `node research/bag-dca-proto/start.mjs executor --app .` |
| `wallet-page-automated/` | Gerçek imza sayfası (`executor-wallet/page`), Chromium'da otomatik test sağlayıcısı: 3 imza, 2 alım, 2 ret, 1 iptal. `screens/`: her ekranın görüntüsü | `TEST_KEY_VIA_SIGNING_PAGE`. İnsan imzası **değildir** | `executor-wallet/run.mjs --signer wallet` + `wallet-fork/page-e2e.mjs` |
| (yok) | Gerçek MetaMask veya Rabby imzası | `HUMAN_SIGNATURE_REQUIRED` | `start.cmd executor-wallet --app …` (`EXECUTOR_START_HERE.md`) |

Okuma sırası: `fork/summary.md`, `wallet-page-automated/results.json` → `steps`, sonra `docs/dca/INVENTORY_ADDENDUM_2026-10-25.md`.

**Kanıt sınıfları ayrı tutulur:**

- **Gerçek hatalı yürütme (`REAL_FAULT`):** Yanlış bir işlem fork'ta gerçekten gönderildi ve mine edildi.
- **Değiştirilmiş beklenti (`ALTERED_EXPECTATION`):** İyi bir makbuz, yanlış bir beklentiyle doğrulayıcıya verildi.
- **`SDK_REFUSAL`:** SDK plan kurmayı reddetti.

Bu sınıfların sayıları birbirine eklenmez.

**Bu klasörde olmayanlar:**

- Paylaşılabilir dosyalarda imza yoktur; yalnızca imza hash'leri vardır. Kullanılabilir imzalar git'e girmeyen `executor-wallet/private/` klasöründedir.
- Fork önbelleği (`cache/`) git'e girmez.
