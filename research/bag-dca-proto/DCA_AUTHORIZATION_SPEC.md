# DCA Yetki Spesifikasyonu (taslak, mimari seçilmedi)

**Hedef:** Kullanıcı sınırları başta bir kez onaylar, sonraki alımlarda yeniden imza gerekmez. Her alım ve toplam bütçe sınırı zincirde uygulanır.
**Kapsam:** Robinhood Chain (4663), USDG girdisi, %0 performans ücretli BAG'lar. `BasketPurchase.sol` içindeki Composer şablon sabitleme ve swap kontrolleri (`:164`, `:171-181`) iki modelde de korunur.
**Örnek:** 10 alım × 10 USDG = 100 USDG.

- **A:** EOA + USDG `permit` (EIP-2612). Para kullanıcının EOA'sında kalır. Harcama yetkisi plan kontratındadır.
- **B:** MetaMask **MultiSigDeleGator** smart account (tek imzacı, eşik 1, imzacı kullanıcının EOA'sı) + Delegation Framework v1.3.0 caveat'leri. ERC-7715 izin akışı kullanılmaz. Prototipte test edilen ve bytecode'u doğrulanan hesap türü bu. **HybridDeleGator doğrulanmadı:** zincirdeki bytecode v1.3.0 kaynağıyla eşleşmiyor (20.203 B ↔ 12.757 B). MetaMask'in varsayılanı Hybrid ise, kullanılmadan önce ayrıca doğrulanmalı.

## Karşılaştırma

| Konu | A: EOA + permit | B: Smart account + delegasyon |
|---|---|---|
| **Para nerede?** | Kullanıcının EOA'sı | Kullanıcının smart account'u. Kurulumda USDG bu hesaba taşınır |
| **Harcama yetkisi kimde?** | Plan kontratında. Kalan izin kadar (en fazla 100). Alım başı limiti **bizim kontratımız** uygular | Plan kontratı (delegate/redeemer) delegasyonu kullanır. Periyot ve toplam limiti **MetaMask'in enforcer kontratları** token transferi seviyesinde uygular |
| **Kuruluş: kullanıcının imza ve işlemleri** | A1: 1 off-chain `permit` imzası, kullanıcı işlemi yok. A2: 1 `permit` imzası + 1 `createPlan` işlemi (ya da `approve` + `createPlan`: 2 işlem) | 1 EOA→hesap USDG transferi (işlem) + 1 delegasyon imzası (EIP-712). Hesabın deploy'u kullanıcı imzası gerektirmiyorsa ek imza yok (V-B4) |
| **Kuruluş: keeper'ın zincir işlemleri** | A1: plan deploy (CREATE2) + `permit` gönderimi + 1. alım. Bunlar ayrı ya da tek işlemde yapılabilir. A2: yok, ilk alım hariç | Hesap deploy'u (`SimpleFactory`). Delegasyon zincire yazılmaz, her alımda `redeemDelegations` içinde sunulur. Plan kontratının deploy'u |
| **BAG, alıcı ve alım kuralları** | Plan kontratının immutable parametreleri. A1'de `permit.spender` = CREATE2 plan adresi (aşağıdaki "CREATE2 bağlaması"). Cüzdan şartları **göstermez**, uygulama göstermeli | Caveat'lerle bağlanan: token + periyot tutarı + aralık + başlangıç (`ERC20PeriodTransferEnforcer`), toplam (`ERC20TransferAmountEnforcer`), adet (`LimitedCallsEnforcer`), bitiş (`TimestampEnforcer`), redeemer (`RedeemerEnforcer`), transfer alıcısı (`AllowedCalldataEnforcer`). BAG, bacaklar, floor ve çıktı alıcısı caveat'le ifade edilemez. Bunlar plan kontratında kalır ve redeemer = CREATE2 plan adresi ile bağlanır |
| **Keeper ele geçirilirse** | Zamanı gelen `run()` çağrısını yapabilir ve pencere içinde zamanlamayı seçebilir. Şartları, alıcıyı ve tutarı değiştiremez. Değer koruması floor'a bağlı. **Plan kontratında bug varsa kalan iznin tamamı (≤100) tek işlemde gidebilir** | Aynı. Ek olarak, plan kontratında bug olsa bile hesaptan çıkabilecek tutar enforcer'larla sınırlı: **her sabit periyotta ≤10**, zaman içinde **toplam ≤100** (iptal edilene ya da süre bitene kadar). Para yalnızca plan kontratına transfer edilebilir. **Periyot sınırı:** periyotlar `startDate`'ten sabit takvimle sayılır. k. periyodun son saniyesinde ve k+1'in ilk saniyesinde iki transfer yapılabilir, yani **birkaç saniye içinde 20**. Bunu enforcer değil, plan kontratındaki `lastExecution + period` kontrolü engeller (bug durumunda bu kontrol de güvenilmez) |
| **Plan iptali** | Plan kontratında kalıcı `cancelled` bayrağı, owner (kullanıcı) çağırır (1 işlem). Kontrat iptal edildiyse `run()`, allowance ne olursa olsun reddeder. **Deploy edilmemiş plan** için iptal factory'de tutulur: `factory.cancel(planAddress)` (1 işlem, yalnızca o planın owner'ı çağırabilir). Factory iptal edilmiş adrese deploy etmez. Plan constructor'ı ve `run()` da bu kaydı kontrol eder | `DelegationManager.disableDelegation` yalnızca delegator hesaptan çağrılabilir (`DelegationManager.sol:90`). Hesap fonksiyonları `onlyEntryPoint` (`DeleGatorCore.sol:177`), yani **kullanıcının imzaladığı bir userOp gerekir**. Plan kontratında da ayrıca `cancelled` bayrağı olur |
| **İzin sıfırlama ve çekim** | `USDG.approve(plan, 0)` yalnızca allowance'ı sıfırlar, **iptal yerine geçmez**: kullanılmamış bir `permit` imzası ya da sonradan verilen bir approve izni geri getirebilir. İptal + sıfırlama = 2 işlem. Alternatif: kullanıcı kendi permit'ini kendisi zincire gönderip nonce'u tüketir, sonra sıfırlar. **`permit.deadline` izni sona erdirmez**, yalnızca imzanın son gönderim tarihidir | Sıfırlanacak token izni yok, çünkü hesap hiçbir zaman `approve` vermez. Kalan USDG'yi EOA'ya çekmek ayrı bir userOp gerektirir |

