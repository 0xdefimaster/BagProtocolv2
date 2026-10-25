# Canlı Composer ile çalıştırma (A ve B modelleri)

Bu adımlar yalnızca izole bir yerel fork üzerinde çalışır. **Public ağa işlem gönderilmez**, gerçek para kullanılmaz. Composer API'ye yalnızca derleme (compile) istekleri gider.

## 1. Gerekenler
| | |
|---|---|
| Node | **24.x** (24.22.0 ile test edildi) |
| BAG repo commit'i | `0xdefimaster/BagProtocolv2` → **`e6bdd1057f4cb68d492e2c503736d7e30d24b0c0`** (`codex/app-dca-local-trial`, PR #125) |
| Ortam dosyası | Mevcut `.env.local`. Runner bu dosyadan **yalnızca** şu değişkenleri okur: |
| `LIFI_API_KEY` | **zorunlu** (Composer derlemesi) |
| `ROBINHOOD_RPC_URL` | **zorunlu**. Yoksa sırayla `ROBINHOOD_RPC_URL_SECONDARY`, sonra `RPC_URL_ROBINHOOD` denenir. Birden fazla tanımlıysa `quiknode.pro` adresi tercih edilir |

Anahtar komut satırında verilmez ve hiçbir çıktı dosyasına yazılmaz. Hata mesajlarında RPC adresleri ve anahtar `<redacted>` / `<url>` olarak maskelenir.

## 2. Repo checkout'u (mevcut çalışma kopyanızı değiştirmeden)
```powershell
cd C:\Users\<you>\Desktop\BagProtocolv2
git fetch origin codex/app-dca-local-trial
git worktree add ..\BagProtocolv2-dca e6bdd1057f4cb68d492e2c503736d7e30d24b0c0
cd ..\BagProtocolv2-dca
git rev-parse HEAD            # e6bdd1057f4cb68d492e2c503736d7e30d24b0c0 olmalı
npm ci
npm run build --prefix packages/bag-sdk
```

## 3. Prototip
```powershell
cd C:\path\to\proto           # ZIP'ten çıkan klasör
npm ci
```

## 4. Çalıştırma
```powershell
# Canlı Composer: A ve B modelleri
node composer/run.mjs --repo ..\BagProtocolv2-dca --mode live --env-file C:\Users\<you>\Desktop\BagProtocolv2\.env.local

# İsteğe bağlı, anahtar gerekmez: aynı makinede replay ve mock testleri
node composer/run.mjs --repo ..\BagProtocolv2-dca --mode replay
node fork/run.mjs
```
Süre birkaç dakika: 6 Composer derlemesi ve fork'ta 4 alım.

## 5. Çıktı ve beklenen sonuç
`composer/out/live-<zaman>/` altına yazılır:
- `results.json`: bütün testler, fork bloğu, kaynak hash'leri, `acceptance` alanı
- `*-trace.json`: her alımın call trace'i
- `*-sdk-verify.json`: SDK'nın ham kararı

Son satır şu biçimde olur:
```
SUMMARY mode=live pass=<n> fail=<m> sdkFullVerification=<...>
```
- **`sdkFullVerification=NOT_MET_UNCHANGED_SDK_MEASURES_FORWARDING_SIGNER` beklenen sonuç.** Bu boşluğu SDK değişikliği kapatacak. Canlı sonucun neyi kanıtladığına `*-sdk-binding` ve `*-delivery` testleri bakar.
- **Özellikle bakılacaklar:**
  - **T-1 ve A-2/B-2:** Composer, henüz deploy edilmemiş plan adresi için derleme yapıyor mu, ve şablon placeholder şablonuyla aynı mı?
  - **A-4/B-4:** Taze teklif fork'ta çalışıyor mu?
- Composer teklifleri zamanla bayatlar. Fork zamanı en fazla birkaç dakika ileri sarılır.

## 6. Bize gönderilecek
`composer/out/live-<zaman>/` klasörünün tamamı. İçinde anahtar ya da RPC adresi yok. Gönderirken yine de bir kez `results.json` içinde `LIFI` ve `http` arayarak kontrol edin.

## Sonuçları ayrı tutun
| Sonuç | Yer |
|---|---|
| Mock fork (34 test) | `fork/out/results.json` |
| Replay (kayıtlı program) | `composer/out/replay*/results.json` |
| **Canlı Composer** | `composer/out/live-*/results.json` |
| SDK doğrulaması | her `results.json` içindeki `sdkVerdicts` ve `acceptance` (SDK değişikliğinden sonra ayrı rapor) |
| Cüzdan imzaları | `wallet/sign-test.html` → indirilen `wallet-signing-*.json` |
