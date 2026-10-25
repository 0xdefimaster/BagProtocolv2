# DCA yetki prototipi — gerçek Composer sonucu

24 Ekim 2026. Bu koşu Codex tarafından kullanıcının Windows ortamında yeniden çalıştırıldı.

## Sonuç

**Canlı Composer + yerel fork: 26 PASS / 0 FAIL. SDK tam doğrulama kabul koşulu: KARŞILANMADI.**

Composer API'sinden güncel derlemeler alındı; kayıtlı program replay'i kullanılmadı. Bütün zincir işlemleri izole fork'ta yürütüldü. Açık zincire işlem gönderilmedi ve gerçek para kullanılmadı.

- BAG: asdas (Fork), v1; 955df6e0-b6ea-44ba-a5eb-1288a80c0a06.
- Tanım hash'i: `0x5d6118dbe3072743e0997af5c2266c57a2775c71fc337e8fd82b97a92fc2fbb9`.
- Dağılım: GME %26,75; ASML %26,01; COIN %37,24; AAPL %10.
- Zincir: Robinhood 4663. Fork bloğu: 96434989, hash: `0xb5e5bc47923e72e5cda852a24ffbab46a491ec111b29c4d8540b46d9cb0220fb`.
- Repo commit'i: `e6bdd1057f4cb68d492e2c503736d7e30d24b0c0`. SDK: 0.3.0; derleme geçti.
- Prototip runner ve kontrat kaynakları değiştirilmedi; sabitlenen repo çalışma ağacı temiz.

## Bu koşuda doğrulananlar

| Kontrol | A: EOA + permit | B: MultiSig + delegasyon |
|---|---|---|
| Canlı Composer'ın tahmin edilen plan adresi için derleme yapması | PASS | PASS |
| Adresten bağımsız şablon ve CREATE2 tahmin/deploy eşleşmesi | PASS | PASS |
| İki ayrı 5 USDG alımı ve kullanıcıya aynı işlemde teslim | PASS | PASS |
| Kaynaktan tam 5 USDG çıkması, her çıktı tabanının sağlanması | PASS | PASS |
| Planın ilgili token bakiye farklarının ve kalan proxy izninin sıfır olması | PASS | PASS |
| Bozuk swap'ta fon çekimi, izinler ve plan sayaçlarının geri alınması | PASS | PASS; enforcer sayaçları da geri alındı |
| SDK iç Composer çağrı bağı: CALL_TRACE | PASS | PASS |
| SDK verifyPurchaseReceipt genel sonucu | FAILED | FAILED |

Toplam dört başarılı alım var. Her plan için maksimum üç alım tanımlıydı; bu koşuda ikisi yürütüldü. Bütçenin tamamının tüketilmesi, gerçek takvim zamanı ve iptal/çekim cüzdan ekranları bu koşunun kapsamı değildir.

## SDK açığı

Mevcut SDK doğrulayıcısı fon kaynağı ve nihai alıcı olarak Composer signer'ını kullanıyor. Burada signer plan kontratı: para aynı işlemde dış kaynaktan gelip çıktılar kullanıcıya aktarıldığı için planın işlem öncesi USDG bakiyesi sıfır. İç çağrı bağı geçse de genel karar dört işlemde de FAILED.

| İşlem | Genel SDK kararı | Hata |
|---|---|---|
| A-4 | FAILED | INPUT_BALANCE_BELOW_PLAN |
| A-6 | FAILED | INPUT_BALANCE_BELOW_PLAN |
| B-4 | FAILED | INPUT_BALANCE_BELOW_PLAN |
| B-6 | FAILED | INPUT_BALANCE_BELOW_PLAN |

Teslimat ayrıca SDK'nın işlem kapsamlı bakiye okuyucusuyla kontrol edildi. Bu ayrı kontrolün geçmesi, genel SDK kararını VERIFIED yapmaz. Yeni doğrulama modu henüz uygulanmadı; mevcut INPUT_BALANCE_BELOW_PLAN kontrolü korunuyor.

## Windows kurulumu

Prototipin normal npm ci komutu EBADPLATFORM verdi: solc 0.8.23 bağımlılığı n@9.2.3 Windows'u dışlıyor. Yalnızca izole prototipte npm ci --ignore-scripts --force kullanıldı; package-lock ve derleyici sürümü korundu. Asıl repoda npm ci --ignore-scripts ve SDK build başarıyla tamamlandı. Git'in Windows TLS sağlayıcısı için yalnızca clone komutunda http.sslBackend=openssl seçildi. Ayrıntılar environment-and-reproduction.json içinde.

## Açık kalanlar

1. Fon kaynağı, Composer çağrısını yapan kontrat ve nihai alıcıyı yetkilendirilmiş plana bağlı doğrulayan ayrı SDK modu. Mevcut doğrulama davranışı değişmemeli. USDG payı tutan sepetlerde brüt tutar ile takas için çekilen tutar ayrıca ele alınmalı.
2. Gerçek MetaMask/Rabby imza denemeleri. Yerel anahtarla imza, tarayıcı cüzdanı kanıtı değildir.
3. Uzun süreli fiyat politikası, kalıcı keeper, BAG muhasebesi ve üretim güvenlik incelemesi. Bu koşu bunları tamamlamaz.

Tedarik edilen eski mock/replay sonuçları ve bytecode/immutable raporu bu koşuda yeniden çalıştırılmadı; 26 sayısına eklenmedi. Gaz değerleri Nitro/L1 veri maliyeti ölçümü değildir.

## Kanıt dosyaları

- live-01/results.json: bütün kontroller ve SDK kabul durumu.
- live-01/*-trace.json: dört gerçek fork işleminin çağrı izleri.
- live-01/*-sdk-verify.json: dört ham SDK kararı.
- live-01/compiled-placeholder.json: canlı API derlemesi.
- live-01-console.log ve live-01-process.json: çıktı ve exit code 0.
- preflight.json: yalnızca okuma ile zincir/anahtar mevcudiyet kontrolü; anahtar değeri yok.
- environment-and-reproduction.json: sürümler, kaynak özetleri ve komutlar.
