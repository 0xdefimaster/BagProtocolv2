# Taze Composer teklifleriyle DCA yaşam döngüsü — 24 Ekim 2026

Bu sonuçlar bakımcının Windows makinesinde bağımsız olarak çalıştırıldı. Üretim uygulaması değiştirilmedi. Public ağa işlem gönderilmedi; gerçek para veya kullanıcının özel anahtarı kullanılmadı.

## İki koşu da pakette

| Koşu | Runner | Fork bloğu | Sonuç | Alım / forwarded VERIFIED |
|---|---|---|---|---|
| live-01 | ZIP v3'ün değiştirilmemiş runner'ı | 96966433 | 47 PASS / 8 FAIL | 4 / 4 |
| live-02 | A ve B için aynı başlangıç durumuna dönen test dalları | 96971122 | 71 PASS / 0 FAIL | 8 / 8 |

Her iki koşuda 22 canlı API derleme isteği var. Kayıtlı program replay'i kullanılmadı. İkinci koşuda fiyat etkileri 25 ve 26 bps; negatif teklif yolu bu koşuda denenmedi.

### İlk koşudaki ret

İlk ret B-6'da swap router'ından geldi. B-13/B-15/B-17 tanı izinde hedef 0x8e6fd69a77e88ee20ba4b4fbd59dfcda3ec0e98a ve çıktı hata selector'ü 0x63ecb9f6 kaydedilmiş. Selector, MinimalOutputBalanceViolation(address,uint256) ile eşleşiyor; token GME (0x1b0e319c6a659f002271b69db8a7df2f911c153e), ham çıktı hata değeri 53202723814801015. Beklenen başarılı alımlar gerçekleşmediğinden erken alım ve bütçe tüketimi testleri zincirleme beklenen koşula ulaşamadı.

Bağımsız A/B senaryolarının aynı fork'ta havuzları art arda değiştirmesini önlemek için A bitince ortak başlangıç snapshot'ına dönüldü, sonra B başladı. Değişiklik model-isolation.patch içinde; kontrat, min çıktılar, slippage, sepet ve yetki kontrolleri değiştirilmedi. Bu düzenlemede aynı delegasyonun kümülatif tüketim adımları arasında geri dönüş yok. Orijinal runner'daki ayrı B-17/B-18 dalı öncesi snapshot dönüşü aynen duruyor.

İkinci koşu farklı bir fork bloğunda ve yeni tekliflerle çalıştı. Bu yüzden sonuç havuz etkisi açıklamasını desteklese de tek değişkenli bir neden ispatı değildir. Sekiz alımın hepsinin tek ve kesintisiz bir zincir geçmişinde birlikte bulunduğu iddia edilmiyor: kararlar ilgili test dalında, snapshot geri alınmadan önce doğrulandı.

## Geçen kapsam

- A: üç alım, erken alım reddi, bütçe/sayı limiti, kullanılmamış izin varken iptal.
- B: iki normal alım; aynı delegasyonda dönemlik ve toplam limit tüketimi; ayrı çağrı limiti; delegasyonun kapatılması ve kalan 40 USDG'nin çekilmesi.
- Başarılı sekiz alımın tamamı SDK opt-in forwarded modunda VERIFIED. Varsayılan modun INPUT_BALANCE_BELOW_PLAN davranışı değişmedi; bu beklenen ayrı karardır.
- MetaMask ve Rabby'nin önceki, kasıtlı olarak süresi geçmiş test delegasyonları fork'taki hesapta ERC-1271 kontrolünü geçti; değiştirilmiş mesaj reddedildi; redeem süreden reddedildi.
- Alımlar ve EntryPoint üzerinden iptal/çekim yerel rastgele test anahtarıyla imzalandı. Kullanıcının kullanılabilir dönemlik izniyle alım ve gerçek cüzdan imzalı handleOps bu çalışmanın sonucu değildir.

## Sürümler

- Fixture repo: e6bdd1057f4cb68d492e2c503736d7e30d24b0c0
- SDK: dadef000f9679cad9dbd2e13ce40b14a4310274e (ayrı checkout'ta build edildi)
- Smart Accounts Kit 2.0.0; Hardhat 3.14.0; solc 0.8.23; viem 2.56.0.
- Kaynak ve SDK build hash'leri live-01-manifest.json ve live-02-manifest.json içinde.
- Runner'ların aynı kaynak kontratı bd8aa5ce2ef65c4663231004be2d66ffa84ed2becec943191b986da27f66b137 hash'ini taşıyor.

## Tekrar üretim

Fixture ve SDK repo checkout'ları üstteki commit'lere sabitlenmeli; SDK kendi checkout'ında build edilmeli. proto/package-lock.json kullanılır. Windows'ta solc'nin kullanılmayan n bağımlılığı nedeniyle kurulum gerekirse npm ci --ignore-scripts --force ile yapılabilir.

Orijinal: node proto/composer/run.mjs --repo <fixture-checkout> --sdk <sdk-checkout>/packages/bag-sdk --mode live --env-file <yerel-env> --wallet-results <rabby.json>,<metamask.json> --out <yeni-klasor>

A/B ayrılmış: aynı komutta run.mjs yerine run-isolated-models.mjs kullanılır. Aynı sepet, tutar ve güvenlik kuralları korunur. İki koşunun ham sonuçları, trace'leri ve konsol kayıtları ayrı klasörlerde duruyor.

LIFI_API_KEY ve RPC adresi yalnızca yerel env dosyasından okunur; pakete eklenmez. node_modules ve fork cache'i pakete dahil değildir.

## Gerçek cüzdan tasarımı

WALLET_FORK_DESIGN_REVIEW.md içindeki UserOp ayrımı çözülmeli. Delegasyondaki iki saatlik TimestampEnforcer, iptal ve çekim UserOp'larına otomatik geçerlilik süresi koymaz. Fork'a özel factory fikri delegasyonu sınırlar; bütün imza paketi için aynı garanti ayrı uygulanmalı. Yeni, boş hesapla kullanılabilir imza henüz istenmedi.
