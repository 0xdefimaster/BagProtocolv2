# Durum (kapanış, 25.10.2026)

**Durum değerleri:** `PASS` · `FAIL` · `NOT_RUN` · `BLOCKED_EXTERNAL` · `HUMAN_SIGNATURE_REQUIRED`. Toplam sayılar projenin bittiği anlamına gelmez; her satır ayrı okunmalı.

**Kanıt kökü:** `results/closing-2026-10-25/` (kısaca `C/`).

**Kod commit'leri:**

| Kapsam | Commit |
|---|---|
| Yaşam döngüsü ve sayfa koşuları | `746d456` |
| Gölge ölçüm | `6e23fb5`. Ölçüm dosyalarının hash'leri teslimdekiyle aynı (`manifest.json`) |

Hepsi Node 24.22.0 ile koşuldu.

## Tek sonraki adım (kullanıcı)

```
start.cmd wallet --sdk "C:\...\BagProtocolv2-integ\packages\bag-sdk"
```

**Yeni ve boş** bir MetaMask ya da Rabby hesabıyla dört imza at. Ayrıntılar `README_START_HERE.md`'de. Bu adım, aşağıda `HUMAN_SIGNATURE_REQUIRED` olan tek satırı kapatır.

## Ayrı ayrı üç hedef

| Hedef | Durum | Not |
|---|---|---|
| Kullanıcı EOA'sında kalan USDG için native izin (MetaMask ERC-7715) | **BLOCKED_EXTERNAL** | Grant sonrası `-32603`. Upstream düzeltme doğrulanamadı (`DECISIONS.md` §2). Bu hedef gerçekleşmedi |
| B modeli: ayrı smart account + dönemlik delegasyon, gerçek cüzdan imzasıyla | **HUMAN_SIGNATURE_REQUIRED** | Kod, sayfa ve test anahtarlı uçtan uca akış tamam. Gerçek MetaMask/Rabby imzası henüz yok |
| Composer'sız DCA | **NOT_RUN: kapılar kapalı** | 4 token'lık sepet mevcut router ile fork'ta makbuzla alındı (araştırma kanıtı). DCA'ya bağlamak için gereken fiyat ve planSigner kapıları kapalı |

## Kabul koşulları

### 1. Başlangıç durumu

| Koşul | Durum | Kanıt |
|---|---|---|
| Commit'ler, PR durumu, v5 ZIP hash'i yeniden doğrulandı; manifest'te | PASS | `manifest.json` → `baseline` |
| Ayrı worktree. `main`, uygulama kodu ve `.env.local` değişmedi | PASS | `manifest.json` → `repository.appCodeTouchedVsMain` = [] |

### 2. DCA kuralları (`lib/dca-rules.mjs`, tek uygulama; sayfa ve runner aynı kodu kullanır)

| Koşul | Durum | Kanıt |
|---|---|---|
| BAG, tutar, alım sayısı, periyot (gün/hafta → saniye); doğal dil + kesin tarihler; ilk alım hemen ya da seçilen başlangıçta | PASS | `test/dca-rules.test.mjs` · `C/wallet-fork-page/screens/` |
| `5 × 5 = 25` geçerli; 30 → "Toplam tutar, alım sayısı × alım tutarıyla eşleşmiyor" | PASS | `test/dca-rules.test.mjs` |
| Kayan nokta yok. USDG 6 ondalık ve tanımı zincirden doğrulanıyor. Sıfır, negatif, taşma ve fazla ondalık reddediliyor | PASS | unit testler + P-1 (`C/wallet-fork-test/results.json`) |
| BAG hash, chain, kaynak, alıcı, bütçe, dönem, en fazla alım ve bitiş yetkiye bağlı; BAG değişirse eski izin kullanılamaz | PASS | Plan adresi = CREATE2(terms, program): P-2. Caveat'ler: E-2, X-4…X-9 |
| Kaçırılan dönem birikmez; takvim penceresi (kayan 24 saat değil) | PASS | rules testleri, H-3, H-4 |
| İki keeper aynı pencereyi iki kez tüketemez; başarısız swap hiçbir sayacı tüketmez | PASS | X-1, X-2 |

### 3. Gerçek cüzdan fork akışı (`wallet-fork/`)

