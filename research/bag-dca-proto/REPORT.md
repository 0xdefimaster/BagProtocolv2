# DCA Yetki Prototipi: Kanıt Raporu

**Durum:** Mimari seçilmedi. Bu rapor yalnızca kanıtları içeriyor.
**Ortam:** Robinhood Chain (4663) mainnet'in izole bir fork'u, blok `96398367`. Upstream'e yalnızca okuma çağrıları gitti. Gönderim denemesi relay tarafından reddedildi (`eth_sendRawTransaction`, bilerek yapılan bir kontrol). **Public işlem: 0. Gerçek para: yok.** Kullanılan anahtarlar fork içinde rastgele üretildi. Fork'taki USDG, kayıtlı bir holder'ı taklit ederek (impersonation) sağlandı.
**Sonuç:** 34 PASS / 0 FAIL. Kaynak: `fork/out/results.json`.

## 1. Kaynak ile deployment eşleşmesi (V-B2)

`MetaMask/delegation-framework@v1.3.0` solc 0.8.23 ile derlendi (optimizer 200, `london`). Runtime bytecode, metadata ve immutable alanlar maskelenerek zincirdekiyle karşılaştırıldı. Script: `verify-bytecode.mjs`.

| Kontrat | Adres | Sonuç |
|---|---|---|
| DelegationManager | `0xdb9B…dB3` | ✅ MATCH (7 immutable maskelendi) |
| MultiSigDeleGator | `0x56a9…f3A7` | ✅ MATCH |
| EIP7702StatelessDeleGator | `0x63c0…E32B` | ✅ MATCH |
| ERC20PeriodTransfer, ERC20TransferAmount, LimitedCalls, Redeemer, AllowedCalldata ve Timestamp enforcer'ları | v1.3.0 adresleri | ✅ 6/6 MATCH |
| **HybridDeleGator** | `0x48dB…FEC4` | ❌ **Uyuşmuyor** (yerel derleme 12.757 B, zincir 20.203 B). Muhtemel neden: P256 kütüphanesinin farklı bir sürümü ya da farklı build ayarları. **Hybrid kullanılacaksa doğrulanmadı sayılmalı.** Prototipte MultiSig kullanıldı |

Ek bilgi: `main` ile `v1.3.0` arasında `ERC20PeriodTransferEnforcer` kaynağı aynı.

**Maskelenen immutable alanlar:** 27 alanın 27'si beklenen değerde. Kontrol edilenler: `_cachedChainId` = 4663, `_cachedThis`/`__self` = kontrat adresi, `_hashedName`/`_hashedVersion`/`_name`/`_version` = `eip712Domain()` ile tutarlı, `_cachedDomainSeparator` = yeniden hesaplanan değer, `delegationManager` = `0xdb9B…dB3`, `entryPoint` = `0x0000…a032`. Ayrıntılar: `out/bytecode-verification.json`.

## 2. Fork sonuçları

Composer yerine `MockRouter` kullanıldı. Bu router Composer ile aynı akışı izliyor: plan router'a `approve` verir, router `transferFrom` ile çeker, çıktıyı plana mint eder. Router'ın üç modu var: normal, revert ve yarım teslim. **Bu testler gerçek Composer derlemesini kanıtlamaz** (bkz. §4).

