# Sonuçlar

## Kapanış koşuları: 25.10.2026

**Ortak bilgiler:**
- Node 24.22.0 (resmi linux-x64 tarball). Fork: Robinhood Chain 4663, public RPC (arşiv değil), salt okuma relay'i.
- Girdi fixture'ı BAG `955df6e0…`:
  - `bag.json` sha256 `f77ed80c3d85d916…`
  - `probe-compiled.json` sha256 `bae76f3205486f1c…`
  - definitionHash `0x5d6118db…`
- SDK `dadef00` (#126 + #127, build edilmiş). Uygulama `82b3b29`.
- Ham dosyalar `results/closing-2026-10-25/` altında, hash'leri `manifest.json`'da. **Bu sayılar yalnızca belirtilen commit'in sonucudur;** eski sayılar buraya kopyalanmadı.

| Kanıt sınıfı | Commit | Komut | Zaman (UTC) | Sonuç | Ham sonuç |
|---|---|---|---|---|---|
| Birim (saf JS + yerel EDR'de mock'lar) | `746d456` | `node start.mjs test …` içindeki birim adımı | 02:46 | **30/30** | `unit/node-test.txt` |
| Kayıtlı Composer replay + test anahtarı + fork'ta gerçek EntryPoint `handleOps` | `746d456` | `node start.mjs test --sdk <dadef00>/packages/bag-sdk` | 02:46:49–02:49:06 | **30 PASS / 0 FAIL**, 3 alım, 2 userOp | `wallet-fork-test/results.json`, `traces/` |
| Gerçek imza sayfası (`page.js`, Chromium, enjekte test sağlayıcı) + aynı yaşam döngüsü. Sınıf `TEST_KEY_VIA_SIGNING_PAGE` | `746d456`; sürücü `page-e2e.mjs` `c5ad0b3`'teki tek satırlık bekleme düzeltmesiyle | `node start.mjs wallet --sdk … --no-open --url-file …` + `node wallet-fork/page-e2e.mjs --url-file … --shots …` | 02:46:01–02:49:12 | **30 PASS / 0 FAIL**; 4 imza sayfa üzerinden; paylaşılan çıktıda imza yok | `wallet-fork-page/` (`results.json`, `screens/`) |
| Fork'ta doğrudan yürütme: zincir üstü kaynaklar + mevcut router (gölge v2) | `6e23fb5` | `node start.mjs shadow --app <BagProtocolv2 @82b3b29>` | 02:42:18–02:45:52 | **COMPLETE (çıkış 0)**; iki sepet `RECEIPT_VERIFIED`; kapı `PRICE_POLICY_UNPROVEN`; Composer'sız DCA `BLOCKED` | `shadow/` (`results.json`, `summary.md`) · `shadow/RESULTS-2026-10-25.md` |
| Gerçek MetaMask/Rabby imzası | — | `start.cmd wallet …` (kullanıcı) | — | **HUMAN_SIGNATURE_REQUIRED** | — |
| Taze Composer teklifi (yeni runner, `--live`) | — | `start.cmd test --live --env-file …` | — | **NOT_RUN** (`LIFI_API_KEY` yok) | — |
| MetaMask native ERC-7715 | — | (kullanıcının 25.10 denemesi) | — | **BLOCKED_EXTERNAL** | `results/metamask-native/` |

**Notlar:**
- **Önceki stand-in koşusu:** `6e23fb5`'teki `fake-wallet.mjs` koşusu da 30/30 geçti. O sürüm otomatik imzalayanı `HUMAN_SIGNATURE` diye etiketliyordu. Etiket düzeltildi (`746d456`), o koşu kanıta alınmadı; yerine gerçek sayfayla yapılan koşu konuldu.
- **Geliştirme koşuları:** Node 22.22.0'da da geçti (`dev-run5`: test 29/29; `k4b`: stand-in 29/29). X-11 o koşulardan sonra eklendi.
- **İmza sızıntısı:** Geliştirme sırasında insan modunda alım izlerinin (`traces/H-*.json`) `run()` calldata'sı içinde delegasyon imzasını taşıdığı görüldü. Artık bu izler özel klasöre yazılıyor ve runner paylaşılan çıktıyı imzaya karşı tarıyor.

### Teslim
- **Draft PR'lar** (merge yok, sırayla incelenir):
  1. https://github.com/0xdefimaster/BagProtocolv2/pull/128: cüzdan/fork akışı, DCA kuralları, launcher, imza sayfası (base `main`). Gölge ölçüm burada v5 halindedir.
  2. https://github.com/0xdefimaster/BagProtocolv2/pull/129: gölge ölçüm düzeltmeleri, fiyat ve hazırlık kapıları, adaptör testleri, kapanış dokümanları (base #128).
- **Kanıtı üreten commit'ler:** `claude/dca-wallet-fork-research` dalında, tam geçmişle (`71fe34f` → `6e23fb5` gölge → `746d456` yaşam döngüsü → `c5ad0b3` sayfa sürücüsü → kanıt ve manifest commit'leri). #129'un son ağacı bu dalla birebir aynı.
- **SDK:** #126 ve #127'ye dokunulmadı.
- **Merge, deploy, public işlem, gerçek fon:** yok.

