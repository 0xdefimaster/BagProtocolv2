# SDK #126 düzeltmesinin bağımsız kontrolü

İncelenen commit: 3f85a4cf80e6d9cc4289d6d074fc7e000e0737ef. 24 Ekim 2026.

- SDK derlemesi ve proje TypeScript kontrolü başarılı.
- SDK testleri: 302 PASS / 0 FAIL.
- Sentetik makbuz kontrolü: tam tutar kabul; eksik, sıfır, negatif net harcama ve fazla harcama reddediliyor.
- Fork replay: 34 PASS / 0 FAIL. Dört alım yeni modda VERIFIED. Eski mod aynı işlemlerde INPUT_BALANCE_BELOW_PLAN ile reddediyor.
- Bu replay kayıtlı programı kullanır; yeni canlı teklifin çalıştırılması değildir.

## Canlı Composer yanıtı

Salt okunur yeni derleme isteğinde sunucu HTTP 200 ve Composer 0.11.3 / revision 9169cc8 döndürdü.
Seçilmiş ham alanlar: inputValueUsd=4.9918325034999995; outputValueUsd=4.99499414537114; impactBps=-6.
İstekteki maxPriceImpactBps=500 korundu. SDK bu yanıtı PRICE_IMPACT_INVALID ile reddetti; işlem gönderilmedi.

(giriş USD − çıkış USD) / giriş USD × 10000 hesabı -6.3336297219986495 veriyor. Bu, gözlenen tam sayı negatif değerle tutarlı bir çıkarımdır; resmî formül veya yuvarlama kuralının teyidi değildir.

composer-price-impact.json yalnızca seçilmiş yanıt alanlarını içerir. Önceki −7 yanıtının tamamı bu pakette yoktur; bu ayrı anda alınmış yeni −6 gözlemidir.

## Resmî kaynak araştırması

LI.FI FAQ fiyat etkisini giriş ve çıkışın USD değerlerinin farkıyla açıklar: https://docs.li.fi/faqs/slippage-price-impact
Composer SDK referansı maxPriceImpactBps için toplam USD fiyat etkisinin sınırını tanımlar: https://docs.li.fi/composer/composer-api/reference/sdk-api
İncelenen kaynaklarda Composer impactBps alanının negatif işareti ve yuvarlama yöntemi açıkça tanımlanmıyor. Belgeler bu ortamda okunabildi; erişim sorunu yerine tanım eksikliği kaldı.
docs.li.fi/openapi.yaml alındı (HTTP 200, 422960 karakter); içinde /compose, impactBps ve inputValueUsd bulunmadı. Genel LI.FI şeması Composer alanını doğrulamıyor.

## Sınırlar ve devam

Gerçek MetaMask/Rabby imzaları test edilmedi. Fork, ArbSys blok-numarası getter modelini kullanıyor; tam Nitro ortamı değildir. Açık zincire işlem, merge veya npm yayını yapılmadı. SDK kaynakları değiştirilmedi.

Önce LI.FI'den impactBps işareti/formülü/yuvarlama tanımı alınmalı. Gerekirse ayrı bir PR ile fiyat etkisi doğrulaması ele alınmalı; ardından yeni canlı teklif üzerinde fork alımı yeniden çalıştırılmalı. Bu sırada mevcut koruma atlanmamalı.

Anahtarlar, ortam dosyası, bağımlılıklar ve cache pakette yok. Sürümler/komutlar/özetler review-manifest.json içinde; ham test, sentetik prova ve replay sonuçları ayrı dosyalarda.
