# MetaMask native izin yolu — kapanışa taşınacak mevcut durum

## Gerçek cüzdanda gözlenen

25 Ekim 2026'da MetaMask **13.53.0**, Robinhood Chain **4663 / 0x1237** üzerinde `wallet_requestExecutionPermissions` isteği için native izin ekranını açtı. İstek USDG için 60 saniyede en fazla 1 USDG, iki pencere, expiry ve aynı deneme adresine redeemer/payee sınırlarını içeriyordu.

Kaynak test hesabı: `0x854022c7C9dE1D8A6661166184739E9719901245`.

Kullanıcının Grant denemesinden sonra:

```text
code: -32603
message: External signature requests cannot sign delegations for internal accounts.
```

İzin bağlamı dönmedi; sonuç `STOPPED`, native grant `NOT_GRANTED_OR_NOT_OBSERVED`. ETH ve USDG başlangıçta sıfırdı; hesap kodu önce/sonra `0x`. Bu akışta fork izin kullanımı, DCA alımı veya toplam bütçe kontrolü sınanmadı.

Uygulamanın işlem gönderdiği bir çağrı yok. Cüzdanın kendi iç işlem girişimleri gözlenmedi; “cüzdan içinde kesinlikle hiçbir işlem denenmedi” iddiası bu kayıttan çıkarılamaz.

Sıfır ETH olası hesap yükseltme/gas aşamasını etkileyebilir. Fonlu kontrol yapılmadı. Eldeki imza hatasının çözümü olarak kullanıcıdan para yatırmasını istemek gerekçelendirilmiş değil.

## Kaynakta bulunan uyumsuzluk

MetaMask extension v13.53.0 package/lock ve sabitlenmiş controller kaynakları incelendi:

| Bileşen | Durum |
|---|---|
| Extension'ın doğrudan delegation-deployments bağımlılığı | 2.1.0, 4663 kaydı var |
| Gator permissions controller | 4.2.2 |
| Bu controller'ın nested delegation-deployments bağımlılığı | 1.4.0, 4663 kaydı yok |
| Signature controller | 39.2.10 |

Kaynakta controller'ın eksik chain kaydında hata verdiği, izin çözümlemesindeki hata sonrası imza güvenlik kontrolünün gözlenen dış hatayı üretebildiği gösterildi. Yerel kaynak tekrar üretme kaydı **7 PASS / 0 FAIL**. Bu kayıt önceki incelemenin sonucudur; bu v5 incelemesinde yeniden koşturulmadı.

Bu, güçlü ve somut bir hata adayıdır. Kullanıcının çalışan extension'ından tam dahili runtime izi alınmadı; başka decoder/origin/metadata hataları da aynı dış hataya dönüşebilir. Registry lookup'ın yeni kaynakla çalışması, bütün native grant akışının düzeldiğinin kanıtı değildir.

## Sonraki uygulama davranışı

- Capability yanıtı ve izin ekranı başarıyla grant alındığı anlamına gelmez.
- Native yol `BLOCKED_EXTERNAL` / `NOT_GRANTED` kalmalı.
- BAG SDK'nın paketlerini değiştirmek kurulu MetaMask'ın nested bağımlılığını değiştirmez.
- Güvenlik guard'ını kapatarak, raw delegation isteğiyle veya limitsiz approve/permit'e sessiz geçerek engeli aşma.
- Resmi düzeltme doğrulanırsa gerçek grant ve ardından izin kullanımı ayrı ayrı yeniden denenmeli. “Yeni sürüme geçince kesin düzelir” bilgisi şu anda yok.
- Alternatif ayrı smart account modeli aynı fon saklama deneyimi değildir; kullanıcı açıkça seçmeli.
- Yeni bir issue/mesaj bu paket hazırlanırken gönderilmedi. Kullanıcının manuel raporunun gönderilmiş olduğu veya bir issue numarası bulunduğu varsayılmamalı.

## Birincil kaynaklar

- [Extension v13.53.0 package.json](https://github.com/MetaMask/metamask-extension/blob/v13.53.0/package.json)
- [Extension v13.53.0 yarn.lock](https://github.com/MetaMask/metamask-extension/blob/v13.53.0/yarn.lock)
- [Deployment registry 1.4.0 kaynağı](https://github.com/MetaMask/smart-accounts-kit/blob/b874928c143e316cc47436112fd04a1f2444a900/packages/delegation-deployments/src/index.ts)
- [Gator controller 4.2.2 kaynağı](https://github.com/MetaMask/core/blob/7d5e4cc3eff4ee94cb9c38cb091d14755e215f9d/packages/gator-permissions-controller/src/GatorPermissionsController.ts)
- [Signature controller 39.2.10 kaynağı](https://github.com/MetaMask/core/blob/3bb5d086a6e3fcc94af342eb20dfae75bec02fc6/packages/signature-controller/src/SignatureController.ts)
- [İmza güvenlik kontrolü](https://github.com/MetaMask/core/blob/3bb5d086a6e3fcc94af342eb20dfae75bec02fc6/packages/signature-controller/src/utils/validation.ts)

Paketteki `evidence/native-permission-result.json` gerçek isteği ve hatayı; `evidence/metamask-reproduction-results.json` önceki kaynak tekrar üretme sonucunu içerir. İlki kullanılabilir izin veya imza içermez.
