# Phase 14 — LI.FI Live Quote Adapter — Rapor

Kapsam kesinlikle korundu: bu phase'de **hiçbir transaction, wallet approval,
swap/bridge tx, wallet signing, submission, holdings update, share mint,
redeem, Robinhood/ATLAS entegrasyonu yok**. Tek yapılan şey: mevcut
`ExecutionPlan`'ı LI.FI'nin `/v1/quote` endpoint'ine (SDK üzerinden)
göndermek ve dönen canlı quote'u tipli bir domain modeline çevirmek.

`npx tsc --noEmit`, `npx next lint`, ve `npx vitest run` bu teslimatta
**temiz** geçiyor (248/248 test, önceki 234 dahil — hiçbiri bozulmadı).

---

## 1. LI.FI package/version

`@lifi/sdk@^4.6.0` (npm'deki en güncel major/minor — kontrol edildi).
Sadece **core** paket eklendi; `@lifi/sdk-provider-ethereum`,
`-provider-solana` vb. eklenmedi. Bu paketler sadece SDK üzerinden bir
route'u **execute** etmek (wallet imzalama) için gerekli — `getQuote()` tek
başına yeterli. Bu, "ABSOLUTELY NO TRANSACTION EXECUTION" kısıtını
dependency seviyesinde de somutlaştırıyor: execution provider'ları hiç
yüklü değil, yani execute path'i bu koddan zaten erişilemez durumda.

`package.json` güncellendi (`dependencies.@lifi/sdk`).

## 2. Adapter architecture

Mevcut `ExecutionAdapter` interface'i (`lib/blockchain/execution-adapter.ts`)
**değiştirilmedi** (imzası aynı: `quoteExecutionPlan(plan): Promise<ExecutionResult>`
— zaten quote-only bir interface'ti, ayrıca bir `getQuotes`/`execute` ayrımı
gerekmedi çünkü execute hiç yok). Sadece `ExecutionStepQuote` ve
`ExecutionStepResult` şekli, LI.FI'nin gerçekten döndürdüğü alanlarla
genişletildi (bkz. §4). `MockExecutionAdapter` **bozulmadı** — yeni alanları
`null`/deterministik pass-through değerlerle dolduracak şekilde güncellendi,
davranışı (KEEP→null, deterministic output) aynı kaldı.

Yeni dosyalar:
- `lib/blockchain/lifi-config.ts` — chain-id mapping (`ChainId → LI.FI numeric id`) + memoized `SDKClient`.
- `lib/blockchain/lifi-execution-adapter.ts` — `liFiExecutionAdapter: ExecutionAdapter`, `isLive: true`, `name: 'lifi'`.

`mockExecutionAdapter`'ın export'u (`executionAdapter`) **değiştirilmedi** —
Phase 14 varsayılan davranışı flip etmiyor, `liFiExecutionAdapter` ayrı,
opt-in bir export (bkz. §8).

## 3. Quote request format

`getQuote(client, { fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, toAddress, slippage })`:

- `fromChain`/`toChain`: LI.FI'nin **numeric** chain id'si (`lifi-config.ts`,
  `@lifi/types`'ın kurulu paketinden doğrulandı: `ETH=1`, `ARB=42161`,
  `BAS=8453`, `SOL=1151111081099710`) — LI.FI'nin kısa "chain key" string'i
  değil, numeric id her zaman.
- `fromToken`/`toToken`: **her zaman `AssetIdentity.address`** — symbol asla
  gönderilmiyor (§6). `ExecutionRouteRequest` zaten symbol taşımıyor, bu
  yüzden yanlışlıkla symbol gönderme riski tip seviyesinde yok.
- `fromAmount`: `ExecutionRouteRequest.inputAmountRaw` — raw integer
  **string**, hiçbir yerde JS `number`'a çevrilmiyor (test: "raw amounts"
  büyük bigint ile doğrulandı).
- `slippage`: `ExecutionRouteRequest.slippageBps / 10000` (bps → 0–1 fraction).
- `fromAddress`/`toAddress`: **bilinçli bir sınırlama** — bkz. §12.

## 4. Multi-asset handling

`liFiExecutionAdapter.quoteExecutionPlan()`, `plan.steps` içindeki her
`SWAP` step için **ayrı** bir `getQuote()` çağrısı yapar (paralel,
`Promise.all`). `KEEP` step'leri için hiç çağrı yapılmaz. Sonuç, planın
step sırasıyla birebir eşleşen bir `ExecutionStepResult[]` — "quote
aggregation" testi bunu doğruluyor.

## 5. KEEP handling

`step.action === 'KEEP'` ise adapter LI.FI'ye hiç gitmez;
`{ step, quote: null, error: null }` döner (mock adapter'la aynı
convention — `error: null` olması, "hiç denenmedi" ile "denendi ve
başarısız oldu" arasındaki farkı `quote: null` tek başına ifade edemediği
için eklendi, bkz. §10).

## 6. Fee/gas handling