### Model A: EOA + USDG permit
| ID | Kanıtlanan | Sonuç |
|---|---|---|
| A-0 | USDG'nin `name`/`version` değerleri on-chain `DOMAIN_SEPARATOR`'ı birebir üretiyor. Yani cüzdanların imzalayacağı EIP-712 domain'i doğru | ✅ |
| A-1 | Kuruluş: **kullanıcı 1 imza, 0 işlem**. **Keeper 1 işlem**: CREATE2 ile deploy + permit. Plan adresi tahmin edilen adresle aynı, owner = kullanıcı | ✅ |
| A-2 | Çekim, swap ve kullanıcıya teslim **tek işlemde**. Plan ve router'da artık bakiye ve izin 0. Allowance 100 → 90 | ✅ |
| A-3 | Aynı pencerede ikinci alım → `NotDue` | ✅ |
| A-4 | Swap revert ve floor ihlali → kullanıcı bakiyesi, allowance ve `runs` **değişmiyor** | ✅ |
| A-6 | Permit'i keeper'dan önce üçüncü biri gönderirse kuruluş yine tamamlanıyor (`try/catch` + allowance kontrolü) | ✅ |
| A-7 / **A-8** | `approve(plan, 0)` harcamayı durduruyor. **Ama kullanılmamış bir permit gönderilince allowance geri geliyor ve plan yeniden çalışıyor.** `approve(0)` iptal yerine geçmiyor | ✅ (risk kanıtlandı) |
| A-9 | `cancel()` sonrası allowance olsa bile `run` → `Inactive` (V-A3) | ✅ |
| A-10 | İptal edilmiş plana yeniden approve verilmesi planı canlandırmıyor (V-A4) | ✅ |
| A-11 | Plan ve factory iptalini yalnızca owner yapabiliyor | ✅ |
| A-12 | Deploy edilmemiş plan `factory.cancel` ile iptal edilince, permit zincire gönderilse bile deploy edilemiyor (V-A5) | ✅ |
| A-13 | Son alımdan sonra allowance = 0. Sonraki çağrı → `Inactive` | ✅ |

### Model B: MultiSig smart account + delegasyon
| ID | Kanıtlanan | Sonuç |
|---|---|---|
| B-0 | Smart account'u (MultiSig v1.3.0, imzacı kullanıcının EOA'sı) keeper deploy ediyor, kullanıcı imzası gerekmiyor | ✅ |
| B-1/B-2 | Kuruluş: **kullanıcı 1 işlem (hesaba USDG) + 1 delegasyon imzası**. **Keeper 2 işlem** (hesap + plan deploy) | ✅ |
| B-3 | Delegasyonla `transfer(plan, 10)`, swap ve kullanıcıya teslim **tek işlemde**. Enforcer sayaçları: periyot 10, toplam 10, çağrı 1. Hesap hiçbir `approve` vermiyor | ✅ |
| B-4 | Swap revert ve floor ihlali → hesap bakiyesi, plan `runs` ve **üç enforcer sayacı da değişmiyor** | ✅ |
| B-5 | Plan koruması: pencerenin son saniyesinde yapılan alımdan sonra, yeni pencerenin ilk saniyesinde → `NotDue` | ✅ |
| B-6 | Hesapta ETH yoksa ve paymaster yoksa userOp reddediliyor (`AA21`). **İptal ve çekim için gas kaynağı gerekiyor** | ✅ (gereksinim) |
| B-7 | İptal: kullanıcının imzaladığı userOp'u keeper `EntryPoint.handleOps` ile gönderiyor. `disableDelegation` sonrası plan → `CannotUseADisabledDelegation` | ✅ |
| B-8 | Çekim: kullanıcının imzaladığı userOp ile kalan USDG kullanıcının EOA'sına dönüyor | ✅ |

### V-B1: enforcer'lar tek başına neyi garanti ediyor?
Bu testler için bilerek gevşek tutulmuş bir test delegasyonu kullanıldı. Delegate bir EOA, yani bug'lı ya da ele geçirilmiş bir plan kontratını temsil ediyor.

