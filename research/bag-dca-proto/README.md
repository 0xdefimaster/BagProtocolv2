# DCA yetki prototipi (A: EOA + permit, B: smart account + delegasyon)

> **Kapanış (25.10.2026):**
> - Başlamak için `README_START_HERE.md`. Tek giriş noktası `start.cmd` / `node start.mjs`.
> - Durum `STATUS.md`'de, kararlar `DECISIONS.md`'de, kanıt `results/closing-2026-10-25/` altında, hash'ler `manifest.json`'da.
> - Gerçek cüzdan imzalı, kullanılabilir izin akışı `wallet-fork/` altında.
> - Aşağıdaki tablodaki `wallet/serve.mjs`, **bilerek kullanılamayan** imzaları ölçen eski sayfadır; yeni akışın yerine geçmez.

**Yalnızca araştırma amaçlı.** Audit edilmedi. `main`'e ve mevcut alım/satım akışlarına dokunmaz. Gerçek para kullanmaz ve public ağa işlem göndermez: fork'un upstream bağlantısı yalnızca okuma metotlarını kabul eden bir relay üzerinden geçiyor. Zip'te API anahtarı ya da özel anahtar yok. Fork anahtarları her çalıştırmada rastgele üretiliyor.

## Kurulum
```
node --version            # 24.x
npm ci                    # bu klasörde
```
`--repo` için `BagProtocolv2`'nin `e6bdd10` commit'inde bir checkout gerekiyor. O checkout'ta `npm ci` ve `npm run build --prefix packages/bag-sdk` çalıştırılmış olmalı.

## Komutlar
| Komut | Ne yapar | Anahtar |
|---|---|---|
| `node verify-bytecode.mjs <delegation-framework@v1.3.0>` | Kaynak ile zincirdeki deployment'ı ve maskelenen immutable değerlerini karşılaştırır → `out/bytecode-verification.json` | yok |
| `node fork/run.mjs` | Sahte swap ile 34 yetki testi (A ve B, enforcer'lar, iptal, userOp) → `fork/out/results.json` | yok |
| `node composer/run.mjs --repo <repo> --mode replay` | Kayıtlı Composer programı, plan adresine göre yeniden adreslenir. Bu bir Composer yanıtı değil | yok |
| `node composer/run.mjs --repo <repo> --mode live --env-file <repo>\.env.local` | **Gerçek Composer** derlemesi. Anahtar yalnızca dosyadan okunur | `LIFI_API_KEY`, `ROBINHOOD_RPC_URL` |
| `node composer/analyze-signer-dependence.mjs <repo> . <compiled.json> <rpc>` | Composer programında signer'a bağlı byte'ları bulur | yok |
| `node wallet/serve.mjs` → `http://127.0.0.1:8787` | MetaMask/Rabby imza deneme sayfası (yalnızca `eth_signTypedData_v4`) | — |
| `node wallet/print-account.mjs <EOA>` | EOA'nın MultiSig sayaç-hesap adresini yazdırır | yok |

Windows PowerShell örneği:
```
cd C:\path\to\proto
npm ci
node composer/run.mjs --repo C:\Users\<you>\Desktop\BagProtocolv2-dca --mode live --env-file C:\Users\<you>\Desktop\BagProtocolv2-dca\.env.local
```

## Sonuçlar
- `fork/out/results.json`: 34 PASS / 0 FAIL
- `composer/out/replay/results.json`: 26 PASS / 0 FAIL. `acceptance.sdkFullVerification = NOT_MET_…` (açık boşluk, REPORT.md §3)
- `out/bytecode-verification.json`: 9 kontrat MATCH, Hybrid MISMATCH, 27 immutable alanın hepsi EXPECTED
- **Live mod burada çalıştırılmadı** (API anahtarı yok). Sonuçlarını `composer/out/live-*` altında ayrı tutun.
- **Cüzdan sonuçları:** sayfanın indirdiği `wallet-signing-*.json` dosyaları. Fork sonuçlarıyla karıştırmayın.

**Dört sonuç kategorisi (replay, canlı, SDK, cüzdan): `RESULTS.md`. Forwarded SDK modu: `--sdk <PR #126 checkout>/packages/bag-sdk`.**

**Canlı Composer çalıştırma talimatı (commit ve ortam değişkenleri): `RUN_LIVE.md`.**

Ayrıntılar: `REPORT.md`, `DCA_AUTHORIZATION_SPEC.md`, `SOURCES.md`.