- `executionFeeRaw`: LI.FI'nin `estimate.feeCosts[]`'inden, **tek bir
  token'a ait olduğu doğrulanmışsa** toplanır (`sumSingleTokenRawAmounts`);
  karışık token varsa ya da veri yoksa `'0'`/`null` — asla uydurulmuyor.
- `gasCostRaw`/`gasCostAsset`: aynı mantık, `estimate.gasCosts[]`'ten.
- `protocolFeeRaw`: her zaman `"0"` — bu protokolün kendi performans/işlem
  ücreti mekanizması **henüz tasarlanmadı** (`types/basket-protocol.ts`'in
  kendi "Performance fee — NOT IMPLEMENTED" notuyla tutarlı) — LI.FI'nin
  kendi ücretiyle asla karıştırılmıyor.
- `priceImpact`: LI.FI'nin `/v1/quote` response şeması (resmi API
  referansından doğrulandı) top-level bir price-impact alanı **döndürmüyor**
  — bu yüzden bu alan bu phase'de her zaman `null`. Uydurulmadı, tahmin
  edilmedi; ileride LI.FI eklerse ya da başka bir kaynaktan hesaplanacaksa
  diye alan şimdiden var, ama boş.

## 7. Error mapping

`mapLiFiError()` (`lifi-execution-adapter.ts`), `@lifi/sdk`'nin attığı her
hata tipini 4 tipli koda indirger — UI hiçbir zaman ham stack trace görmez:

| LI.FI / SDK hatası                                   | Domain kodu       |
|-------------------------------------------------------|-------------------|
| `HTTPError` status 404 (QuoteNotFound)                 | `QUOTE_UNAVAILABLE` |
| `HTTPError` status 400 (InvalidQuoteRequest)           | `UNSUPPORTED_ROUTE` |
| `HTTPError` diğer status                               | `PROVIDER_ERROR`  |
| `UnsupportedChainError` (bilinmeyen `ChainId`)         | `INVALID_ASSET`   |
| `BaseError` — `Timeout`/`RpcUnavailable`/`ProviderUnavailable`/`RateLimitExceeded` | `PROVIDER_ERROR` |
| `BaseError` — `ValidationError`                        | `UNSUPPORTED_ROUTE` |
| `BaseError` — `NotFound`                                | `QUOTE_UNAVAILABLE` |
| Diğer her şey                                           | `PROVIDER_ERROR`  |

