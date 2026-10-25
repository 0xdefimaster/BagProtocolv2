# Kararlar (kapanış, 25.10.2026)

Bu belge yeni onay turu açmaz. Verilmiş kararları ve bunların kod karşılığını tek yerde toplar. Kodda karşılığı olmayan bir güvence burada yazmıyor.

## 1. Fonlama modeli: B (ayrı smart account)

| | Asıl istek (native ERC-7715) | Seçilen araştırma modeli (B) |
|---|---|---|
| USDG nerede durur | Kullanıcının kendi EOA adresinde | EOA'nın sahibi olduğu **ayrı** MultiSigDeleGator smart account'ta. Kullanıcı USDG'yi bu hesaba taşır |
| İzin | Cüzdanın native izin ekranı | EIP-712 Delegation imzası (Delegation Framework v1.3.0 caveat'leri) |
| Durum | **BLOCKED_EXTERNAL** (bölüm 2) | Fork'ta uçtan uca çalışıyor (STATUS.md) |

- B, asıl isteğin yerine geçmez. Fonlar ayrı bir adrese taşınır. Kullanıcı bu farkı bilerek seçmeli. "Fonlar ana cüzdanda kalıyor" ifadesi B için doğru değil.
- **Delegasyon** yalnızca `USDG.transfer(plan, tutar)` çalıştırabilir:
  - `AllowedCalldataEnforcer` alıcıyı plan adresine sabitler.
  - `RedeemerEnforcer` redeem edeni plan adresine sabitler.
  - Ayrıca şu caveat'ler var: `ERC20PeriodTransferEnforcer` (dönem tutarı, takvim penceresi), `ERC20TransferAmountEnforcer` (toplam bütçe), `LimitedCallsEnforcer` (çağrı sayısı), `TimestampEnforcer` (başlangıç ve bitiş).
  - `approve`, başka bir hedef, başka bir alıcı veya serbest calldata izni yok. `SudoPolicy` yok.
- **Enforcer'lar:** v1.3.0 kaynağıyla bytecode eşleşmesi `out/bytecode-verification.json` içinde. Kod hash'leri `lib/pins.json` içinde sabit; her koşu P-1 ve E-1'de bunları yeniden kontrol eder.
- **Sınırlar iki katmanda:** Dönem ve toplam sınırları plan kontratının dışında, izin katmanında da uygulanıyor. Plan atlanıp DelegationManager'a doğrudan gidilen denemelerde (H-4, H-9, X-5…X-9) enforcer'ların kendisi reddediyor.
- **Plan:** Sahibi kullanıcı. Plan adresi CREATE2 ile `abi.encode(terms, program)` üzerinden hesaplanır. Terms içinde şunlar var:
  - BAG `definitionHash`
  - kaynak hesap ve alıcı
  - dönem başlangıcı ve süresi
  - alım başına tutar, en fazla alım sayısı ve bitiş

  BAG değişirse plan adresi de değişir ve eski izin yeni plana geçmez.
- **İptal ve geri çekme:** İkisi de kullanıcının imzaladığı userOp ile yapılır (`disableDelegation`, `transfer(owner)`). Deploy eden bir hizmete bağlı değiller.

## 2. MetaMask native yolu: BLOCKED_EXTERNAL

- **Gözlenen:** MetaMask 13.53.0, 4663 için izin ekranını açtı. Grant'ten sonra `-32603 External signature requests cannot sign delegations for internal accounts` döndü. İzin bağlamı alınmadı ve DCA denenmedi (`results/metamask-native/native-permission-result.json`).
- **Kaynakta bulunan uyumsuzluk:**
  - Eklentinin doğrudan bağımlılığı `delegation-deployments` 2.1.0 (4663 var).
  - `gator-permissions-controller` 4.2.2'nin iç içe bağımlılığı 1.4.0 (4663 yok).
  - Bu bulgu güçlü bir aday. Eklentinin tam runtime izi alınmadığı için tek kesin neden diye ilan edilmiyor.
- **25.10.2026'da yeniden kontrol (npm registry):**
  - Son controller sürümü 6.0.1 (24.09.2026) ve hâlâ `delegation-deployments ^1.4.0` istiyor.
  - 1.x serisi 1.4.0'da bitiyor. Yani bu aralıkta 4663 içeren bir sürüm yok.
  - Düzeltilmiş resmi bir sürüm doğrulanamadı.
- **Yapılmayanlar:** Eklenti değiştirilmedi. Güvenlik guard'ı kapatılmadı. Aynı yetki raw delegation ile istenmedi. Limitsiz approve/permit kullanılmadı. Kullanıcıdan para yatırması istenmedi. Issue veya harici mesaj otomatik gönderilmedi. Paylaşılmaya hazır rapor: `metamask/ISSUE_REPORT.md`.
- **Engeli kapatacak somut sonuç:** 4663 kaydını içeren bir controller ile çıkmış resmi MetaMask sürümünde gerçek grant alınması. Ardından o grant'in fork'ta kullanılması ayrı bir aşama olarak denenecek.

## 3. "Yalnızca fork'ta geçerli" iddiasının dayanağı

Fork, chainId 4663 kullanıyor. Bu yüzden imzalar kriptografik olarak ana ağ domain'inde de geçerli. Fork'a bağlılık şu varsayımlara dayanıyor:

- **Delegate plan adresi:** Factory F* = keccak("BAG-DCA fork-only plan factory v1")[12:] = `0x7fE0cf85…b3E6`. Bu adresin bilinen bir özel anahtarı yok; bilinen bir deployer'ın CREATE/CREATE2 sonucu da değil. Kod yalnızca fork'ta `hardhat_setCode` ile konuyor. Plan adresi factory, salt ve initCodeHash'ten yeniden hesaplanıyor (P-2). İmzadan önce ana ağda F*'ın kodu `0x`, nonce'u 0 olarak okunuyor (P-1).
- **UserOp'lar:** Paymaster PM* = `0x03fd2c77…16D3` de aynı şekilde türetiliyor.
  - `paymasterAndData` ve `validUntil` imzaya dahil.
  - Paymaster kaldırılırsa ya da değiştirilirse imza geçmiyor (AA24).
  - Kod yoksa, deposit ve hesap ETH'si olsa bile çalışmıyor (H-5a).
  - Süre geçince reddediliyor (X-10, AA32).
- **Mutlak güvence verilmiyor.** Keccak ön görüntüsü bulunursa ya da bu adreslere başka bir yolla kod konabilirse varsayım çöker. Bunun pratikte mümkün olmadığını düşünüyoruz, ama "bu adreste hiç kod olamaz" demiyoruz.

## 4. Fiyat politikası: PRICE_POLICY_UNPROVEN (fail-closed)

Kod: `lib/price-gate.mjs` (`PRICE_POLICY`), testler: `test/price-gate.test.mjs`.

| Alan | Değer | Neden |
|---|---|---|
| Referans fiyat kaynağı | **yok** (`reference.source = null`) | 4663'te bu hisse token'ları için doğrulanmış bağımsız bir fiyat beslemesi (adres + sürüm) bulunamadı. Aynı anlık AMM fiyatı bağımsız referans sayılmaz |
| Birim / ondalık | bacak girdisi için çıktı token'ının ham birimi (USDG ham birim, 6 ondalık) | Ondalıklar zincirden okunur |
| Zaman damgası / en fazla eskime | ayarlanmadı (`maxStalenessSeconds = null`) | Kaynak olmadan anlamsız |
| TWAP penceresi | ayarlanmadı | TS'deki TWAP yardımcıları zincir üstü doğrulayıcı değildir |
| USDG'nin USD değeri | **varsayılmıyor** (`usdgReferenceUsd = null`) | USDG açıklama olmadan 1 USD'ye sabitlenmez |
| Kullanıcı toleransı | ayarlanmadı (BAG kuralı `swapSlippageBps`, referans gelince) | — |
| Veri yokken | **FAIL_CLOSED** | `NO_REFERENCE_PRICE`, `POLICY_NOT_PROVEN` |

- **Doğrudan FAIL veren kontroller:**
  - Kanıt `RECEIPT_VERIFIED` değilse.
  - Havuz ücreti %1'in üzerindeyse. Bu kontrol, %1 probe'unun kaçırdığı sabit yüksek ücretli havuzları yakalar.
  - İzin listesinde olmayan bir hook varsa.
  - Probe etkisi 500 bps'nin üzerindeyse.
  - Aynı bloktaki en iyi başka rotanın 200 bps'den fazla altındaysa. Bu yalnızca akıl sağlığı kontrolüdür; referans yerine geçmez.
- **Sonuç:** Gönderilen politikayla hiçbir rota `PASS` alamaz. Araştırma swap'ları çalışıyor, ama "güvenli otomatik yatırım hazır" sonucu verilmiyor.
- **Test oracle'ı:** Kullanılırsa `synthetic: true` olarak işaretlenir ve `SYNTHETIC_REFERENCE` ile kapalı kalır.

## 5. Hook ve havuz seçimi

- `hookAllowlist` boş. Hook'lu her v4 havuzu `HOOK_NOT_ALLOWLISTED` alır, en iyi fiyatı verse bile. Örnek: COIN ve AAPL'de en iyi çıktı hook'lu dinamik ücretli havuzdan geldi.
- **Ölçülen kapsam:** v4'te likiditeye göre en derin 3 havuz yürütüldü. Bu bütün piyasanın taranması değil. Likidite sıralaması, `extsload` yerleşimi ve son Swap olayıyla doğrulandığı için kullanıldı. Doğrulanamazsa sıralama kullanılmaz; ücrete göre ilk 6 havuz yürütülür.
- **ShadowV4Adapter:** Araştırma yardımcısı. Adversarial testleri var (`test/shadow-adapter.test.mjs`, mutasyon kontrolüyle). Adı değiştirilip production adapter yapılmayacak.
- **ShadowBagFactory:** Mock; her bagId için kayıtlı der. Gerçek BAG registry kanıtı değildir.

## 6. Router güveni ve Composer'sız DCA

- **planSigner güveni:** Mevcut `BagExecutionRouter`, backend `planSigner`'ın imzaladığı her calldata ve minimumu çalıştırır. Bu güven modeli kapanmadan router DCA için etkinleştirilmez. İmzayı kaldırıp calldata'yı herkese açmak da kabul edilmez.
- **DcaComposerPlan:** Composer'a özel program doğrulaması korunuyor; genel moda sessizce taşınmadı.
- **Composer'sız DCA durumu:** BLOCKED (`lib/router-dca-gate.mjs`). Kapalı kapılar:
  - `PRICE_POLICY`
  - `PLAN_SIGNER_TRUST`
  - `ROUTER_PLAN_CONTRACT`
  - `BAG_REGISTRY`
  - non-archive RPC ile `SAME_BLOCK_EVIDENCE`
  - v4 seçilirse `V4_ADAPTER`
- **Kanıtlanan:** Dört token'lık BAG'in mevcut router ile fork'ta makbuz ve bakiye kanıtıyla alınabildiği. Bu bir araştırma yürütme kanıtıdır.
- **0x / Kyber:** Spender bağımsız doğrulanmadığı için yalnızca karşılaştırma amaçlı ölçülür, hiçbir zaman router seçimi olmaz (`EXCLUDED_UNVERIFIED`):
  - Kyber'de spender, target'a eşitlenip sonra "eşit" sayılmıyor.
  - 0x'te spender eksikse `transaction.to`'ya düşülmüyor.
- **1inch:** Yok; ölçülmedi.

## 7. SDK

- `verifyPurchaseReceipt`'in varsayılan davranışı değişmedi. Forwarded doğrulama açıkça seçilen bir mod olarak kalıyor (#126). Negatif LI.FI etkisi ayrı bir politika (#127).
- Bu kapanışta SDK'ya kod eklenmedi.

## 8. Production sınırları

- Hiçbir şey production için hazır sayılmıyor. Merge, deploy, public işlem ve gerçek fon kullanımı yok.
- Keeper, imza deposu ve veritabanı SDK'ya taşınmadı.
- Araştırma oturumu süreç içinde yaşar. Yeniden başlatılırsa yeni fork ve yeni imzalar gerekir; eski oturumun imzaları zaten bitiş süresini geçmiştir. Özel klasör: `wallet-fork/private/<oturum>/`, silinebilir.
