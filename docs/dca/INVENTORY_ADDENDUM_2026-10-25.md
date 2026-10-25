# BAG DCA envanteri — ek (25.10.2026): #128/#129 eşlemesi ve Composer'sız yürütme katmanı

Bu ek, "BAG DCA ve yürütme katmanı: kaynaklara bağlı envanter" belgesinin 4.1–4.4 bölümlerine bağlanır. Önceki araştırma yeniden yazılmadı. Her satır bir commit'e, dosyaya ve kanıt sınıfına bağlıdır.

**Kanıt sınıfları:** Envanterdeki K0–K4 kullanılır. Ayrıca imzayı kimin attığı ayrı etiketlenir:

- `TEST_KEY`: süreç içinde üretilen anahtar
- `TEST_KEY_VIA_SIGNING_PAGE`: gerçek imza sayfası, otomatik test sağlayıcısı
- `HUMAN_WALLET_SIGNATURE`: gerçek cüzdan, insan

Bu üç sonuç birbirinin yerine geçmez. Eski PASS sayıları yeni uygulamanın kanıtı sayılmaz.

## 1. #128 ve #129 gerçekte neyi kapattı

| PR | Head | Araştırma geçmişi | Dosyalar | Kanıt | Katkı | Kapattığı kapı |
|---|---|---|---|---|---|---|
| [#128](https://github.com/0xdefimaster/BagProtocolv2/pull/128) (draft) | `f40d159` | `71fe34f`, `746d456`, `c5ad0b3` | `research/bag-dca-proto/{wallet-fork,fork,composer,lib,metamask}` | K2 `TEST_KEY` (30/30), K2 `TEST_KEY_VIA_SIGNING_PAGE` (30/30). MetaMask native: `BLOCKED_EXTERNAL` | **T03-B** araştırması: ayrı MultiSigDeleGator ve dönemlik delegasyon, fork yaşam döngüsü. **T01** kısmi: `lib/dca-rules.mjs` (5×5=25, takvim penceresi). **T07** kısmi: B için imza sayfası | Hiçbiri tam değil. B, DR-03'ü (fonlar mevcut adreste) karşılamaz. G3 açık (`HUMAN_SIGNATURE_REQUIRED`) |
| [#129](https://github.com/0xdefimaster/BagProtocolv2/pull/129) (draft, #128 üstüne) | `354adfd` | `74c06a6`, `6e23fb5`, `843f560`, `8d34d87`, `e0c3111`, `353ff7b`, `4e310c9` | `research/bag-dca-proto/{shadow,lib/price-gate.mjs,lib/router-dca-gate.mjs,test}` | K2 `TEST_KEY`: makbuzla doğrulanmış gölge ölçüm | **T04** kısmi: v3/v4 rota ölçümü; mevcut router'la 4 token'lık sepet fork'ta alındı (5 ve 100 USDG); fiyat kapısı fail-closed | Hiçbiri. G2 kapanmadı: BagFactory mock'tu, SDK tüketicisi yoktu, planSigner güveni sürüyordu, fiyat politikası kanıtlanmamıştı |

Bu iki PR'ın açık bıraktığı Composer'sız kapılar (`lib/router-dca-gate.mjs`):

- `PRICE_POLICY`
- `PLAN_SIGNER_TRUST`
- `ROUTER_PLAN_CONTRACT`
- `BAG_REGISTRY`
- `SAME_BLOCK_EVIDENCE`
- `V4_ADAPTER`

Bu turda her biri ayrı ayrı ele alındı (bölüm 3).

## 2. Bu turun işleri (yeni draft PR'lar)

| İş | Commit | Dosyalar | Çalıştırılan | Sınıf |
|---|---|---|---|---|
| T02 yetki ve sayaç çekirdeği | `21eb684` | `contracts/dca/IRecurringPurchaseExecution.sol`, `contracts/dca/RecurringPurchaseExecutor.sol` | Hardhat 47 test (mutasyon kontrolüyle). Fork senaryoları (bölüm 3) | K1 + K2 `TEST_KEY` |
| T03-A fonlama (EOA + approve/permit) | `21eb684` | `_fund()` ALLOWANCE yolu; DELEGATION yolu ayrı | Gerçek USDG permit'i ve front-run'ı fork'ta (L1, U1, V2) | K2 `TEST_KEY`. DELEGATION yalnızca K1 mock |
| T06 SDK | `8de9070`, `0b03772` | `packages/bag-sdk/src/recurring.ts`, `src/adapters/uniswap-v3.ts`, `RECURRING_EXECUTOR_ABI` | SDK 303/303. Paket release check `PACKAGE_CHECKS_PASSED`. Bağımsız tüketici tarball'dan `recurring: VERIFIED` (sentetik) | K1 |
| T04 fiyat ve doğrudan rota | `21eb684`, `0b03772` | Zincirde `AssetLimit.maxPriceRaw`; SDK teklifleri sahibin sınırıyla sınırlı | Fork M1–M4 | K2 `TEST_KEY` |
| T05 keeper | `bda1464` | `lib/dca/keeper/*` | Hardhat 11 test (gerçek executor). Vitest 5 (store/takvim). Fork K1–K6 | K1 + K2 `TEST_KEY` |
| T07 imza ve UI | `ea47f31` | `research/bag-dca-proto/executor-wallet/*`, `EXECUTOR_START_HERE.md` | Gerçek sayfa Chromium'da otomatik sağlayıcıyla 9/9. Değişiklik kontrolü testleri 4/4 | `TEST_KEY_VIA_SIGNING_PAGE`. İnsan: **yok** |
| T08 bağımsız örnek ve kanıt paketi | `ea47f31` (runner), `0b03772` (örnek) | `research/bag-dca-proto/executor-fork/{run,setup}.mjs`, `examples/sdk-consumer/src/recurring.ts` | Composer kapalı fork koşusu: yalnızca SDK dist ve derlenmiş kontratlar; BAG frontend ve veritabanı yok | K2 `TEST_KEY` |
| Altyapı | `eb6bafd` | `tsconfig.json` (`research` hariç) | `npm run typecheck` temiz (önceden #129 yüzünden 78 hata) | K0 |

Kanıt dosyaları (bu eki ekleyen commit): `research/bag-dca-proto/results/executor-2026-10-25/`.

## 3. Composer'sız kapılar: ayrı ayrı

| Kapı | Durum | Kanıt | Sınır |
|---|---|---|---|
| `ROUTER_PLAN_CONTRACT` | **Kapandı (fork)** | `RecurringPurchaseExecutor`, mevcut `BagExecutionRouter`'ı `wallet` olarak sarar | Router değişmedi |
| `PLAN_SIGNER_TRUST` | **Yetki sınırı DCA yolu için kapandı (fork). Hizmet bağımlılığı sürüyor** | Gerçek planSigner anahtarıyla imzalanmış 12 kötü plan reddedildi (P1–P12): alıcı, minimum, tutar, BAG, hedef, token, kısmi dolum, bacak kaydırma, pencere, eski teklif, sahte imza, şart değiştirme. Her biri mine edildi; durum değişmedi; ardından aynı pencerede dürüst alım geçti | İki ayrı konu (bölüm 8). (1) Yetki: planSigner imzalanan sınırları aşamaz. (2) Bağımlılık: Composer kullanılmıyor, ama her alım planSigner imzası ve keeper işlemi gerektirir. Bunlar çalışmazsa veya reddederse alımlar durur ya da gecikir; sınır içinde daha kötü bir rota da seçebilirler |
| `BAG_REGISTRY` | **Kapandı (fork, gerçek kontratlar)** | Gerçek BagFactory ve StrategyRegistry. a3caff05 için v1 imzası, zincirdeki v2'ye karşı `BagChanged` (gerçek geçmiş). Yanlış tanım → `StrategyNotRegistered`. Bilinmeyen BAG → `UnknownBag`. Kayıtlı v2 → kayıt kontrolleri geçti. **`ea47f31`'de eksikti, `8b253da`'da eklendi:** imzalanan token/ağırlık listesi BAG'in kayıtlı içeriğine bağlı. Gerçek 955df6e0 kimliği başka bir listeyle → `CompositionMismatch` (R7, R8; bölüm 8) | 955df6e0 StrategyRegistry'de yok; onun `definitionHash`'i yalnızca imzada ve SDK'da bağlı |
| `PRICE_POLICY` | **Kısmi** | Sahibin imzaladığı varlık başına azami fiyat zincirde uygulanıyor. Piyasa kayınca: eski plan revert etti (M1), SDK plan kurmadı (M2), planSigner'ın piyasa minimumu reddedildi (M3), calldata minimumu 0 olsa da ölçülen çıktı reddedildi (M4) | **Bağımsız piyasa referansı yok** (4663'te doğrulanmış oracle bulunamadı). Testteki sınır aynı AMM'nin teklifinden türetildi; bu bir adil fiyat kanıtı değildir. **Davranış:** Sınır sabit bir tavandır, güncel fiyata göre kayma koruması değildir. Tavan aşılınca o dönemin alımı yapılmaz ve telafi edilmez. Bu artık kullanıcıya ve keeper kaydına açıkça gösteriliyor (bölüm 8) |
| `SAME_BLOCK_EVIDENCE` | **Alım için kapandı** | Her alım tek işlemde ve tek fork bloğunda atomik | Kaynaklar arası aynı blok karşılaştırması tekrarlanmadı (arşiv RPC yok) |
| `V4_ADAPTER` | **Kapsam dışı (bilinçli)** | Executor yalnızca SwapRouter02 `exactInputSingle` (v3) kabul ediyor; UniversalRouter hedefi reddedildi (P5) | a3caff05 v3'le alınamıyor (HII'nin USDG v3 havuzu yok → `NO_ROUTE`, S1). v4 veya çok adımlı rota ayrı iştir |

## 4. Kapılar (G0–G6) bu turdan sonra

| Kapı | Durum | Neden |
|---|---|---|
| G0 | Güncellendi | Bu belge |
| G1 | **A modeli için K1 + K2 sağlandı** | Erken, tekrar, iptal sonrası ve sınır dışı alımlar reddedildi; zorunlu kontrol başarısız olunca token ve sayaçlar geri alındı (fork F1–F3, V2, V5). Bağımsız kod incelemesi yapılmadı. DELEGATION adaptörünün K2 kanıtı yok |
| G2 | **K2 `TEST_KEY` ile sağlandı (955df6e0, v3)** | Composer/LI.FI isteği 0. Gerçek USDG, Uniswap v3, BagFactory ve StrategyRegistry. Taze rota. İşlem bazında kaynak ve alıcı bakiyeleri SDK'da doğrulandı. Commit, artifact kaynağı ve strateji hash'leri kayıtlı. Kapsam dışı: ücretli BAG'ler, v4, çok adımlı rota |
| G3 | **Açık: `HUMAN_SIGNATURE_REQUIRED`** | Başlatıcı, şartlar ve beklenen sonuç hazır (`research/bag-dca-proto/EXECUTOR_START_HERE.md`). Otomatik sayfa koşusu insan imzası yerine geçmez |
| G4 | **K1 + K2 `TEST_KEY` ile sağlandı** | Sayaçlar zincirden okunuyor. Yeniden başlatma, kayıp store, gönderimden önce/sonra çökme, düşen işlem, iki keeper, gas ve fon yetersizliği, pencere sınırı test edildi. Kapsam dışı: üretim veritabanı ve izleme/alarm |
| G5 | Yapılmadı | Public işlem ve gerçek fon yok |
| G6 | Açık | Üretim dağıtımı, inceleme, fiyat kaynağı ve ücret muhasebesi |

## 5. Ürün kararı gereken noktalar (proje sahibi)

1. **DR-03 fonlama modeli.** A modeli fonları kullanıcının adresinde tutar. Güven sınırı şudur: değiştirilemez executor, kalan allowance'ın harcayıcısıdır; bu allowance sahibin bütün yetkileri arasında paylaşılır, sınırları sayaçlar uygular. B (ayrı smart account) bu şartı karşılamaz. Seçim proje sahibinindir.
2. **Fiyat politikası.** Bağımsız oracle olmadan, kullanıcının imzaladığı varlık başına azami fiyat kabul edilebilir bir politika mı? Kabul edilirse, varsayılan tampon ve kullanıcıya nasıl gösterileceği de karara bağlanmalı.
3. **Ücretli BAG'ler.** a3caff05 `performanceFeeBps: 1000`. SDK bunları reddediyor; executor ücreti zincirde göremez. Ücret muhasebesi (DCA alımlarının maliyet tabanı) çözülmeden kapsam dışı kalır.
4. **Rota kapsamı.** Yalnızca v3 tek adım. Hangi BAG'lerin desteklendiği bu yüzden sınırlı.
5. **Üretim executor dağıtımı.** Sahipsiz ve yükseltilemez. Dağıtım ayrı bir karar; yapılmadı.

## 6. Kod dışı eksikler

| Eksik | Etki |
|---|---|
| Gerçek insan imzası (MetaMask, Rabby) | G3 |
| Arşiv RPC | Kaynaklar arası tek blok karşılaştırması. Public RPC'de fork bloğu zamanla budanır |
| `LIFI_API_KEY` | Yalnızca Composer karşılaştırması; G2 için gerekmez |
| Bağımsız inceleyici atanmadı | G1 ve G6 incelemesi |
| Public deneme ve yetki | G5 |

## 7. Önceden var olan sorunlar (bu turda değiştirilmedi)

- `contracts/test/BagSdkRegistry.test.ts`'deki 2 test, değiştirilmemiş `main` `82b3b29`'da da başarısız. Bu dallarda Hardhat sonucu: 231 geçen, 2 kalan (aynı ikisi).
- `npm run typecheck`, #129'un araştırma TypeScript'i yüzünden kırıktı; `eb6bafd` ile düzeltildi.