| Koşul | Durum | Kanıt |
|---|---|---|
| Runner + imza sayfası yazıldı; test anahtarıyla uçtan uca 30/30 | PASS | `C/wallet-fork-test/results.json` |
| Gerçek `page.js`, Chromium'da enjekte test sağlayıcıyla 4 imza + yaşam döngüsü 30/30. Sınıf `TEST_KEY_VIA_SIGNING_PAGE` | PASS | `C/wallet-fork-page/` |
| Delegasyon yalnızca `USDG.transfer(plan, tutar)` yapabiliyor. `SudoPolicy` yok. Dönem, toplam, çağrı, token, redeemer, alıcı ve bitiş izin katmanında da uygulanıyor. Enforcer bytecode'u sabit | PASS | H-4, H-9, X-5…X-9 · `lib/pins.json` |
| Plan sahibi kullanıcı; iptal ve çekim deploy edene bağlı değil | PASS | H-5c, H-10 |
| Composer onayları plan bakiyesinden. Teslim atomik. Transit adreste bakiye veya onay kalmıyor | PASS | H-1, H-2, H-6 + SDK forwarded `VERIFIED` |
| Özet imzalanacak typed data'dan çözülüyor; uyuşmazlıkta sayfa ve stand-in imza istemiyor | PASS | `lib/sign-checks.mjs` · rules testleri (decode/compare) |
| Loopback sunucu: Host/Origin, oturum sırrı, boyut sınırı, adım eşleşmesi, imzalayan kontrolü | PASS | `test/server.test.mjs` |
| İmzalar özel klasörde. Paylaşılan çıktıda imza yok; runner kendi kendini denetliyor | PASS | "PASS no signature in the shareable output folder" (`C/logs/wallet.log`) |
| Fork'a bağlılık: F*/PM* ana ağda kod ve nonce sıfır. Plan adresi yeniden hesaplanıyor. Paymaster bağı: kodsuzken çalışmıyor, değişince AA24, süresi geçince AA32 | PASS | P-1, P-2, H-5a, H-5b, X-10 |
| Tek izinde: alım → aynı dönemde ret → sonraki dönemde alım → toplam limitte ret | PASS | H-1, H-3, H-4, H-6, H-8, H-9 |
| Çağrı sınırı, süresi geçmiş izin, yanlış token/alıcı/plan, değiştirilmiş program, fazla/kısmi/sıfır harcama, tekrar oynatma | PASS | X-3…X-11, H-5d, H-11 |
| İkinci plan: bütçe kalmışken iptal → ret (`CannotUseADisabledDelegation`) → kalan USDG kullanıcıya | PASS | H-5c, H-7 (`cancelWithBudget`: 5/15 USDG harcanmıştı), H-10 (35 USDG) |
| Reddedilen denemelerde kullanılan iznin sayaçları, bakiyeler, onay ve nonce değişmedi | PASS | her ret kontrolünde `unchanged` |
| **Gerçek MetaMask/Rabby imzasıyla aynı akış** | **HUMAN_SIGNATURE_REQUIRED** | Komut yukarıda |
| Taze Composer teklifiyle (`--live`) yeni runner | NOT_RUN | `LIFI_API_KEY` bu ortamda yok. Kullanıcı: `start.cmd test --live --env-file …`. Eski runner'ın bakımcı canlı koşuları: `results/live-lifecycle-v3-2026-10-24-maintainer/` |

### 4. MetaMask native ERC-7715

| Koşul | Durum | Kanıt |
|---|---|---|
| Native grant | **BLOCKED_EXTERNAL** | `results/metamask-native/` · `DECISIONS.md` §2 |
| Paylaşılmaya hazır rapor (gönderilmedi) | PASS | `metamask/ISSUE_REPORT.md` |

### 5. Gölge ölçüm düzeltmeleri (`shadow/measure.ts` v2)