## B için zorunlu akış (V-B1'in sonucu)

`ERC20PeriodTransferEnforcer` yalnızca **tekli çağrı modunu** kabul eder (`:130`). Hedef token olmak zorunda (`:187`), fonksiyon da `transfer(address,uint256)` olmak zorunda (`:188`). Bu yüzden:
- Kullanıcı hesabından delegasyonla `approve` → `invalid-method` ile revert.
- Batch çağrı → revert.
- Composer'ın kullanıcı hesabından `transferFrom` yapması → önce bir `approve` gerektirdiği için **bu caveat altında imkânsız**.

**Sonuç:** Delegasyonun yürüttüğü tek işlem `USDG.transfer(plan, 10)` olmalı. Composer'ın `approve` ve `transferFrom` adımları **plan kontratının kendi bakiyesinden** yapılır. Bu tasarımda limit, paranın kullanıcı hesabından çıkabildiği tek yolu sınırlıyor. Enforcer `transfer`'in **alıcısını sınırlamıyor**, bu yüzden `AllowedCalldataEnforcer` (offset 4 → plan adresi) şart. `ERC20TransferAmountEnforcer` da aynı kısıtlara sahip (`:49`, `:92`, `:94`).

## CREATE2 bağlaması (iki model için ortak)

`planAddress = CREATE2(factory, salt, keccak256(initCode))`

- **`factory`:** immutable, owner'ı yok, upgrade edilemez. Adresi ve runtime codehash'i uygulamada sabitlenir.
- **`initCode`:** plan kontratının creation bytecode'u + ABI-encoded parametreler. Plan **kod sürümü**, bytecode hash'i üzerinden adrese girer. Kod değişirse adres de değişir.
- **`salt`:** `keccak256(abi.encode(SPEC_VERSION, chainId, owner, nonce))`.
- **Parametreler (hepsi immutable):**
  - `owner` = kullanıcının EOA'sı (A) ya da smart account sahibinin EOA'sı (B). İptal ve duraklatma yalnızca owner'dadır, keeper ya da BAG'da değil.
  - `fundingSource` = EOA (A) ya da smart account (B)
  - `recipient` = owner'ın çıktı adresi, varsayılan owner
  - `definitionHash`, BAG `strategyId` ve `version`
  - Bacaklar (token, weightBps), giriş tokenı (USDG)
  - `grossPerRun`, `totalBudget`, `maxRuns`, `start`, `period`, `expiry`
  - Fiyat politikası parametreleri (floor kuralı)
  - Composer şablonu: `commandsHash` ve sabitlenmiş state hash'leri
  - İzinli adresler ve codehash'leri: Composer factory/diamond/router, (B) DelegationManager ve enforcer'lar
