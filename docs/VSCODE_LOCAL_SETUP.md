# VS Code'da localhost'ta çalıştırma — sıfırdan gerçek satın almaya

Her adımda **gerçek para/gas gerekip gerekmediği** açıkça yazıyor. Neyin kodda
doğrulandığı, neyin canlı ortam gerektirdiği: [`STATUS.md`](STATUS.md).

> **GERÇEK PRIVATE KEY'LERİ ASLA REPOYA KOYMA.** Hepsi `.env.local`'e gider
> (`.gitignore` bunu hariç tutuyor). `.env.example`'a gerçek değer yazma.

---

## 0) Kurulum (para gerekmez)

**Node.js 24+ gerekli** (`@lifi/composer-sdk` bunu şart koşuyor; `package.json`
`engines` ve `.nvmrc` aynı sürümü söylüyor). Node 22'de `npm install`
`EBADENGINE` uyarısı verir — o sürüm desteklenmiyor.

```bash
nvm install && nvm use      # .nvmrc'den Node 24'ü kurar/seçer
node -v                     # v24.x olmalı
npm ci
cp .env.example .env.local
```

**Görseller:** Logo dosyaları `public/` altında: `logo.png`, `logo-full.png`,
`hero/glass-mark.png` (`landing-update` branch'inden alındı).

## 1) Supabase (para gerekmez, ücretsiz tier yeterli)

1. supabase.com'da yeni proje aç.
2. **Yeni proje:** `supabase/schema.sql`'i SQL editöründe çalıştır (tüm
   migration'ları, 0033–0036 dahil, zaten içerir).
   **Var olan proje:** `supabase/migrations/` altındaki eksik migration'ları
   sırayla uygula.
3. `.env.local`'e doldur: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

Supabase olmadan da sayfa açılır: anasayfa "bu deploy veritabanına bağlı
değil" der, Hero kartında **EXAMPLE** rozeti görünür. Sahte veri gösterilmez.

## 2) Auth secret (para gerekmez)

```bash
openssl rand -base64 32   # -> SESSION_SECRET
```

## 3) Robinhood RPC ve fiyatlama (para gerekmez)

- **RPC (Alchemy önerilir):** `ALCHEMY_API_KEY=` doldurman yeterli. Dört
  zincirin (Ethereum, Arbitrum, Base, Robinhood) hepsi için URL kod tarafından
  kuruluyor, örneğin `https://robinhood-mainnet.g.alchemy.com/v2/<key>`.
  - İstersen ikinci bir sağlayıcı da ekleyebilirsin (QuickNode vb.):
    `ROBINHOOD_RPC_URL_SECONDARY=https://...`
  - Alchemy ya da ikinci sağlayıcı cevap vermezse sistem kendiliğinden
    zincirin resmi public RPC'sine geçer (Ethereum'un public RPC'si yok).
  - Anahtar sadece sunucu tarafında kalır, tarayıcıya gitmez.
  - Ayrıntı: [`docs/PRICE_AND_DATA_LAYER.md`](PRICE_AND_DATA_LAYER.md)
- **Kripto fiyatları:** LI.FI'dan geliyor (tüm zincirler). `LIFI_API_KEY`
  zaten kullandığın anahtar, rate limit'i yükseltiyor.
- **Robinhood hisse (Stock Token) fiyatları — anahtar gerekmez:** Robinhood'un
  kendi API'si kullanılıyor:
  - `api.robinhood.com/rhj/assets` → hangi kontrat gerçek Stock Token
    (aynı ticker'lı sahte kontratlar reddedilir)
  - `api.robinhood.com/rhj/prices/AAPL` → bid/ask. Bu **hisse başı ham
    fiyat**; kod bunu `currentMultiplier` ile çarpıp **token başı** fiyata
    çeviriyor (ör. CRWD'de multiplier 4.0).

  Hiçbir şey ayarlamadan çalışır. Bag sayfasının **Composition** sekmesinde
  `$213.45 / $213.47` gibi bid/ask görünür (15 sn'de bir yenilenir).
  Kontrol: `npx tsx scripts/verify-robinhood-stock-api.ts AAPL CRWD`
- **Opsiyonel — Chainlink:** docs.chain.link'teki Robinhood feed adreslerini
  `ROBINHOOD_CHAINLINK_FEEDS={"0x<token>":"0x<feed>"}` olarak verirsen
  Robinhood API fiyatı zincir üzerinde Chainlink ile doğrulanır. %2'den fazla
  fark varsa fiyat verilmez (fail-closed).
- **LI.FI'da fiyatı olmayan Robinhood kripto varlıkları için yedek:** Uniswap
  v3 TWAP (USDG'ye karşı). Havuzunu
  `ROBINHOOD_PRICE_POOLS={"0x<varlık>":"0x<havuz>"}` ile ver.
  Kontrol: `npx tsx scripts/verify-robinhood-price.ts`
- Ayrıntı: [`docs/ROBINHOOD_PRICE_AUTHORITY.md`](ROBINHOOD_PRICE_AUTHORITY.md)
- **Diğer zincirler:** `COINGECKO_API_KEY=` (opsiyonel, önerilir).

## 4) Deployer cüzdanı — BURADAN İTİBAREN GERÇEK PARA/GAS GEREKİYOR

Robinhood Chain'de gaz için gerçek ETH gerekir. **Sadece bu iş için yeni bir
cüzdan** kullan (ana cüzdanını deploy key'i yapma).

```bash
export DEPLOYER_PRIVATE_KEY=0x...   # sadece terminal oturumunda; dosyaya yazma
```

## 5) BagFactory deploy (GERÇEK TX, GAS HARCAR)

```bash
export PROTOCOL_TREASURY_ADDRESS=0x...  # oluşturma ücretlerinin gideceği adres (zorunlu, ETH kabul etmeli)
export FACTORY_OWNER=0x...              # ücret/treasury yöneticisi; üretimde multisig (boşsa deployer)
export BAG_CREATION_FEE_ETH=0.00015     # ETH cinsinden oluşturma ücreti (zorunlu)
export BAG_CREATION_FEE_CAP_ETH=0.01    # değiştirilemez üst sınır (varsayılan 0.01 ETH)
npx tsx scripts/deploy-bag-factory.ts robinhood
```

Çıktıdaki `FACTORY_ADDRESS_ROBINHOOD=0x...` satırını `.env.local`'e yapıştır.

- **Oluşturma ücreti:** `createBag` payable; ücret native ETH olarak aynı
  işlemin `value`'su ile gönderilir ve doğrudan treasury'ye iletilir. Tek imza,
  approve yok. Ücret sabit wei tutarıdır; ETH fiyatı değiştikçe owner
  `setCreationFee` ile güncelleyebilir.
- `FACTORY_OWNER` sadece ücreti (üst sınırı aşmadan) ve treasury adresini
  değiştirebilir; hiçbir bag'e dokunamaz. Deploy key'ini işlem bitince at.
- Yeni factory yeni bir kayıt defteri demek: eski factory'deki bag'ler burada
  görünmez ve BagExecutionRouter yeni factory adresine göre deploy edilmeli.
- `createBag` artık payable (ETH ücreti). Bu değişiklikten **önce** deploy
  edilmiş bir factory varsa **yeniden deploy etmen gerekir**.

## 6) BagExecutionRouter deploy + allowlist (GERÇEK TX'LER, GAS HARCAR)

Ayrı bir `planSigner` cüzdanı oluştur (execution plan'larını imzalayan
sunucu-taraflı key; deploy key'inden ayrı sakla):

```bash
export PLAN_SIGNER_ADDRESS=0x...    # planSigner CÜZDANININ ADRESİ (private key değil)
export CANONICAL_TOKEN_ADDRESSES=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,<diğer token adresleri>

npx tsx scripts/deploy-bag-execution-router.ts robinhood <5. adımdaki FACTORY_ADDRESS_ROBINHOOD>
```

Bu komut kontratı deploy eder, Uniswap router'ı `setAllowedTarget` ile ve
verdiğin token'ları `setAllowedToken` ile allowlist'e ekler. Sonra
`.env.local`'e:

```
BAG_EXECUTION_ROUTER_ADDRESS=0x...
BAG_ROUTER_PLAN_SIGNER_KEY=0x...        # planSigner'ın PRIVATE KEY'i — elle ekle, script yazdırmaz
BAG_EXECUTION_COMPILER_ENABLED=true     # BAG Router ancak bu açıkken kullanılır
```

BAG Router yalnızca şu durumda devreye girer: flag açık + iki değişken set +
Bag Robinhood Chain'de ve zincirde deploy edilmiş.

**Alternatif (daha basit):** Bu adımı atla, sadece `LIFI_API_KEY` set et. O
zaman satın almalar LI.FI üzerinden yürür.

## 7) Çalıştır

```bash
npm run dev          # http://localhost:3000
```

Akış: cüzdanla bağlan → **Create** ile Bag oluştur (önce veritabanında DRAFT
olarak kaydedilir, zincire bir şey gitmez) → Bag sayfasındaki **Deploy**
paneli, `BagFactory.createBag()` işlemini **senin cüzdanına imzalatır**;
sunucu receipt'i zincirde doğrular ve Bag'i ACTIVE yapar. Sunucu hiçbir
zaman senin adına imza atmaz.

## 8) İlk satın almayı KÜÇÜK miktarla dene

Robinhood leg builder/quoter, Robinhood fiyat API'si ve TWAP fiyatlama **hiçbir zaman
canlı ortama karşı test edilmedi** (geliştirme ortamında erişim yoktu). İlk denemede:

- Birkaç dolarlık USDG ile başla.
- Sunucu loglarını izle; quote/fee-tier/calldata hatası çıkarsa logu getir.
- LI.FI'ı ayrıca doğrulamak için (önce dry-run, para harcamaz):
  `npx tsx scripts/spike/lifi-e2e-execute.ts` — ayrıntı:
  [`SPIKE-NOTE-lifi-quote.md`](archive/SPIKE-NOTE-lifi-quote.md)

## 9) Testler (localhost'ta)

```bash
npx tsc --noEmit
npm test                                   # unit
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npm run test:integration                 # gerçek PostgreSQL 14+ gerekir
npm run test:contracts
npm run build
```

Hâlâ eksik/canlı doğrulanmamış olanların güncel listesi: [`STATUS.md`](STATUS.md).
