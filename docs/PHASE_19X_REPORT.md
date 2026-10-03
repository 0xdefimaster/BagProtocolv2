# Phase 19.X — Composability Spike — Rapor

Kapsam korundu: PurchasePlanner, CapabilityMatrix, production BagRouter,
gerçek deposit/shares/NFT/rebalancing — **hiçbiri yok**. Bu phase sadece iki
dar feasibility sorusuna cevap arıyor (19.X-A, 19.X-B).

`npx hardhat compile && npx hardhat test` bu teslimatta çalıştırıldı ve
**11/11 test geçti** (7 mevcut BagFactory testi + 4 yeni BagRouterSpike
testi) — konsol çıktısı aşağıda.

---

## STEP 0 — Varlık doğrulaması

- Robinhood Chain mainnet: chain id `4663`, Arbitrum Orbit L2, RPC
  `rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com`.
- Robinhood Chain testnet: chain id `46630`, RPC
  `rpc.testnet.chain.robinhood.com`, explorer
  `explorer.testnet.chain.robinhood.com`, faucet mevcut (0.1 test ETH/gün).
- Verilen token listesi (WETH/USDG/stock token'lar) **mainnet** asset
  registry'si — testnet'te bu adresler geçerli değil.
- Uniswap (v2/v3/v4 + UniswapX) mainnet'te gün-1'den beri deploy edilmiş,
  WETH/USDG çiftinde gerçek/derin likidite var. **Testnet'te** karşılık
  gelen bir DEX deploy'unu veya likidite havuzunu bağımsız olarak
  doğrulayamadım (sandbox'ımın RPC erişimi yok).
- **LI.FI, Robinhood Chain testnet'ini (46630) desteklemiyor.** LI.FI'nin
  kendi dokümantasyonu genel politika olarak testnet'leri desteklemediğini
  açıkça belirtiyor ("we do not support testnets... almost no liquidity"),
  ve mainnet 4663 için resmi destek var. Bu, spec'in "testnet + no real
  funds + LI.FI support" üçlüsünü aynı anda karşılamanın mümkün olmadığı
  anlamına geliyor — tam olarak sizin bir önceki mesajınızda öngördüğünüz
  ayrım (19.X-A / 19.X-B) bu çelişkiyi doğru şekilde çözüyor.

Sonuç: 19.X-A tamamen testnet + own-router ile, LI.FI'ye hiç dokunmadan
kurgulandı. 19.X-B ayrı, mainnet-fork üzerinde, ayrı gate ile bekliyor.

---

## PHASE 19.X-A — Robinhood Testnet Atomic Router Spike

### Ne yazıldı

- `contracts/spike/BagRouterSpike.sol` — iki leg'i (Leg A, Leg B) atomik
  execute eden minimal router. Her leg: `target` + `callData` + opsiyonel
  `approveToken`/`approveAmount`. Gerçek aggregator/router calldata
  şeklini taklit ediyor (approve-then-call, transferFrom-pull pattern) —
  Uniswap V3 SwapRouter / 0x / LI.FI target kontratlarının hepsi bu şekli
  kullanıyor, dolayısıyla burada kanıtlanan approval-model 19.X-B'ye
  doğrudan taşınabilir.
- `contracts/spike/TestSwapPool.sol` — "ONE known direct DEX swap" için en
  küçük stand-in: sabit kur, tek çift, constant-product matematiği yok
  (spec'in kapsamı zaten fiyatlama değil, atomicity).
- `contracts/spike/MockToken.sol` — testnet'te kendi kontrolümüzde,
  gerçek değeri olmayan, mint edilebilir ERC-20.
- `contracts/test/spike/BagRouterSpike.test.ts` — 4 test.

### Sandbox kısıtlaması ve nasıl aşıldı

`npx hardhat compile`, normalde solc'u `binaries.soliditylang.org`'dan
indirmeye çalışıyor — bu sandbox'ın network allowlist'i bunu engelliyor
(`HHE905`). Çözüm: `hardhat.config.ts`'te `solidity.path`'i `solc` npm
paketinin kendi WASM build'ine (`node_modules/solc/soljson.js`) yönlendirdim.
Bu, hem `MockToken.sol`/`TestSwapPool.sol`/`BagRouterSpike.sol`'un gerçek
solc 0.8.24 ile derlenmesini, hem de tüm test suite'in Hardhat'ın in-memory
EVM'inde (network erişimi olmadan) gerçekten çalışmasını sağladı. Bonus:
mevcut `contracts/test/BagFactory.test.ts` de artık ilk kez gerçekten
çalıştırılıp doğrulandı (önceki notu güncellendi).

### Test sonucu (gerçek konsol çıktısı)

```
BagRouterSpike — Phase 19.X-A composability spike
  ✔ SUCCESS: legA + legB both succeed -> composed swap succeeds atomically, no leftover approvals
  ✔ FAILURE (B reverts after A succeeds): entire transaction reverts, no partial state, no stuck funds
  ✔ FAILURE (A reverts, B never reached): entire transaction reverts, no partial state
  ✔ rejects a zero-address leg target rather than silently no-op-ing

11 passing (11 nodejs)
```

### Bunun kanıtladığı / kanıtlamadığı

**Kanıtladı (yerel EVM üzerinde, gerçek):**
- İki BAG-kontrollü leg tek transaction'da compose edilebiliyor.
- Herhangi bir leg revert ederse TÜM transaction revert ediyor (state,
  approval, bakiye — hiçbiri kalıcı olmuyor). Hem "B revert eder"
  hem "A revert eder" senaryosu ayrı ayrı test edildi.
- Router'da hiç fon takılı kalmıyor (input/mid/output bakiyeleri her
  senaryoda 0).
- Kullanılmayan approval'lar leg sonunda 0'a çekiliyor (leftover-approval
  saldırı yüzeyi kapalı).

**Kanıtlamadı (henüz):**
- Robinhood Chain Testnet'te (46630) gerçek bir broadcast. Sandbox'ımın
  RPC erişimi yok. `scripts/spike/deploy-19x-a.ts` + `scripts/spike/README.md`
  bunu sizin çalıştırmanız için hazır; çalıştırıldığında tx hash/chain
  id/block number üretip `19x-a-results.json`'a yazacak.
- Gerçek bir üçüncü taraf testnet DEX'i ile likidite — TestSwapPool
  kasıtlı olarak kendi kontrolümüzdeki bir stand-in, gerçek bir DEX iddiası
  değil.

### ONE-SIGNATURE bulgusu

`deploy-19x-a.ts`'deki akışta, `executeComposed()`'dan ÖNCE ayrı bir
`approve()` transaction'ı gerekiyor (router'ın kullanıcının input token'ını
çekebilmesi için). Yani şu an: **approve tx + composed tx = 2 imza, 1 imza
değil.** Bu spec'in Step 8'i uyarınca açıkça raporlanıyor — "one-click"
iddia edilmiyor.

Permit2/EIP-2612 analizi: `MockToken` düz bir OZ `ERC20`, `permit()`
implement etmiyor. Gerçek Robinhood Chain token'ları (WETH/USDG/stock
token'lar) için EIP-2612 desteği doğrulanmadı — bu, 19.X-B'nin veya bir
sonraki spike'ın konusu olmalı: gerçek token kontratlarının `permit()`'i
var mı, yoksa Permit2 (Uniswap'ın canonical allowance kontratı, Robinhood
Chain'de Uniswap resmi olarak deploy edildiği için muhtemelen mevcut) mı
kullanılmalı. Bu spike'ta implement edilmedi — sadece tespit edildi.

**19.X-A PASS/FAIL: PASS (yerel/mantıksal düzeyde). Testnet broadcast'i
bekliyor — sonuç PASS olarak kesinleşmesi için `deploy-19x-a.ts`
çalıştırılıp gerçek tx hash'in rapora eklenmesi gerekiyor.**

---

## PHASE 19.X-B — LI.FI Mainnet-Fork Composability

**Bu turda gerçekten denendi** (önceki not — "başlatılmadı" — artık
güncel değil). Aynı iki engel bu oturumda da bağımsız olarak doğrulandı,
bu kez tahminle değil, doğrudan komutla:

```
$ curl -m 5 -o /dev/null -w '%{http_code}\n' https://li.quest/v1/chains
403
$ curl -m 5 -o /dev/null -w '%{http_code}\n' https://rpc.mainnet.chain.robinhood.com
403
```

`web_search`/`web_fetch` üzerinden LI.FI dokümantasyonuna ulaşmayı da
denedim (farklı bir ağ erişim yolu olabilir diye) — bu oturumda arama
aracının kendisi art arda `Server error (500)` döndürdü (geçici bir altyapı
sorunu, içerik engeli değil). Hiçbir yoldan gerçek bir quote elde edilemedi.
Talimat gereği quote uydurulmadı, LI.FI mock'lanmadı.

**Bu turda gerçekten hazırlanıp doğrulanan altyapı:**

- `hardhat.config.ts`'e `robinhoodFork` network'ü eklendi. **Önemli bulgu:**
  `ROBINHOOD_MAINNET_RPC_URL` set edilmeden bu network'e bağlanmak HATA
  VERMİYOR — Hardhat sessizce boş bir yerel zincire (chainId 31337) düşüyor.
  Bu, fark edilmezse spike'ı anlamsız kılacak sinsi bir tuzak — bu yüzden
  `scripts/spike/19x-b/run.ts`'e gerçek fork olup olmadığını (chainId 4663
  + USDG adresinde gerçek bytecode) doğrulayan bir preflight kontrolü
  eklendi ve iki senaryoda da (RPC yok / RPC var ama erişim engelli) doğru
  şekilde ve yüksek sesle fail ettiği bizzat çalıştırılarak kanıtlandı.
- `contracts/spike/BagRouterSpike.sol` (19.X-A'dan, değişmedi) — `Leg`
  struct'ının gerçek bir LI.FI `transactionRequest`'i hiçbir kontrat
  değişikliği olmadan kabul edebileceği tekrar doğrulandı.
- Tam adımlar, quote şablonu (`lifi-quote.example.json`) ve neyin hâlâ
  eksik olduğu (`run.ts`'in durduğu nokta: gerçek quote olmadan hangi
  token holder'ının impersonate edileceği bilinemiyor) `scripts/spike/19x-b/README.md`'de.

**19.X-B PASS/FAIL: BLOCKED/INCONCLUSIVE — sahte bir sonuç üretilmedi.**
LI.FI composability sorusu spec'in `LI.FI_COMPOSABILITY_FAILED` etiketini
hak edecek şekilde test edilmedi (bu etiket sadece gerçek bir denemeden
sonra, gerçek bir başarısızlık gözlemlenirse konur) — ne PASS ne FAIL,
sadece "denenemedi".

---

## DELIVERABLE özeti (spec'in istediği format)

| Soru | Cevap |
|---|---|
| 19.X-A | PASS (yerel), testnet broadcast bekliyor |
| 19.X-B | BLOCKED/INCONCLUSIVE — LI.FI API + Robinhood mainnet RPC erişimi bu oturumda da doğrulanarak engellendi (403, iki ayrı yöntemle) |
| One transaction | 19.X-A içinde EVET (`executeComposed` tek tx); 19.X-B için bilinmiyor |
| One user confirmation | 19.X-A: HAYIR — ayrı bir `approve()` tx gerekiyor; 19.X-B için bilinmiyor |
| Atomic rollback | 19.X-A: EVET — 4 testle kanıtlandı (yerel EVM); 19.X-B (LI.FI leg'i için): bilinmiyor |
| LI.FI composability | BLOCKED/INCONCLUSIVE — "FAILED" değil, çünkü hiç denenemedi |
| Approval issue | approve() + executeComposed() = 2 tx; Permit2/EIP-2612 mümkün ama implement edilmedi |
| Final recommendation (A/B/C) | **Seçilmedi.** LI.FI leg'i hiç test edilmeden A/B/C arasında seçim yapmak, tahmini öneri gibi sunmak olurdu — bkz. `scripts/spike/19x-b/README.md`'nin "Final recommendation" bölümü |

**Sonraki adım (değişmedi):** `scripts/spike/deploy-19x-a.ts`'yi VE
`scripts/spike/19x-b/run.ts`'yi gerçek ağ erişimi olan bir ortamda
çalıştırıp sonucu paylaşın. İkisi de PASS olmadan production mimarisine
geçilmiyor — bu talimat gereği bu spike'tan sonra durduruldu.
