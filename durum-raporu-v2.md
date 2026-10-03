# Bag Protocol — Creator Rewards / Redemption — Durum Raporu (v2)

Önceki `durum-raporu.md`'nin devamı. `public/assets` ve `tsconfig.tsbuildinfo` yine zip'e dahil edilmedi.

## Bu turda eklenenler ✅

### Katman 2 — Performance Fee (creator'ın kendi bag'inden kâr payı)
- `types/basket-protocol.ts`: `BasketRecipe.performanceFeeBps` (opsiyonel, max %30 — `MAX_PERFORMANCE_FEE_BPS`). Eski "NOT IMPLEMENTED" notu, artık verilmiş tasarım kararlarıyla değiştirildi.
- **High-Water-Mark'a gerek yok**: `apply_redeem_execution()` zaten `cost_basis_quote`'u redemption'da share oranına göre düşürüyordu (önceki turda hazırlanmış) — bu sayede her redemption'ın kârı `(bu redemption'ın değeri − tükettiği cost basis)` olarak hesaplanıyor. Bir kâr asla iki kez vergilendirilmiyor, bir zarar asla vergilendirilmiyor, ayrı bir HWM kolonu gerekmiyor.
- `supabase/migrations/0013_add_creator_rewards.sql`: `apply_redeem_execution()` genişletildi (`p_redeem_value_quote`, `p_performance_fee_bps`, `p_creator_id`) — kâr, bu bag'in KENDİ creator'ının `portfolios.cash_balance`'ına aynı transaction içinde kredileniyor.
- `lib/server/redeem-execution.ts`: creator id + recipe'den `performanceFeeBps` çözülüp RPC'ye geçiliyor.
- Validasyon: `validators.ts`/`codes.ts`'e `INVALID_PERFORMANCE_FEE` eklendi (0–3000 bps aralığı zorunlu).
- Her recipe oluşturma noktası güncellendi (`bag-mapper.ts`, `recipe.ts`, fork route) — fork edilen bag kendi fee'sini **0'dan** başlıyor (forker'ın seçmediği bir ücreti sessizce miras almasın diye).

### Katman 3 — Fork Royalty
- `lib/config/rewards.ts`: `FORK_ROYALTY_BPS = 150` (%1.5).
- Aynı migration'da `apply_purchase_execution()` genişletildi (`p_fork_royalty_bps`, `p_root_creator_id`) — bir fork'a yapılan her deposit'in %1.5'i, aynı transaction içinde ROOT creator'ın `portfolios.cash_balance`'ına kredileniyor. Root creator kendi forkuna yatırım yaparsa kendine ödeme yapılmıyor (self-guard).
- `lib/server/purchase-execution.ts`: bag'in `rootBagId`'si varsa root bag'in creator'ı çözülüp RPC'ye geçiliyor.

### Önceki turun raporunda açıkça belirtilen mimari kısıt — bilerek aynı şekilde çözüldü
Bu protokolde havuzlanmış custody yok (her swap kullanıcının kendi cüzdanına gidiyor), bu yüzden **iki ödül de** (performance fee + fork royalty) on-chain transfer değil, `portfolios.cash_balance`'a gerçek, izlenebilir bir defter kaydı (ledger credit) olarak uygulandı — `activities` tablosunda audit-trail'i var. Bu, projenin geri kalanının zaten kullandığı paper-portfolio muhasebe modeliyle tutarlı; "sahte" değil, sadece "on-chain settlement" değil. On-chain hale getirmek (redemption/deposit'e yeni bir signed transfer leg eklemek) ayrı, daha büyük bir mühendislik işi olarak dokümante edildi.

### Doğrulama
- `npx tsc --noEmit`: sıfır yeni hata (yalnızca önceden var olan, ilgisiz Hardhat spike script hatası duruyor).
- `npx vitest run`: **430/430 test geçti** (önceki 428 + bu turda eklenen 2 yeni fork-royalty testi).
- Yeni testler: `purchase-execution.test.ts`'e fork royalty için 2 odaklı test eklendi (root creator doğru çözülüyor mu, fork olmayan bag'de royalty sıfır mı).

## Hâlâ eksik / bilerek yapılmayan

- **Redemption'ın kendisi için otomatik test yok** — önceki oturum bunu manuel + tsc ile doğrulamış, otomatik test yazmamış. Bu turda da (performance fee eklerken) yeni bir test dosyası açmadım, mevcut boşluğu büyütmedim ama kapatmadım da.
- **Fee'yi Create Bag UI'ında göstermek/seçtirmek** — backend/API `performanceFeeBps`'i kabul ediyor (yoksa 0), ama creator'ın bunu bag oluştururken bir form alanından seçmesi için arayüz değişikliği yapılmadı.
- **On-chain settlement** — yukarıda açıklandığı gibi bilinçli olarak yapılmadı, gelecek faz.

## Özet tablo

| Parça | Durum |
|---|---|
| Kişi başına pay/varlık defteri (Layer 0) | ✅ |
| Fork butonu → gerçek backend (Layer 1) | ✅ |
| Redemption (çıkış) — backend + UI | ✅ |
| Performance fee (Layer 2) | ✅ (bu turda) |
| Fork royalty (Layer 3) | ✅ (bu turda) |
| Fee'yi Create UI'ında seçtirme | ❌ |
| Ödülleri on-chain'e taşıma | ❌ (bilinçli, gelecek faz) |