- **A1:** `permit.spender = planAddress`. **B:** `RedeemerEnforcer` ve `AllowedCalldataEnforcer` terimlerinde `planAddress`.
- **Uygulama, imzadan önce** parametreleri gösterir ve adresi istemci tarafında yeniden hesaplar.

## Composer bağlantısı (iki model için ortak)

- İşlemi plan kontratı yürütür. Composer proxy'si `FACTORY.predictProxyAddress(plan)` olur (`BasketPurchase.sol:77`'deki desen).
- SDK, terminal çıktının sahibinin işlemi imzalayan adres olmasını zorunlu kılıyor (`packages/bag-sdk/src/adapters/lifi.ts:155`). Yani çıktılar önce plan kontratına düşer, **aynı işlemde** kullanıcıya aktarılır. Kontrol: kullanıcının bakiye artışı ≥ floor, işlem sonunda plan kontratının bakiyesi ve izni 0.

### Signer'dan bağımsız şablon (adres döngüsü yok)

Composer programında signer adresi yalnızca belirli yerlerde geçiyor. Kayıtlı programın analizine göre (`composer/analyze-signer-dependence.mjs`):
- **signer** yalnızca slot 0'da (`abi.encode(signer)`),
- **proxy** yalnızca slot 1'de (`balanceOf(proxy)`) ve swap'lardaki `receiver` alanında,
- **context** slot'u plana özgü olarak yeniden yazılıyor.

Instruction'lar, fee calldata'sı ve router calldata'sı adres içermiyor. Bu yüzden CREATE2 init code'una giren şablonda bu slot'lar **boş** tutulur, plan kontratı bunları çalışma anında `address(this)`'ten yeniden üretir. Şablon, başka bir signer için yapılmış bir derlemeden çıkarılır, plan adresi tahmin edilir, sonra o adres için yeniden derlenir. İki şablonun aynı olması gerekir (kontrol: `composer/run.mjs`, T-2 ve A-2/B-2).

### SDK doğrulaması: açık boşluk

`verifyPurchaseReceipt` bakiye değişimini signer'da ölçüyor (`receipt.ts:270-385`). Bu modelde signer plan kontratı, ve teslimatı aynı işlemde kullanıcıya aktarıyor. Bu yüzden SDK'nın genel kararı `FAILED / INPUT_BALANCE_BELOW_PLAN` çıkıyor. İç Composer çağrısının bağlanması (`CALL_TRACE`) SDK tarafından kanıtlanıyor. Teslimat ise SDK'nın işlem kapsamlı bakiye okuyucusuyla (`withReceiptEvidence().getPurchaseBalanceChanges`) ayrıca kontrol ediliyor. **Tam SDK doğrulaması için SDK'ya "fon kaynağı + teslim alıcısı" modu eklenmesi gerekiyor.** Bu işlem prototip kapsamı dışında.

## Doğrulama durumu

**✅ Doğrulandı (zincir veya kaynak)**
- USDG'de EIP-2612 `PERMIT_TYPEHASH` ve `DOMAIN_SEPARATOR` mevcut. Permit2 deploy edilmiş.
- Robinhood'da (4663) şunların bytecode'u var: DelegationManager, MultiSigDeleGatorImpl, HybridDeleGatorImpl (eşleşmiyor, aşağıya bakın), SimpleFactory, EntryPoint v0.7, ve Period, TransferAmount, LimitedCalls, Redeemer, AllowedCalldata, Timestamp enforcer'ları (`@metamask/delegation-deployments` 2.1.0, v1.3.0 adresleri).
- Smart Accounts Kit v2.0.0 Robinhood Chain'i destekliyor. ERC-7715 tablosunda Robinhood Chain yok. MetaMask/core#10667 hâlâ açık.
- Enforcer davranışı yukarıda anlatıldığı gibi. Kaynak: `MetaMask/delegation-framework@main`.

