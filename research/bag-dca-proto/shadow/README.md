# Gölge ölçüm: Composer'sız yürütme kaynakları (salt okuma)

Aynı BAG, aynı tutarlar ve tek bir sabitlenmiş fork bloğu üzerinde yürütme kaynaklarını karşılaştırır. Public ağa işlem gönderilmez. Bütün teklifler, yalnızca okuma isteklerine izin veren bir relay'in arkasındaki izole fork'ta alınır. API kaynakları yalnızca calldata döndürür; bu calldata fork'ta yürütülür.

## Ne kullanır
- **Graf:** Uygulamanın kendi kodu oluşturur: `calculateDepositAllocation` → `buildExecutionPlan` → `buildBagExecutionGraph` → `assertValidExecutionGraph`, `computeBagExecutionGraphHash`.
- **Sepet yürütme:** Uygulamadaki mevcut `contracts/BagExecutionRouter.sol` değiştirilmeden, fork'ta deploy edilir. Bu deploy için iki yardımcı kullanılır: BagFactory yerine geçen `ShadowBagFactory` ve yerel bir plan imzalayan anahtarı.
- **Kaynaklar:**

| Kaynak | Nasıl ölçülür | Router ile uyum |
|---|---|---|
| `uniswap-v3` | QuoterV2. Ücret seviyeleri 100/500/3000/10000; havuzlar resmi factory'den | SwapRouter02: çağrılan adres = onay verilen adres ✅ |
| `uniswap-v4` | PoolManager `Initialize` olaylarından bütün havuzlar bulunur. Toplu `extsload` ile aralık içi likiditesi olanlar ayıklanır. En derin 3 havuz fork'ta takas edilir | Araştırma adaptörü `ShadowV4Adapter` ✅. Universal Router yolu Permit2 ile çeker, yani çağrılan adres ≠ onay verilen adres |
| `kyberswap` | `/routes` + `/route/build`. Calldata fork'ta yürütülür, çıktı alıcıda ölçülür | `routerAddress` hem hedef hem harcama adresi mi, kontrol edilir |
| `0x` | `/swap/allowance-holder/quote` (`ZEROX_API_KEY`). Calldata fork'ta yürütülür | `transaction.to` ile `issues.allowance.spender` karşılaştırılır |
| `composer` | SDK `compileBag` (`LIFI_API_KEY`, `--sdk`). Tek işlem bütün sepeti alır | ❌ Onay proxy'ye verilir, çağrı factory ya da proxy'ye gider |

1inch bu sürümde yok.

## Sınıflandırma
| Durum | Anlamı |
|---|---|
| `OK` | Rota var; fork'ta tam tutarla takas edildi |
| `NO_POOL` | Bu kaynakta çift için havuz yok |
| `NO_LIQUIDITY` | Havuz var ama takas başarısız ya da kısmi doldu (v4'te aralık içi likidite yok) |
| `NO_ROUTE` | API rota bulamadı |
| `BAD_PRICE` | Tam tutarın birim fiyatı, aynı rotada %1'lik deneme takasından 500 bps'ten fazla kötü (ince likidite) |
| `UNSUPPORTED` | Hook'lu havuz reddetti, çıktı alıcıya gelmedi ya da işlem tipi desteklenmiyor |
| `RPC_ERROR` | Taşıma hatası ya da budanmış durum (`historical state … is not available`). **"Likidite yok" sayılmaz** |
| `API_ERROR` | HTTP ya da erişim hatası |
| `NOT_RUN` | Anahtar ya da `--sdk` verilmediği için çalıştırılmadı; tahmin yapılmaz |

`vsBestBps`: aynı bacakta en iyi `OK` sonuca göre fark. Sepet adımında her bacak için router'la uyumlu en iyi `OK` aday seçilir. Hepsi mevcut router'dan gerçek çağrı sırasıyla geçirilir. Minimum = tek başına alınan teklif − `min(BAG swapSlippageBps, 300)` bps. Gerçekleşen çıktı tek başına alınan teklifle karşılaştırılır.

## Çalıştırma (bakımcı makinesi)
```powershell
cd <BagProtocolv2 main checkout>
npx tsx <proto>\shadow\measure.ts --app . --bag <bag.json> --amounts 5,100,1000 `
  --sources uniswap-v3,uniswap-v4,kyberswap,0x,composer --env-file <path>\.env.local `
  --sdk <BagProtocolv2-integ>\packages\bag-sdk
```
- **`ROBINHOOD_RPC_URL` arşiv destekli olmalı.** Public RPC eski blok durumunu siliyor; uzun bir ölçümde sonuçlar `RPC_ERROR` olur. Kaç sonucun bundan etkilendiği raporda `prunedStateErrors` alanında görünür.
- Anahtarlar yalnızca env dosyasından okunur ve rapora yazılmaz.
- **KyberSwap zincir adı:** `--kyber-chain` varsayılanı `robinhood` ve doğrulanmadı. Yanlışsa sonuç `API_ERROR` olur.
- Çıktılar: `shadow/out/<koşu>/results.json` ve `summary.md`.
