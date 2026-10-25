# Gerçek cüzdan / fork tasarımı incelemesi — 24 Ekim 2026

Bu belge tasarım incelemesidir. Yeni hesapla kullanılabilir bir delegasyon veya UserOp imzası istenmedi. Tasarımın kodu henüz verilmedi.

## Delegasyon için önerilen ayrım

- Domain chainId 4663 olduğu için imza Robinhood mainnet açısından da aynı kriptografik alandadır.
- MetaMask DelegationManager v1.3.0, ANY_DELEGATE kullanılmadığında yaprak delegasyonun delegate adresiyle çağıran adresi eşleştirir.
- Bilinen bir anahtardan veya normal deployment'tan gelmeyen, açıklanmış bir etiketin hash'inden türetilmiş factory adresini yalnızca fork'ta kodla doldurmak; planın CREATE2 adresini de bu factory'ye bağlamak, delegasyonun ana ağda kullanılamaması için makul bir test tasarımıdır. Güvence adres ön görüntüsünün bulunamaması gibi kriptografik varsayımlara dayanır; imzanın domain'inin farklı olduğu anlamına gelmez.
- Ana ağdan bağımsız okuma: `0x7fE0cf854704Ce6f29691a75F6839233AFfDb3E6` için kod `0x`, nonce 0, bakiye 0 doğrulandı. Sonuç `fork-factory-mainnet-read-check.json` içinde. Henüz hesaplanmamış plan adresi için kontrol yapıldığı iddia edilmiyor.
- Üretim mimarisinde factory'ye `hardhat_setCode` uygulanmaz. Bu yalnızca araştırma düzenidir.

## İptal / çekim UserOp'ları ayrıca ele alınmalı

“Ana ağda tekrar kullanılsalar bile zarar veremez” ifadesi fazla kesin.

- İptal veya çekimin token alıcısı kullanıcı olsa da UserOp çalışması nonce tüketir ve hesap/paymaster bakiyesinden gas ödeyebilir.
- Delegasyondaki TimestampEnforcer, EntryPoint üzerinden sahibin imzaladığı UserOp'un kendisine süre sınırı koymaz.
- İncelenen DeleGatorCore v1.3.0 `_validateUserOpSignature`, doğru imzada `0` döndürür. Bu akış kendi başına iki saatlik bir `validUntil` sınırı eklemez.
- Hesabın bugün boş ve deploy edilmemiş olması bir durum kontrolüdür; gelecekte fonlanıp deploy edilirse imzanın otomatik geçersizleşeceği sonucu çıkmaz.

Kodlamadan önce tercih açıkça yapılmalı:

1. UserOp'ları da fork'a bağlı bir yürütme şartıyla sınırlandırmak. Örneğin imzaya dahil `paymasterAndData`, yalnızca fork'ta kodu bulunan ve adresi aynı açıklanmış yöntemle türetilmiş bir araştırma paymaster'ına bağlanabilir. Paymaster validUntil da uygulayabilir. Bu seçenek henüz kodlanmadı veya sınanmadı; mainnet'te fonlama/deploy girişiminde yürütmenin reddedildiği ayrıca sınanmalı.
2. Böyle bir ayrım yoksa UserOp'ların ana ağda da kullanılabilir olduğu açıkça belirtilmeli; bütün paket için “yalnızca fork'ta çalışır” garantisi verilmemeli.

Yeni ve boş, tekrar kullanılmayacak bir hesap; küçük limit ve kısa delegasyon süresi ek önlemlerdir.

## Yaşam döngüsü testinin kapsamı

- Bütçe bitmişken iptal sonrası `CannotUseADisabledDelegation` beklemek, ayrı iptal kontrolüne ulaşmayı gösterebilir; bunu “bütçe kalmışken kullanıcı iptal etti” senaryosuyla karıştırmamak gerekir.
- Kullanıcının durdurabilme deneyimi için bütçe kalmışken iptal ve kalan USDG'nin çekilmesi de gösterilmeli. Önceki yerel test anahtarlı yaşam döngüsü bunu sınadı; gerçek cüzdan imzasına ilişkin iddia ayrı kalmalı.
- İmzalar her adım için gerektiğinde istenmeli; imzalanacak gerçek calldata, alıcı, tutar, nonce ve gas üst sınırı çözülerek gösterilmeli.

## Kaynaklar

- [DelegationManager v1.3.0](https://github.com/MetaMask/delegation-framework/blob/v1.3.0/src/DelegationManager.sol)
- [DeleGatorCore v1.3.0](https://github.com/MetaMask/delegation-framework/blob/v1.3.0/src/DeleGatorCore.sol#L538)
- [ERC-4337 nonce ve ücret kuralları](https://eips.ethereum.org/EIPS/eip-4337)