**❓ Varsayım: fork'ta veya cüzdanda doğrulanacak**
- **V-B1 (zorunlu):** Fork'ta şu davranışlar test edilecek:
  - (a) delegasyonla `approve` → revert
  - (b) batch çağrı → revert
  - (c) `transfer(plan, 10)` → geçer
  - (d) aynı periyotta ikinci transfer → `transfer-amount-exceeded`
  - (e) başka bir alıcıya transfer → `AllowedCalldata` revert
  - (f) redeemer ≠ plan → revert
  - (g) toplam > 100 ya da adet > 10 → revert
  - (h) süre bittikten sonra ya da `disableDelegation` sonrası → revert
  - (i) periyot sınırında arka arkaya iki alım → plan kontratındaki `lastExecution + period` kontrolü bunu engellemeli
- **V-B2 — ✅ fork/derleme ile doğrulandı:** `delegation-framework@v1.3.0` derlendi (solc 0.8.23, optimizer 200, `london`). Runtime bytecode metadata ve immutable alanlar maskelenerek karşılaştırıldı: DelegationManager, MultiSigDeleGator, EIP7702StatelessDeleGator ve 6 enforcer **MATCH**. Maskelenen 27 immutable alanın zincirdeki değerleri beklenen değerlerle aynı: chainId, `address(this)`, EIP-712 isim/sürüm hash'leri, domain separator, DelegationManager ve EntryPoint. **HybridDeleGator MISMATCH**, doğrulanmadı.
- **V-B3:** MetaMask ve Rabby, *ayrı* bir MultiSig smart account için Delegation EIP-712 mesajını imzalıyor mu? #10667'deki engel yalnızca MetaMask'in kendi hesapları için mi geçerli?
- **V-B4:** Robinhood'da bundler yok sayılıyor. Hesap deploy'u ve userOp gönderimi keeper ya da uygulama tarafından `handleOps` ile yapılabilir mi? Kullanıcının imzalayacağı userOp hash'i MetaMask ve Rabby'de gösterilebiliyor mu?
- **V-A1:** MetaMask ve Rabby, USDG `permit` mesajını doğru gösterip imzalıyor mu?
- **V-A2:** A1 kurgusunda `permit`'i başka biri önce zincire gönderirse ne olur? `try/catch` ve ardından allowance kontrolü ile akış devam ediyor mu?
- **V-A3:** `approve(0)` sonrası kullanılmamış `permit` gönderilirse allowance geri gelir. İptal edilmiş plan bu durumda **yine de** `run()`'ı reddetmeli.
- **V-A4:** İptal sonrası kullanıcı aynı plana yeniden approve verirse plan yine reddetmeli.
- **V-A5:** Deploy edilmemiş planı `factory.cancel` ile iptal et. Ardından deploy denemesi ve permit gönderimi → plan çalışmamalı.
- **V-AT (ortak, atomiklik):** Alım başarısız olursa (floor ihlali ya da swap revert) fon çekme, izin değişiklikleri, plan sayaçları ve (B) enforcer sayaçları tamamen geri alınmalı.
- **V-C1 (ortak):** Plan kontratının Composer'a imzalayan olarak verildiği bir derleme, çıktıların kullanıcıya aktarılması ve şablon sabitleme, gerçek bir Composer teklifiyle fork'ta çalışıyor mu?
- **Açık (ikisi için de):** Uzun süreli fiyat politikası. Negatif `impactBps`'in anlamı (SDK reddediyor: `execution.ts:226-227`).

## Karar kriterleri

1. Kontrat bug'ı durumunda kayıp profili: A'da kalan bütçenin tamamı tek işlemde. B'de her sabit periyotta bir alım tutarı (periyot sınırında arka arkaya iki tutar), zaman içinde iptale kadar toplam bütçe. Fark, kaybın **hızı** ve bu süre içinde fark edip iptal edebilme imkânı.
2. Kurulum ve iptal sürtünmesi: A'da iptal tek işlem. B'de iptal ve çekim userOp gerektiriyor.
3. V-B3 ve V-B4 sonuçları. Bunlar olumsuz çıkarsa B, Rabby'de uygulanamaz.