| ID | Kanıtlanan | Sonuç |
|---|---|---|
| (a) | Delegasyonla `approve` → `ERC20PeriodTransferEnforcer:invalid-method` | ✅ |
| (b) | Batch mod → `CaveatEnforcer:invalid-call-type` | ✅ |
| (c) | İzinli alıcıya `transfer(…, 10)` → geçiyor | ✅ |
| (d) | Aynı periyotta ikinci transfer → `transfer-amount-exceeded` | ✅ |
| (e) | Başka bir alıcıya transfer → `AllowedCalldataEnforcer:invalid-calldata` | ✅ |
| (f) | Plan delegasyonunu başkası kullanamıyor (`InvalidDelegate`). Open delegasyon + Redeemer → `unauthorized-redeemer` | ✅ |
| (g) | Toplam bütçe (`allowance-exceeded`) ve çağrı sayısı (`limit-exceeded`) sınırları uygulanıyor | ✅ |
| (h) | Süre bitince → `expired-delegation`. Delegasyon kapatılınca → B-7 | ✅ |
| **(i)** | **Periyot sınırında enforcer tek başına 1 saniye içinde 10 + 10 = 20'ye izin veriyor.** Bunu yalnızca plan kontratının kendi kontrolü (B-5) engelliyor | ✅ (risk kanıtlandı) |

## 2b. Gerçek Composer programıyla (replay modu, 26 PASS / 0 FAIL)

Kaynak: `composer/out/replay/results.json`.

**Program:** Gerçek BAG `955df6e0…` (4 hisse tokenı) için kaydedilmiş gerçek Composer programı kullanıldı. Program, plan adresine göre **yalnızca signer'a bağlı alanlar değiştirilerek** yeniden adreslendi. Değişen alanlar: slot 0, slot 1 ve swap `receiver` alanları. Bu bir Composer yanıtı **değil** ve teklifler eski. Buna rağmen swap'lar fork'taki gerçek havuzlarda çalıştı.

**Plan kontratı:** Composer'ın signer'ı plan kontratının kendisi. Kontrattaki Composer kontrolleri `BasketPurchase.sol`'den uyarlandı.

| ID | Kanıtlanan | Sonuç |
|---|---|---|
| T-1 / T-2 | Başka bir placeholder signer için yapılan derlemeden signer'dan bağımsız şablon çıkarılıyor. Türetilen slot'lar: `[0, 1, 6, 9, 14, 18, 24]`, yani signer, proxy bakiyesi, 4 swap ve context. Şablonun geri kalanında signer ya da proxy byte'ı kalmıyor | ✅ |
| A-1/A-2, B-1/B-2 | Plan adresi tahmin edildi. **O adres için** yapılan derlemenin şablonu, placeholder şablonuyla **aynı**: adres döngüsü yok | ✅ |
| A-3, B-3 | Deploy edilen adres tahminle aynı. Owner = kullanıcı | ✅ |
| A-4/A-6, B-4/B-6 | Fon çekimi (A: `transferFrom`, B: delegasyon `transfer`), Composer alımı (4 bacak) ve kullanıcıya teslim **tek işlemde**. Planda artık bakiye 0, proxy izni 0 | ✅ |
| A-5, B-5 | Router calldata'sı bozuk bir program, plan doğrulamasını geçiyor ama Composer içinde revert ediyor. Kullanıcı bakiyeleri, izinler, `runs`/`lastExecution` ve (B) üç enforcer sayacı ile hesap bakiyesi **değişmiyor** | ✅ |
| *-sdk-binding | SDK `verifyPurchaseReceipt`, iç Composer çağrısını **`CALL_TRACE`** olarak bağlıyor: planın derlenmiş çağrıyı birebir yaptığını kanıtlıyor | ✅ |
| *-delivery | SDK'nın işlem kapsamlı bakiye okuyucusu (`withReceiptEvidence().getPurchaseBalanceChanges`) ile: kaynak −5 USDG, kullanıcının her token'daki artışı ≥ floor, plan delta 0 | ✅ |

## 3. Kabul koşulu: SDK tam doğrulaması **karşılanmadı**