---

# Önceki sonuçlar (değiştirilmedi): dört ayrı kategori

Her kategorinin kanıtı ayrı. Birinin sonucu ötekinin yerine geçmez.

## 1. Replay: kayıtlı Composer programı, yeniden adreslenmiş (Composer yanıtı değil)
| Çalıştırma | SDK | Sonuç | Dosya |
|---|---|---|---|
| Replay (`e6bdd10` SDK) | değişmemiş | 26 PASS / 0 FAIL | `composer/out/replay/results.json` |
| Replay (PR #126 SDK, `a85a79e`) | forwarded modu var | **34 PASS / 0 FAIL** | `composer/out/replay-sdk/results.json` |
| Replay (entegrasyon SDK `f8d73b4` = #126 + #127) | forwarded mod + negatif etki desteği | **34 PASS / 0 FAIL**, `negativeQuotesUsed=0` (replay derleme yapmaz, negatif yol burada denenmez) | `composer/out/replay-integration/results.json` |

### Canlı: taze Composer teklifleriyle yaşam döngüsü (bakımcı, 2026-10-24)
| Koşu | Runner | Fork bloğu | Sonuç | Alım / forwarded VERIFIED |
|---|---|---|---|---|
| live-01 | v3 runner, değiştirilmemiş | 96966433 | 47 PASS / 8 FAIL | 4 / 4 |
| live-02 | A ve B aynı başlangıç durumundan (`model-isolation.patch`) | 96971122 | **71 PASS / 0 FAIL** | **8 / 8**, fiyat etkisi 25–26 bps |

- Teklif sayısı: iki koşuda da 22 canlı derleme.
- live-01'deki ilk ret, B-6'da swap router'ından geldi: `MinimalOutputBalanceViolation(address,uint256)`, selector `0x63ecb9f6`, token GME. Ondan sonraki adımlar zincirleme başarısız oldu. Aynı fork'ta A'nın alımları havuzları kaydırmıştı.
- live-02'de B, A'dan önceki ortak duruma geri alınarak başladı. Kontrat, minimum çıktılar, slippage ve yetki kontrolleri değişmedi.
- Kayıt notları:
  - İki koşu farklı bloklarda yapıldı; bu tek değişkenli bir neden ispatı değil.
  - 8 alım tek ve kesintisiz bir zincirde birlikte bulunmuyor.
  - Negatif teklif yolu denenmedi.
- Bu izolasyon artık ana `run.mjs` içinde.
- Dosyalar: `results/live-lifecycle-v3-2026-10-24-maintainer/`.

### Replay: yaşam döngüsü + fork'a bağlı userOp'lar + gerçek cüzdan imzaları (2026-10-24, entegrasyon SDK `dadef00`)
**83 PASS / 0 FAIL**, iki ardışık koşuda aynı. `composer/out/replay-lifecycle/`. A/B izolasyonu dahil.

| Test | A | B |
|---|---|---|
| Aynı periyotta 2. erken alım | A-7 `NotDue` | B-7 `NotDue` (plan reddediyor) |
| Plan sayısı sınırı | A-8 3. alım ✅, A-9 4. alım `Inactive`, allowance 0 | – |
| **Aynı delegasyonun kümülatif tüketimi** (plan C: planın periyodu delegasyonun yarısı, yani her ret enforcer'dan) | – | B-13 1. alım ✅ (periyot 5, toplam 5, çağrı 1) → B-14 aynı periyotta ret `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` → B-15 sonraki periyot ✅ (toplam 10 = bütçe, çağrı 2) → B-16 sonraki periyot ret `ERC20TransferAmountEnforcer:allowance-exceeded` |
| Çağrı sayısı (aynı delegasyon, calls 1) | – | B-17 1. alım ✅ → B-18 ret `LimitedCallsEnforcer:limit-exceeded` |
| Ayrı, daha düşük limitli delegasyon | – | B-8 periyot, B-9 toplam: ret. Kullanılan delegasyonun kendi sayaçları 0 kaldı |
| İptal sonrası alım | A-10 `cancel()` → `Inactive`; kullanılmamış 15 USDG izin duruyordu | B-10 userOp ile `disableDelegation` → `CannotUseADisabledDelegation` |
| Çekim | gerek yok | B-11 userOp ile kalan 40 USDG EOA'ya döndü |
| SDK forwarded | A-4, A-6, A-8, B-4, B-6, B-13, B-15, B-17: 8/8 `VERIFIED` | |

**Fork'a bağlı iptal ve çekim (PM-0…PM-7, yerel test anahtarı):** İmzalı userOp'un `paymasterAndData` alanı, sahipsiz bir research paymaster'a bağlı: `keccak256("BAG-DCA fork-only paymaster v1")[12:]` = `0x03fd2c77d32302eeF2f6F3063DbB7b899b1116D3`. Paymaster'ın kodu yalnızca fork'ta `hardhat_setCode` ile yerleştiriliyor (`composer/contracts/ForkOnlyPaymaster.sol`).

| Test | Sonuç |
|---|---|
| PM-0 | Ana ağda (`latest`) paymaster adresinde kod yok, nonce 0, bakiye 0 |
| PM-1 | Yeni bir delegasyonla 1 alım yapıldı (bütçe 3 alım; 2 alım kaldı) |
| **PM-2** | **Ana ağ koşulu:** paymaster'da kod yok, deposit var, hesapta 1 ETH. İmzalı iptal **yürütülemedi**. Hesabın nonce'u, ETH ve USDG bakiyesi, delegasyonun durumu ve deposit değişmedi |
| PM-3 | Paymaster imzalı userOp'tan çıkarıldı (hesapta ETH var) → `FailedOp(0, AA24 signature error)`. Hiçbir şey değişmedi |
| PM-4 | Aynı imzalı iptal fork'ta (paymaster kodu yerindeyken) yürütüldü. Hesap gas ödemedi (ETH 0); ödemeyi deposit yaptı. Nonce +1, delegasyon kapandı |
| **PM-5** | **Bütçe kalmışken iptal:** 2 alımlık bütçe harcanmamıştı. Sıradaki alım `CannotUseADisabledDelegation` ile reddedildi |
| PM-6 | Çekim, `validUntil = şimdi + 60 sn` ile imzalandı; süre geçince → `FailedOp(0, AA32 paymaster expired or not due)`. Hiçbir şey değişmedi |
| PM-7 | Süresi içinde imzalanan çekim: kalan 40 USDG sahibin EOA'sına döndü. Hesap gas ödemedi |

Reddedilen her denemede plan durumu, bakiyeler, izinler ve **o denemede kullanılan delegasyonun** periyot/toplam/çağrı sayaçları değişmedi (önceki sürüm yalnızca ana delegasyonun sayaçlarını okuyordu, düzeltildi).

Replay notu: Kayıtlı programın bacak minimumları sabit. Fork'ta art arda yapılan her alım havuzları kaydırdığı için 8. alım swap içinde revert etti. Bu yüzden B-17/B-18 öncesinde fork, B-13 öncesindeki duruma geri alınıyor (`evm_snapshot`/`evm_revert`). Kontrat davranışıyla ilgisi yok; canlı modda da uzun dizilerde aynı etki görülebilir.

**Gerçek cüzdan imzaları, fork'ta:** `0xb193…56b8` için MultiSig hesabı fork'ta deploy edildi; adresi imzalanan `0xcaFFeBB5…d0E8` ile aynı.
- Rabby ve MetaMask W-DELEGATION-SA: `isValidSignature` → `0x1626ba7e`. Mesaj değişince geçersiz. `redeemDelegations` imza kontrolünü geçti, yalnızca süresi geçmiş caveat yüzünden reddedildi (`TimestampEnforcer:expired-delegation`).
- W-USEROP: aynı EIP-712 hash'i için ERC-1271 geçerli. `handleOps` ile çalıştırılmadı (imza kasıtlı olarak gas 0).

Sınır: Dönemlik izinli alımlar, iptal ve çekim yerel test anahtarıyla imzalandı. Gerçek cüzdan imzalarıyla alım yapılmadı.

**Taze tekliflerle aynı yaşam döngüsü (bakımcı makinesi):**
```powershell
node composer/run.mjs --repo ..\BagProtocolv2-dca --sdk ..\BagProtocolv2-integ\packages\bag-sdk --mode live --env-file <path>\.env.local --wallet-results results\wallet-2026-10-24-rabby\6aadeeb9-wallet-signing-io.rabby-1792860998364.json,results\wallet-2026-10-24-metamask\17b65d9b-wallet-signing-io.metamask-1792861380410.json
```
`--repo` = `e6bdd10`, `--sdk` = entegrasyon `dadef00` (build edilmiş). Canlı modda her alım için yeni teklif istenir (yaklaşık 12 derleme). Beklenen son satır: `status=PASSED … sdkForwarded=MET`.

## 2. Canlı Composer: taze API derlemesi, yerel fork
| Çalıştırma | SDK | Sonuç | Dosya |
|---|---|---|---|
| 2026-10-24, bakımcı makinesi (Windows), fork bloğu 96434989 | değişmemiş (`e6bdd10`) | **26 PASS / 0 FAIL**. A ve B'de ikişer 5 USDG alım, public işlem 0 | `results/live-2026-10-24-maintainer/` |
| **Entegrasyon SDK ile canlı** (bakımcı, 2026-10-24, fork bloğu 96879819) | `f8d73b4` (#126 + #127) | **34 PASS / 0 FAIL.** Forwarded `VERIFIED` ×4. Teklifler **pozitif** (13 ve 15 bps; 5 USDG = 5,00361 $), `negativeQuotesUsed=0`, yani negatif yol canlıda **denenmedi** | `results/sdk127-live-2026-10-24-maintainer/` |
| Forwarded SDK modu ile canlı (bakımcı, 2026-10-24) | PR #126 `3f85a4c` | **Derlemede durdu.** Değişmemiş SDK kontrolü `PRICE_IMPACT_INVALID` verdi (impactBps −7, sonra −6). Alım yapılmadı | bakımcı ZIP'i `DCA-SDK126-Duzeltme` |

Çalıştırılan dosyaların hash'leri gönderilen ZIP ile birebir aynı: `run.mjs 606b1ecb…`, `DcaComposerPlan.sol bd8aa5ce…`, lock `506a3900…`, ZIP `93cb6a80…`. Canlı derlemenin şablonu placeholder şablonuyla aynı (A-2/B-2). Her alımda plandan tam 1 Composer çağrısı var, başarısız alt çağrı yok.

## 3. SDK doğrulaması
| Mod | Sonuç (4 alım) |
|---|---|
| Değişmemiş `verifyPurchaseReceipt` | `CALL_TRACE` bağlama ✅. Genel karar **`FAILED / INPUT_BALANCE_BELOW_PLAN`**. Bu doğru ve korunuyor, hem canlıda hem replay'de |
| PR #126 `delivery: { caller, fundingSource, recipient }` (replay) | **`VERIFIED`** ×4, `ON_CHAIN_PLAN_READ`, `callerNetZero: true`. Yetkisiz alıcı verilince `DELIVERY_AUTHORIZATION_MISMATCH` ×4 |
| PR #126 `3f85a4c` (harcama tam payla eşit olmalı), replay | `VERIFIED` ×4. Sentetik testlerde kısmi, sıfır, net alacak ve fazla harcama reddedildi (bakımcı tarafından da doğrulandı) |
| #126 + #127, canlı teklifle | **`VERIFIED` ×4** (pozitif tekliflerle) |

SDK testleri (her dal kendi commit'inde, benim çalıştırmalarım): #126 `3f85a4c` 302/302 · #127 `616f49f` 297/297 · entegrasyon `dadef00` 313/313. Repo: #126 2536/2536, #127 `a879ff1` 2531/2531 (`616f49f` sonrası repo geneli yeniden çalıştırılmadı). `release:check --mode package` iki PR'da da geçti. Bakımcı #127 sonrası 297/313'ü yeniden çalıştırmadı.

## 4. Cüzdan imzaları (MetaMask / Rabby)
Sayfa: `node wallet/serve.mjs` → `http://127.0.0.1:8787`. Sonuçlar indirilen `wallet-signing-*.json` dosyalarıdır.

Hesap her iki cüzdanda aynı EOA `0xb193…56b8`. Smart account = türetilmiş MultiSig `0xcaFFeBB507C438b35F886cD24dB43E4d3FD2d0E8` (`wallet/print-account.mjs`). Her `SIGNED` imzanın bu EOA'ya döndüğü typed data'dan yeniden hesaplanarak doğrulandı.

| Test | Rabby | MetaMask |
|---|---|---|
| W-PERMIT (A modeli) | SIGNED | SIGNED |
| **W-DELEGATION-SA** (B modeli, delegator = smart account) | **SIGNED** | **SIGNED** |
| W-DELEGATION-EOA (delegator = cüzdanın kendi EOA'sı) | imzalandı (ekran görüntüsü), dışa aktarılan JSON'da yok | **ENGELLENDİ** ×7: `-32603 External signature requests cannot sign delegations for internal accounts.`
| W-USEROP | SIGNED | SIGNED |

Sonuç:
- MetaMask'ın #10667 kontrolü yalnızca delegator cüzdanın kendi hesabı olduğunda devreye giriyor. B'nin kullandığı MultiSig smart account delegator olduğunda iki cüzdan da imzalıyor.
- Aynı içerik için iki cüzdanın imzası birebir aynı (deterministik ECDSA): permit ve UserOp.
- **Okunabilirlik ölçülmedi.** Yalnızca Rabby W-PERMIT için "alanlar okunabildi" işaretlendi. Diğer kutular boş; boş kutu "okunmuyor" anlamına gelmez. (Önceki sürümde boş kutular yanlışlıkla "okunmuyor" diye yorumlanmıştı.)
- Fork'ta kabul: yukarıdaki "Gerçek cüzdan imzaları, fork'ta" bölümü.

Dosyalar: `results/wallet-2026-10-24-rabby/`, `results/wallet-2026-10-24-metamask/`.

## Negatif fiyat etkisi: PR #127 (draft)
#127 (`616f49f`), LI.FI adaptöründen gelen negatif etkiyi yalnızca USD değerleriyle tutarlıysa kabul ediyor (±1 bps, gözleme dayalı uyumluluk toleransı). Sınır artık iki yönlü: `|impactBps| ≤ 500`. Diğer sağlayıcılar değişmedi. SDK testleri 297/297. Entegrasyon dalı: `dadef00`, 313/313.

LI.FI (Leo, 24.10.2026): fiyat etkisi, toplam giriş ve çıkış değerleri arasındaki fark. Negatif değer geçerli. Yuvarlama kuralını belirtmedi.

İşaretin değişimi, iki koşu yan yana: 5 USDG'nin LI.FI'deki değeri 4,9918 $'dan 5,0036 $'a çıktı (~+47 bps). Hisselerin toplam değeri de biraz değişti: 4,9950 $'dan 4,9961–4,9972 $'a (~+2–4 bps). Sonuç −6 bps'den +13/+15 bps'ye döndü. Yani değişim **büyük ölçüde** giriş (USDG) değerlemesinden kaynaklanıyor, ama tamamen değil.

**Canlı doğrulama (retry YOK, negatif teklifin doğru yorumlandığını göstermek için):**
```powershell
git fetch origin claude/sdk-integration-126-negative-impact
git worktree add ..\BagProtocolv2-integ dadef00
cd ..\BagProtocolv2-integ; npm ci --ignore-scripts; npm run build --prefix packages/bag-sdk
cd <proto>
node composer/run.mjs --repo ..\BagProtocolv2-dca --sdk ..\BagProtocolv2-integ\packages\bag-sdk --mode live --env-file <path>\.env.local
```
Beklenen son satır: `status=PASSED negativeQuotesUsed=<n> … sdkForwarded=MET`.
- `negativeQuotesUsed`, yalnızca **negatif teklif → bu teklifle fork'ta gerçekleşen alım → aynı işlemin `VERIFIED` forwarded receipt'i** zincirini sayar.
- Hazırlık ya da şablon derlemesi negatif gelip alımda kullanılmadıysa sayılmaz. Bu durum `acceptedNegativeCompiles` alanında ayrıca görünür.
- Negatif teklifle alım yapılıp receipt doğrulanamadıysa `executedButNotVerified` alanında listelenir.
- `0` ise negatif canlı yol denenmemiş demektir.

(Önceki sayaç kabul edilen bütün negatif derlemeleri sayıyordu; bu düzeltildi. Önceki 34/34 sonucu etkilenmiyor, orada sayaç zaten 0'dı.)

Ayrıntı `results.json → negativeImpact` ve `quoteAttempts` alanlarında.

## Negatif fiyat etkisi: arka plan
Gözlem: `inputValueUsd 4.99183`, `outputValueUsd 4.99499`, `impactBps −6`. Formülle hesaplanan değer −6,33. Bu, `round` ve `trunc` ile tutarlı, `floor` ile değil.

LI.FI (24.10.2026) şunları doğruladı: fiyat etkisi toplam giriş ve çıkış değerleri arasındaki fark, ve negatif değer geçerli. Yuvarlama kuralını belirtmedi. SDK'daki değişiklik #127'de: tutarlılık kontrolü ±1 bps ve iki yönlü sınır. `LIFI_QUESTION.md` artık yalnızca geçmiş kayıt olarak duruyor.

Runner'da araştırma amaçlı yeniden teklif seçeneği var (#127 ile artık gerek yok, kayıt için duruyor): `--compile-retries N --retry-delay 30`. Kuralları:
1. Sepet, tutar ve SDK sınırları her denemede aynı. `results.json → quotePolicy` bunları kaydeder.
2. **Yalnızca** değişmemiş kontrolün, raporlanmış **negatif** `impactBps` için verdiği `PRICE_IMPACT_INVALID` reddi yeniden denenir. Fiyat etkisinin hiç raporlanmaması dahil, diğer her hata çalıştırmayı durdurur.
3. Her deneme, ham USD değerleriyle birlikte `quoteAttempts` alanına kaydedilir. Hiçbir teklif kabul edilmezse `status = BLOCKED_NO_ACCEPTED_QUOTE` olur.

**Sınırı:** Bu yöntem, kabul edilen bir teklifle canlı akışı sınamaya yarar. Uyumsuzluğu çözmez. DCA'nın kesintisiz çalışacağını kanıtlamaz. Negatif teklifler sık gelirse production'da alımlar kaçar.

## Forwarded SDK modunu canlı çalıştırmak
```powershell
git fetch origin claude/sdk-forwarded-delivery-verification
git worktree add ..\BagProtocolv2-sdk 3f85a4c
cd ..\BagProtocolv2-sdk; npm ci --ignore-scripts; npm run build --prefix packages/bag-sdk
cd <proto>
node composer/run.mjs --repo ..\BagProtocolv2-dca --sdk ..\BagProtocolv2-sdk\packages\bag-sdk --mode live --env-file <path>\.env.local --compile-retries 10 --retry-delay 30
```
`--repo` hâlâ `e6bdd10` olmalı, çünkü BAG fixture'ı ve Composer wire yardımcıları orada. Beklenen son satır: `sdkFullVerification=NOT_MET_… sdkForwarded=MET`.

Windows notu (bakımcı raporu): `solc 0.8.23` paketinin bağımlılığı `n@9.2.3` win32'yi desteklemiyor. Bu yüzden prototip kurulumu `npm ci --ignore-scripts --force` ile yapıldı. Kilit dosyası ve derleyici sürümü değişmedi.
