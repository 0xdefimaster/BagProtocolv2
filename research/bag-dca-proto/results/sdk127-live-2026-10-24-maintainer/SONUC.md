# #126 + #127 bağımsız canlı Composer / yerel fork kontrolü

SDK entegrasyon commit'i: f8d73b487929d196ff83ac09dee260987e171a40. PR #127: a879ff1; PR #126: 3f85a4c. Hiçbir PR merge edilmedi.

## Sonuç

- SDK build ve proje TypeScript kontrolü başarılı.
- SDK testleri: 312 PASS / 0 FAIL. Bütün repo testleri burada yeniden çalıştırılmadı.
- Yeni canlı Composer teklifleriyle fork: 34 PASS / 0 FAIL.
- A modelinde iki, B modelinde iki adet 5 USDG alımı gerçekleşti. Dört yeni-mod makbuzu VERIFIED.
- Aynı dört işlem eski modda INPUT_BALANCE_BELOW_PLAN ile reddedildi; eski davranış korundu.
- Kaynak tam takas payını harcadı, kullanıcı minimum token çıktılarını aldı; planın bakiyesi değişmedi ve geçici izin sıfırlandı.
- Hatalı swap denemelerinde fon hareketi ve sayaçlar geri alındı. B'nin delegasyon sayaçları da geri alındı.

## Negatif teklif kapsamı

- A-4: 13 bps, kaynak harcaması 5000000 ham USDG
- A-6: 13 bps, kaynak harcaması 5000000 ham USDG
- B-4: 15 bps, kaynak harcaması 5000000 ham USDG
- B-6: 15 bps, kaynak harcaması 5000000 ham USDG

Negatif teklif kullanılarak doğrulanan alım sayısı: 0. Durum: NOT_TESTED_NO_NEGATIVE_QUOTE_IN_THIS_RUN.
Bu koşudaki teklifler pozitifti. Negatif fiyat etkisinin canlı alımda yürütüldüğü sonucu çıkarılamaz; ilgili sayısal kabul/ret kuralları SDK birim testlerinde sınandı.
Teklifleri seçmek için retry, tutar/sepet değişikliği veya kontrol atlama yapılmadı. Tüm derlemelerin seçilmiş ham fiyat alanları results.json / quoteAttempts içindedir.

## Leo'nun yanıtının kapsamı

Kullanıcının aktardığı LI.FI yanıtı negatif fiyat etkisinin geçerli olduğunu ve giriş/çıkış değerlerinin karşılaştırıldığını teyit ediyor. Kesin yuvarlama yöntemi açıklanmadı; ±1 bps hâlâ SDK'nın açıkça belgelenmiş uyumluluk toleransı.
PR açıklamasındaki negatif değerin geçerliliği için yanıt beklendiği ifadesi bu mesajla güncellenebilir. Bütün formül/yuvarlama ayrıntıları teyit edildi diye yazılmamalı.

## Tekrarlanabilirlik / sınırlar

Fork bloğu 96879819. SDK dışı kaynaklar e6bdd10 fixture/wire ve kullanıcının önceki v2 prototipinden. Ek çalıştırıcı değişiklikleri yalnızca teklif alanlarının kaydı ve gerçekleşen alımlarla eşleştirilmesidir; diff pakette bulunur. SDK, plan kontratı, kontrol kuralları ve prototip zaman ayarları değiştirilmedi.
Bağımlılıklar aynı lockfile özetleri doğrulanarak önceki kurulumdan kullanıldı. Çalıştırıcıyı mevcut prototipin composer/ klasörüne koyup manifestteki komutla yeni çıktı klasöründe çalıştırabilirsiniz.
ArbSys için yalnızca blok-numarası getter modeli kullanılıyor; tam Nitro ortamı veya üretim güvenlik garantisi değildir. Zaman fork'ta ilerletildi; günlerce çalışan gerçek keeper ölçülmedi.
Gerçek MetaMask/Rabby imzaları henüz denenmedi. Açık zincire işlem gönderilmedi; ortam dosyası, anahtarlar, bağımlılıklar ve cache pakete dahil değil.
