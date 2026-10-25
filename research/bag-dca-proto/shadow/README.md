# Gölge ölçüm: Composer'sız yürütme kaynakları (salt okuma, v2)

Aynı BAG ve aynı tutarlar için yürütme kaynaklarını karşılaştırır. Public ağa işlem gönderilmez:

- Bütün takaslar, salt okuma relay'inin (`lib/fork-env.mjs`) arkasındaki izole fork'ta yapılan yerel işlemlerdir.
- Relay yalnızca okuma metotlarını kabul eder; tekli ve batch istekte bir yazma metodu varsa isteğin tamamını reddeder. Hangi metodun kaç kez iletildiği, reddedilen istekler ve yeniden denemeler raporun `relay` alanına yazılır.

**Gerçekleşen çıktı simülasyondan alınmaz.** Her aday fork'ta yürütülür. Çıktı, makbuz ve alıcının öncesi/sonrası bakiyesinden ölçülür; makbuzdaki Transfer loglarıyla karşılaştırılır. İşlemin izi (`callTracer`) snapshot geri alınmadan önce `traces/` altına yazılır.

## Kanıt aşamaları (`stage`)
| Aşama | Anlamı |
|---|---|
| `QUOTED` | Yalnızca API ya da quoter rakamı |
| `SIMULATED` | `eth_call` sonucu (örneğin v3 QuoterV2; `quotedOutRaw` alanında ayrı tutulur) |
| `FORK_EXECUTED` | Fork'ta işlem çıktı, ama aşağıdaki kontrollerden biri tutmadı (`issues`) |
| `RECEIPT_VERIFIED` | Bütün kontroller tuttu: makbuz başarılı, debit = amountIn (tam), alıcıya çıktı > 0, Transfer logları iki bakiye farkına eşit, target ve spender'da transit bakiye yok, onay 0'a döndü |

## Durumlar (`status`) ve uygunluk (`eligibility`) ayrı alanlar
- **Durum:**
  - `OK`: makbuzla doğrulandı.
  - `NO_POOL`, `NO_LIQUIDITY`: aralık içi likidite 0.
  - `PARTIAL_FILL`: adaptör `PartialFill`.
  - `REVERTED`: çözülmüş hata ve revert yeri ile.
  - `RPC_ERROR`, `PRUNED_STATE`: taşıma hatası ya da silinmiş geçmiş durum. **"Likidite yok" sayılmaz.**
  - `API_ERROR`, `NO_ROUTE`.
  - `NOT_RUN`: anahtar yok.
  - `LAYOUT_UNVERIFIED`: v4 depolama yerleşimi doğrulanamadı.
  - `EXCLUDED_UNVERIFIED`.
- **Uygunluk:**
  - `ELIGIBLE`.
  - `HOOK_NOT_ALLOWLISTED`.
  - `EXCLUDED_UNVERIFIED`: Kyber ve 0x.
  - `NOT_ROUTER_COMPATIBLE`: Composer.
- **Fiyat kapısı:** `gate`, `lib/price-gate.mjs` tarafından hesaplanır. Gönderilen politikayla en iyi sonuç `PRICE_POLICY_UNPROVEN`'dır (`DECISIONS.md` §4).

## Blok modu
- **`single`:** Tek fork bloğu. Her aday aynı snapshot'tan başlar. Uzun koşu boyunca eski durum okunacağı için **arşiv RPC** gerekir. `--block <n>` ile sabitlenebilir.
- **`per-unit`:** Non-archive yedek mod. Her bacak ve her sepet için yeni bir fork açılır.
  - Bir bacağın kaynakları ve tutarları aynı bloktadır.
  - Farklı bacaklar ve sepet aynı blokta değildir. Rapor bunu `NON_ARCHIVE_PER_UNIT` diye etiketler.
  - Sepet adımında seçilen rotalar sepet bloğunda yeniden yürütülür (`basketIsolated`).
- **`auto`:** Varsayılan. RPC'nin 500.000 blok önceki durumu okuyup okuyamadığına bakar. `--block-mode single` istenip RPC arşiv değilse çıkış 2 olur (`ARCHIVE_REQUIRED`).