| Koşul | Durum | Kanıt |
|---|---|---|
| Gerçekleşen çıktı makbuz ve bakiye farkından, Transfer loglarıyla çapraz kontrollü | PASS | `C/shadow/results.json` |
| Kanıt aşamaları: `QUOTED` / `SIMULATED` / `FORK_EXECUTED` / `RECEIPT_VERIFIED` | PASS | aynı |
| Tek blok modu (arşiv RPC) | NOT_RUN | Arşiv RPC yok. Mod kodda var; non-archive RPC'de `ARCHIVE_REQUIRED` ile çıkış 2 doğrulandı |
| Non-archive yedek mod açıkça etiketli | PASS | `blockMode.label = NON_ARCHIVE_PER_UNIT` |
| Keşif, likidite ve `extsload` ölçüm bloğunda; yerleşim doğrulandı | PASS | 452 havuz; 10 havuzda Swap olayıyla birebir eşleşme |
| txHash, makbuz, gas, debit/credit, onay, transit, geri almadan önce iz | PASS | `C/shadow/results.json` (izler ZIP'te) |
| Ayrı hata sınıfları; `NOT_RUN` ve `UNSUPPORTED` PASS sayılmıyor | PASS | `statusCounts` |
| Çıkış kodları; rapor `finally`'de yazılıyor; bilinmeyen kaynak reddediliyor | PASS | Bilinmeyen kaynak → 2 ve `ARCHIVE_REQUIRED` → 2 elle doğrulandı. Sepet başarısızlığı → 4 kod yolu var ama tetiklenmedi |
| Relay ölçümü (iletilen metotlar, reddedilen istekler) | PASS | `relay` |
| Sabitlenmiş araçlar (`npx` yok); typecheck | PASS | launcher (`tsx` 4.23.15) · uygulama TS 5.9.3 ile `tsc` çıkış 0 |
| Boşluklu yol | PASS (Linux) / NOT_RUN (Windows) | Boşluklu yoldan launcher unit 30/30 (Linux, teslim kodu). `start.cmd` Windows'ta denenmedi |
| Eski sonuçlar değiştirilmedi, düzeltme notu eklendi | PASS | `shadow/RESULTS-2026-10-24.md` |

### 6. Fiyat ve hook kapısı

| Koşul | Durum | Kanıt |
|---|---|---|
| Fail-closed `PRICE_POLICY_UNPROVEN` + karar belgesi (kaynak, birim, eskime, USDG değeri, TWAP, tolerans, veri yokken ret) | PASS | `lib/price-gate.mjs`, `test/price-gate.test.mjs` (8), `DECISIONS.md` §4 |
| Hook izin listesi politikası | PASS | `HOOK_NOT_ALLOWLISTED` |
| `ShadowV4Adapter` adversarial testleri | PASS | `test/shadow-adapter.test.mjs` (8 test; 6 korumanın her biri mutasyonla yakalandı) |
| `planSigner` güveni duruyor; router DCA için etkin değil | PASS | `DECISIONS.md` §6, `lib/router-dca-gate.mjs` |

### 7. Composer bağımsızlığı

| Koşul | Durum | Kanıt |
|---|---|---|
| 4 token'lık BAG, Composer kapalı, mevcut router ile fork'ta; makbuz ve bakiye kanıtlı (5 ve 100 USDG) | PASS (araştırma) | `C/shadow/` · `shadow/RESULTS-2026-10-25.md` |
| DCA bağlantısı ayrı modülde; kapı durumu | NOT_RUN: BLOCKED | `routerDca`: `PRICE_POLICY`, `SAME_BLOCK_EVIDENCE`, `PLAN_SIGNER_TRUST`, `ROUTER_PLAN_CONTRACT`, `BAG_REGISTRY`, `V4_ADAPTER` |
| Kyber ve 0x doğrulanmadı → kapsam dışı (spender öz-eşitliği yok, `transaction.to`'ya düşme yok) | PASS (kod) | `shadow/measure.ts` |
| Composer ile sepet karşılaştırması | NOT_RUN | `LIFI_API_KEY` yok |
| 1inch | yok | — |

### 8. SDK

| Koşul | Durum | Kanıt |
|---|---|---|
| `verifyPurchaseReceipt` varsayılanı değişmedi; forwarded mod açık seçim | PASS | Bu teslimde SDK değişmedi (`manifest.json` → `sdk`) |
| Forwarded mod gerçek fork makbuzunda fazla, kısmi ve sıfır harcamayı reddediyor | PASS | X-11 |

### 9–10. Test, rapor, teslim

| Koşul | Durum | Kanıt |
|---|---|---|
| Kanıt sınıfları ayrı; her satırda commit, komut, zaman, girdi ve sonuç yolu | PASS | `RESULTS.md` (kapanış bölümü) |
| Tek launcher (preflight → fork → sayfa → imzalar → sonuç) | PASS | `start.mjs`, `start.cmd` |
| `README_START_HERE.md`, `STATUS.md`, `RESULTS.md`, `manifest.json`, `DECISIONS.md` | PASS | bu klasör |
| Draft PR'lar (merge yok) | PASS | `RESULTS.md` → "Teslim" |