Hata bir step'e özel — bir step'in quote'u başarısız olursa diğer step'ler
etkilenmez (`Promise.all` her step'i bağımsız try/catch içinde çözer).
API route seviyesinde de aynı prensip: LI.FI'nin tamamen erişilemez olması
(`liFiExecutionAdapter.quoteExecutionPlan()`'ın kendisi reject olursa)
preview'in tamamını 500'e düşürmez — `preview.quotes: null` +
`preview.quotesError: <mesaj>` olarak deðraded olur, allocation/share
preview'i hâlâ geçerli kalır.

## 8. API route

**Yeni bir route açılmadı.** Mevcut
`POST /api/bags/:id/purchase-preview?quotes=true` — aynı route, opt-in bir
query flag. Gerekçe (spec §17'nin "kararı gerekçelendir" isteği):

- Quote, zaten bu route'un hesapladığı `executionPlan`'ın **ek verisi** —
  farklı bir pipeline değil, aynı pipeline'ın bir adım ilerisi.
- `?quotes=true` olmadan **hiçbir mevcut davranış değişmiyor** — eski
  client'lar (varsa) veya testler aynı response şeklini, aynı latency'yle
  almaya devam eder.
- Ayrı bir `/purchase-quote` route'u, `bag → recipe → verified assets →
  input asset → getBagNav → getShareSupply → computePurchasePreview` zincirini
  ya tekrar yazmak ya da bu route'a duplicate I/O yaptırmak anlamına
  gelirdi — spec'in kendisi bunu istemiyor ("gereksiz yere duplicate etme").

`computePurchasePreview()` (`lib/server/purchase-preview.ts`) **saf/senkron
kalması için değiştirilmedi** — LI.FI çağrısı (I/O, async) route handler'ında,
`computePurchasePreview()`'ın DIŞINDA yapılıyor; sonuç `preview` objesine
`quotes`/`quotesError` olarak eklenip response'a konuyor. Bu hem modülün
kendi "pure and synchronous" sözünü koruyor hem de spec §15'in "mümkünse
preview içine quote bilgisi opsiyonel olarak eklenebilir" önerisini
karşılıyor.

## 9. UI changes

`PurchasePreviewModal.tsx`:
- "Allocation" bölümü aynı kaldı.
- Eski "Execution" bölümü → **"Allocation vs. Live Quote"** oldu. Her SWAP
  step için: yükleniyorsa `Getting best route…` (spinner), quote geldiyse
  `≈ 0.1234 xNVDA via uniswap`, hata varsa `No route available` (ya da
  spesifik mesaj). KEEP step'leri `no route needed` etiketiyle kalıyor.
- Component hâlâ **hiçbir hesap yapmıyor** — her sayı server response'undan
  geliyor (`formatRawAmount`, mevcut convention).
- "Continue"/"Confirm Swap" butonu **hâlâ disabled** (`Not available yet`)
  — bu phase quote-only, execution UI'ı yok.

## 10. Tests

`lib/blockchain/__tests__/lifi-execution-adapter.test.ts` — **12 test**,
`@lifi/sdk`'nin `getQuote`'u `vi.mock` ile taklit edilmiş, gerçek network
çağrısı yok:

1. Single swap (`100 USDC → ETH` benzeri, tek SWAP step)
2. Multi swap (iki farklı hedefe iki ayrı `getQuote` çağrısı)
3. KEEP (hiç çağrı yapılmıyor, `quote`/`error` ikisi de null)
4. No route (`HTTPError 404` → `QUOTE_UNAVAILABLE`)
5. Ham hata sızmıyor (generic `Error` → `PROVIDER_ERROR`, mesaj temizlendi)
6. Output identity: aynı adres, farklı chain → iki ayrı, farklı `toChain`'li çağrı
7. Raw amounts: büyük bigint, string olarak korunuyor
8. Slippage: bps → fraction doğru forward ediliyor
9. Quote aggregation: planın her step'i sonuçta temsil ediliyor
10. Deterministic mock: aynı mock response → aynı output
11. No execution: `executeRoute` hiç çağrılmıyor, sadece `getQuote`
12. `name`/`isLive` şekli (`'lifi'` / `true`)

Ayrıca `lib/blockchain/__tests__/mock-execution-adapter.test.ts` — 2 test,
`MockExecutionAdapter`'ın yeni alanlarının (özellikle `priceImpact`/
`gasCostRaw` → her zaman `null`, hiç uydurulmuyor) doğru davrandığını
doğruluyor.

**Toplam: 248/248 test geçiyor** (234 eski + 14 yeni), hiçbir mevcut test
bozulmadı.

## 11. TypeScript

`npx tsc --noEmit` → temiz, 0 hata.

## 12. Lint

`npx next lint` → temiz (bu phase'in dokunduğu dosyalarda 0 warning/error;
projede önceden var olan, ilgisiz `<img>` warning'leri hariç).

## fromAddress — bilinçli sınırlama (ek not)

LI.FI'nin `/v1/quote`'u zorunlu bir `fromAddress` istiyor, ama bu phase'de
(ve genel olarak Phase 12/13 preview flow'unda) bağlı bir wallet **yok** —
`computePurchasePreview()` hiçbir wallet adresi almıyor, `PurchasePreviewModal`
wallet-connect içermiyor. Bu adapter, her chain ailesi için "sahibi olmayan"
bilinen bir placeholder adres kullanıyor (EVM: `0x000...dEaD` burn address;
Solana: System Program id). Bu **gerçek bir kullanıcı adresi değil** ve hiçbir
onay/işlem bu adres adına yapılmıyor — sadece route/pricing sorgusu için
gerekli bir zorunlu alanı dolduruyor. Bilinen sınırlama: LI.FI'nin
balance/allowance'a duyarlı bazı route seçimleri (örn. Permit2 kullanımı)
gerçek bir wallet için hafifçe farklılaşabilir; quote'un fiyat/route'u
kendisi wallet'a özel değil. Bir sonraki execution phase'i gerçek bir wallet
bağladığında, bu placeholder'ın gerçek `fromAddress`'le değiştirilmesi
gerekecek — `lifi-execution-adapter.ts`'deki `placeholderAddressFor()`
fonksiyonu bunun için tek değişiklik noktası olacak şekilde izole edildi.

## 13. Phase 15 önerisi

**Phase 15 — Wallet Connect + Real `fromAddress`/Approval Preflight.**
Önerilen kapsam (execution'a hâlâ girmeden):

- Bir wallet-connect katmanı (`lib/wallet-context.tsx` zaten var — mevcut
  connected address'i `PurchasePreviewModal`'a ve dolayısıyla
  `computePurchasePreview`/API route'a taşımak).
- `liFiExecutionAdapter`'a gerçek `fromAddress` geçirilmesi — placeholder'ın
  kaldırılması.
- LI.FI'nin `estimate.approvalAddress` + kullanıcının gerçek ERC-20
  allowance'ını (sadece **okuma**, approve YOK) karşılaştırıp UI'da
  "Approval needed" rozetini göstermek — hâlâ hiçbir tx gönderilmiyor,
  sadece mevcut approval durumunun read-only preview'i.
- Bu iki adım tamamlandığında Phase 16'da gerçek `approve` + `execute`
  execution'a (spec'in kendi "ATLAS/Robinhood Chain" ya da doğrudan LI.FI
  `executeRoute()`) geçmek güvenli bir zemine oturur.

**Phase 15'e geçilmedi.**