## Kaynaklar
| Kaynak | Nasıl | Router seçimi olabilir mi |
|---|---|---|
| `uniswap-v3` | Her ücret seviyesi (100/500/3000/10000) için: havuz factory'den, aralık içi likidite havuzdan okunur (ölçüm bloğunda). QuoterV2 sonucu `SIMULATED` olarak kaydedilir. Tam tutar ve %1 probe SwapRouter02 ile fork'ta yürütülür | ✅ |
| `uniswap-v4` | Havuzlar `Initialize` loglarından bulunur (ölçüm bloğuna kadar). Likidite ve `slot0` fork'tan `extsload` ile okunur. **Yerleşim doğrulanır:** her havuzda tick'in fiyatla ve lpFee'nin key'le uyuşması kontrol edilir; son durum değiştiren olayı Swap olan havuzlarda saklanan likidite, fiyat ve tick o Swap'ın yaydığı değerlerle aynı olmalı. En derin 3 havuz `ShadowV4Adapter` ile yürütülür | ✅ hook'suz; hook'lu → `HOOK_NOT_ALLOWLISTED` |
| `kyberswap` | Yalnızca karşılaştırma. API tek bir `routerAddress` döndürüyor; spender'ın buna eşit olduğu doğrulanmıyor | ❌ `EXCLUDED_UNVERIFIED` |
| `0x` | Yalnızca karşılaştırma. `issues.allowance.spender` yoksa yürütülmez; `transaction.to`'ya düşülmez | ❌ `EXCLUDED_UNVERIFIED` |
| `composer` | SDK `compileBag` ile tek işlemde bütün sepet. `LIFI_API_KEY` ve `--sdk` gerekir; yoksa `NOT_RUN` | ❌ |

- **Varsayılan `--sources`:** `uniswap-v3,uniswap-v4,composer`. Bilinmeyen bir kaynak adı çıkış 2 verir.
- **1inch:** Yok; ölçülmedi.

## Sepet
- Her bacak için uygun ve `RECEIPT_VERIFIED` olan en iyi aday seçilir. Hepsi uygulamadaki **değiştirilmemiş** `BagExecutionRouter` ile tek işlemde yürütülür.
- Plan yerel bir test `planSigner` anahtarıyla imzalanır. Bu, router'ın mevcut güven modelidir ve kapanmadı.
- BagFactory yerine `ShadowBagFactory` mock'u kullanılır; bu registry kanıtı değildir.
- Minimum: tek başına gerçekleşen çıktı − `min(swapSlippageBps, 300)` bps.
- **Sepet kanıtı:**
  - makbuz ve `ExecutionCompleted` olayı
  - taker'ın USDG debit'i (tam)
  - her token için router'dan taker'a giden Transfer logları = bakiye farkı
  - router ve target'larda transit bakiye yok
  - onay 0
- **Composer'sız DCA hazırlığı:** `routerDca` (`lib/router-dca-gate.mjs`). Kapılar kapalı olduğu sürece `BLOCKED`.

## Çalıştırma
```
start.cmd shadow --app "C:\...\BagProtocolv2" [--env-file "C:\...\.env.local"] [--sources uniswap-v3,uniswap-v4,composer] [--block-mode auto]
```
- **Launcher'ın yaptıkları:**
  - Sürüm kontrolü: bu klasördeki sabitlenmiş `tsx` 4.23.15 kullanılır; `npx` yok.
  - `measure.ts` uygulamanın TypeScript'iyle typecheck edilir.
  - Çıktılar: `shadow\out\<oturum>-shadow\results.json`, `summary.md`, `traces\`.
- **Çıkış kodları:**
  - 0: tamam
  - 1: fatal
  - 2: kullanım hatası ya da `ARCHIVE_REQUIRED`
  - 3: eksik (`RPC_ERROR`, `PRUNED_STATE`, `API_ERROR`)
  - 4: sepet yürütülemedi
- **Rapor:** Hata olsa da yazılır; relay ve fork kapatılır.
- **Anahtarlar:** `--env-file`'dan yalnızca `ROBINHOOD_RPC_URL`, `LIFI_API_KEY`, `ZEROX_API_KEY` ve `KYBER_CLIENT_ID` okunur; rapora yazılmaz.