SDK'nın genel kararı her alımda `FAILED / INPUT_BALANCE_BELOW_PLAN`. Nedeni: SDK bakiye değişimini signer'da ölçüyor (`packages/bag-sdk/src/receipt.ts:270-385`). Signer olan plan kontratının işlem öncesi USDG bakiyesi 0, ve teslimatı aynı işlemde kullanıcıya aktarıyor. Bağlama kanıtlanıyor, teslimat SDK okuyucusuyla ayrıca kontrol ediliyor, ama **"SDK `VERIFIED`" kabul koşulu değiştirilmemiş SDK ile sağlanamıyor.** Gereken: SDK'ya bir "fon kaynağı + teslim alıcısı" doğrulama modu. Bu modda girdi debiti `source`'ta, çıktılar `recipient`'ta, signer'da da net 0 kontrol edilir. **Güncelleme:** Bu mod draft PR #126'da eklendi (`a85a79e`). Replay'de 4/4 `VERIFIED`. Varsayılan mod hâlâ `FAILED / INPUT_BALANCE_BELOW_PLAN` döndürüyor. Bkz. `RESULTS.md`.

## 4. Kanıtlanmayanlar

- **Canlı Composer (live mod):** Gerçek teklifle derleme ve özellikle Composer API'nin bir **kontrat adresini** signer olarak kabul edip etmediği burada çalıştırılamadı, çünkü API anahtarı yok. Runner hazır: `composer/run.mjs --mode live`.
- **Gerçek cüzdanlar:** MetaMask ve Rabby imza akışları (V-A1, V-B3, V-B4'ün cüzdan tarafı) denenmedi. Fork testleri yerel anahtarlarla imzaladı. Plan aşağıda.
- **HybridDeleGator:** Bytecode eşleşmedi. MetaMask'in varsayılan hesap türü buysa, ayrıca doğrulanması gerekiyor.
- **Fiyat:** Floor sabitti. Fiyat politikası hâlâ açık.
- **Zaman:** Zaman ileri sarıldı. Gerçek günler boyunca çalışan bir keeper kanıtlanmadı.
- **Gas:** Gas, Robinhood'un Nitro (L1 veri) maliyet modeliyle ölçülmedi.
- **Güvenlik:** Prototip kontratları audit edilmedi ve production kodu değil.

## 5. Gerçek cüzdan imza denemeleri (ayrı yapılacak, henüz yapılmadı)

Sayfa: `wallet/sign-test.html`, `node wallet/serve.mjs` ile açılır. Sonuçlar `wallet-signing-*.json` olarak indirilir ve **fork sonuçlarından ayrı tutulmalı**.

**Güvenlik kuralı:** İmza zincire gönderilmese bile bir yetkidir. Denemeler **boş, tek kullanımlık bir cüzdanla** yapılmalı ve imzalar **kullanılamaz** olacak şekilde üretilmeli:
- **Permit:** `deadline` geçmiş bir zaman, `value` = 0.
- **Delegasyon:** `TimestampEnforcer` eşiği geçmiş, delegator henüz deploy edilmemiş bir hesap.

| ID | Cüzdan | Deneme | Kaydedilecek |
|---|---|---|---|
| W-1 | MetaMask | USDG `Permit` EIP-712 (A-0 domain'i) | İmzalıyor mu? Spender, tutar ve deadline nasıl gösteriliyor? Uyarı çıkıyor mu? |
| W-2 | Rabby | Aynı | Aynı |
| W-3 | MetaMask | MultiSig hesap için `Delegation` EIP-712 (DelegationManager domain'i) | **Engelliyor mu?** (#10667'deki "internal account" kontrolü). Caveat'ler okunabiliyor mu? |
| W-4 | Rabby | Aynı | Aynı |
| W-5 | MetaMask ve Rabby | MultiSig userOp imzası (`signUserOperation`, EIP-712) | İmzalıyor mu? Ne gösteriyor? |

Bu denemeler için küçük, yerel bir HTML sayfası hazırlanabilir. Sayfa yalnızca `eth_signTypedData_v4` çağırır, hiçbir işlem göndermez.
