# Gerçek cüzdan imzalı dönemlik izin: yalnızca yerel fork'ta kullanılabilir (tasarım, B modeli)

**Durum:** tasarım. UserOp ayrımı (paymaster) fork'ta yerel test anahtarıyla sınandı (PM-0…PM-7). Gerçek cüzdan akışının kodu henüz yazılmadı.
**Kısıtlar:** gerçek para yok, public işlem yok, `0xb193…56b8` kullanılmaz. Kullanıcı yeni ve boş bir MetaMask hesabı açar.

## 1. "Yalnızca fork'ta" ne demek, ne demek değil

Fork, Robinhood Chain'in kendisi gibi **chainId 4663** kullanıyor ve DelegationManager (`0xdb9B…dB3`) zincirdekiyle aynı. Bu yüzden kullanıcının atacağı delegasyon imzası **4663'te de kriptografik olarak geçerli bir imzadır**. Kısa süre ve küçük tutar tek başına bunu değiştirmez; yalnızca riskin süresini ve boyutunu küçültür.

Garantiyi imzanın geçersizliğine değil, **delegasyonun ana ağda hiç kimse tarafından kullanılamamasına** dayandırıyoruz:

1. **Delegasyonu yalnızca `delegate` adresi kullanabilir.** `DelegationManager.redeemDelegations`, zincirin yaprak delegasyonu için `delegate == msg.sender` şartını arıyor (`src/DelegationManager.sol:156-157`, delegate `ANY_DELEGATE` değilse). Ayrıca `RedeemerEnforcer` aynı adresi zorunlu kılıyor (`src/enforcers/RedeemerEnforcer.sol:40-42`). Delegasyonu başka birine yeniden devretmek de delegate'in kendi imzasını gerektiriyor (`:197-198`).
2. **Delegate = plan adresi `P` = `CREATE2(F*, salt, initCodeHash)`.** `F*` bizim factory'mizin fork'taki adresi.
3. **`F*` sahipsiz bir adres:** `F* = keccak256("BAG-DCA fork-only plan factory v1")`'in son 20 byte'ı = `0x7fE0cf854704Ce6f29691a75F6839233AFfDb3E6`. Bu adres bir anahtardan ya da bir deploy işleminden türemedi. Fork'ta factory koduna `hardhat_setCode` ile yerleştirilir (factory'nin immutable'ı ve constructor'ı yok, kodu adresten bağımsız).
4. **Ana ağda `P` hiçbir zaman kod ya da anahtar sahibi olamaz.** `P`'ye kod koymanın tek yolu `F*`'tan deploy etmek. `F*`'ta kod yok ve kimse onu kontrol edemez: bir anahtar bulmak secp256k1/keccak'i kırmayı, oraya bir kontrat deploy etmek keccak ön görüntüsü bulmayı gerektirir. `P` de aynı nedenle bir EOA olarak kontrol edilemez.
5. **Sonuç:** 4663 ana ağında `msg.sender == P` olan bir çağrı yapılamaz, yani bu imza ana ağda kullanılamaz. Bu bir **kriptografik varsayıma** dayanıyor (keccak256 ön görüntü direnci, secp256k1); "imza ana ağda geçersiz" iddiası **değil**.

**İmzadan önce zincirden okunup gösterilen kanıt** (read-only RPC):
- `F*` ve `P` için ana ağda `eth_getCode = 0x`, nonce 0. Ön kontrol (24.10.2026): `F*` → kod yok, nonce 0, bakiye 0.
- Typed data'daki `delegate`, `F*`, `salt` ve `initCodeHash`'ten istemcide yeniden hesaplanan `P` ile birebir aynı.
Biri tutmazsa sayfa imza istemez.

**Ek koruma katmanları** (garantinin parçası değil, risk azaltma):
- Yeni EOA'nın bakiyesi 0; smart account'u ana ağda deploy edilmez ve fonlanmaz. Fork'taki USDG ve ETH yalnızca fork'ta, impersonation ve `hardhat_setBalance` ile verilir.
- Kısa süre: `TimestampEnforcer` bitişi imzadan sonra 2 saat.
- Küçük limitler: periyot başına 5 USDG, toplam 10 USDG, en fazla 3 çağrı.

**Değerlendirilip seçilmeyen alternatif: farklı chainId'li fork.** İmzayı 4663'te gerçekten geçersiz yapardı. Ama MetaMask, `eth_signTypedData_v4`'te domain chainId'nin aktif ağla aynı olmasını istiyor; kullanıcının özel bir ağ eklemesi gerekir. Ayrıca Composer derlemesi ve SDK doğrulaması 4663'e sabit. Sonuçta üretimden farklı bir domain'i test etmiş oluruz.

## 2. UserOp imzaları (iptal ve çekim): fork'a bağlı paymaster

Delegasyondaki `TimestampEnforcer` userOp'lara geçmiyor. DeleGatorCore v1.3.0, doğru imzada `validationData = 0` döndürüyor; yani süre sınırı yok. Bu yüzden içeriğin zararsız olması yetmez: ana ağda tekrar oynatılırsa nonce tüketir ve hesap fonlanmışsa gas ödetir (inceleme: `WALLET_FORK_DESIGN_REVIEW.md`).

**Çözüm:** Her userOp, imzalanan `paymasterAndData` alanıyla sahipsiz bir research paymaster'a bağlanır:
- **Adres:** `PM* = keccak256("BAG-DCA fork-only paymaster v1")[12:]` = `0x03fd2c77d32302eeF2f6F3063DbB7b899b1116D3`.
- **Kod:** `ForkOnlyPaymaster.sol`. Constructor, storage ve immutable yok. Fork'ta `hardhat_setCode` ile yerleştirilir.
- **Süre:** `validUntil` zorunlu. Paymaster bunu döndürür, EntryPoint da süreyi uygular.

**Dayanak:**
- `paymasterAndData` imzalanan EIP-712 hash'inin içinde. Paymaster'ı çıkaran ya da değiştiren biri imzayı bozar (`AA24`).
- Ana ağda `PM*`'ta kod olamaz: anahtarı da deployer'ı da yok. Paymaster'lı bir userOp bu yüzden ana ağda doğrulanamaz. Biri `PM*` adına deposit yapsa ya da hesabı ETH ile fonlasa bile sonuç değişmez.
- Hesap, gas'ı paymaster'a ödettiği için kendi ETH'sini hiç kullanmaz.

**Fork'ta yerel test anahtarıyla sınandı** (`RESULTS.md`, PM-0…PM-7):

| Test | Sonuç |
|---|---|
| PM-0 | Ana ağda `PM*` için kod yok, nonce 0 |
| PM-2 | Ana ağ koşulu (kod yok, deposit var, hesap fonlu): imzalı iptal yürütülemedi; nonce, bakiyeler ve delegasyon değişmedi |
| PM-3 | Paymaster çıkarılınca `AA24` |
| PM-4 | Aynı imza, fork'ta kod yerindeyken çalıştı; hesap gas ödemedi |
| PM-6 | Süre geçince `AA32` |
| PM-7 | Süresi içindeki çekim çalıştı |

**Sınır:** PM-2, ana ağı fork'ta kodu kaldırarak taklit ediyor. Ana ağa işlem gönderilmedi; gönderilmeyecek. Garanti, adres ön görüntüsü varsayımına dayanıyor; delegasyondaki gibi.

## 3. İmzadan önce gösterilecekler

Hepsi **imzalanacak typed data'dan çözülerek** gösterilir; ayrı bir kaynaktan değil. Enforcer adresleri v1.3.0 adresleriyle karşılaştırılır. Bilinmeyen bir enforcer, eksik caveat ya da tutarsızlık varsa imza düğmesi kapanır.

| Gösterilen | Kaynağı |
|---|---|
| İzni veren hesap (smart account) ve sahibi (yeni EOA) | `delegator`; hesap adresi `deployParams`'tan yeniden hesaplanır |
| USDG'yi çekebilecek tek adres | `delegate`, `RedeemerEnforcer` ve `AllowedCalldataEnforcer` → `P`; ana ağ kontrolleriyle birlikte |
| **Satın alınan hisselerin alıcısı** | Fork'taki plan kontratından okunan `recipient` = yeni EOA. Planın `initCodeHash`'i `P`'ye bağlı olduğu için değiştirilemez |
| **Dönemlik tutar** ve periyot uzunluğu, başlangıç | `ERC20PeriodTransferEnforcer` terms: token, tutar, süre, başlangıç |
| **Toplam bütçe** | `ERC20TransferAmountEnforcer` terms |
| En fazla alım sayısı | `LimitedCallsEnforcer` terms |
| **Bitiş zamanı** (yerel saat ve UTC) | `TimestampEnforcer` terms |
| Zincir ve doğrulayan kontrat | domain: chainId 4663, `verifyingContract` = DelegationManager |

## 4. Akış

Tek bir uzun süre çalışan betik: `wallet-fork/run.mjs`. Fork, read-only relay ve yalnızca `127.0.0.1`'e bağlanan küçük bir imza sunucusu açar.

**Hazırlık** (fork içinde, kullanıcı imzası yok):
1. `F*` adresine factory kodu koyulur.
2. Yeni EOA'nın MultiSig hesabı deploy edilir (keeper, imzasız).
3. Fork'ta hesaba USDG ve küçük ETH verilir.
4. Plan `P` deploy edilir: alım aralığı periyodun yarısı, `recipient` = yeni EOA.

**İmza 1, delegasyon D1** (periyot başına 1 alım, toplam 2 alım):

| Test | Beklenen |
|---|---|
| WF-1 | Alım ✅ |
| WF-2 | Aynı periyotta red (`transfer-amount-exceeded`) |
| WF-3 | Sonraki periyotta alım ✅ |
| WF-4 | Red (`allowance-exceeded`) |

**İmza 2, delegasyon D2** (toplam 3 alım), **bütçe kalmışken iptal:**

| Test | Beklenen |
|---|---|
| WF-5 | Alım ✅; 2 alımlık bütçe kalıyor |
| **İmza 3**: iptal userOp | `PM*`'a bağlı, `validUntil` +2 saat. Keeper fork'ta `handleOps` ile gönderir |
| WF-6 | Due alım `CannotUseADisabledDelegation` ile reddedilir; harcanmamış bütçe kayda geçer |
| **İmza 4**: çekim userOp | `PM*`'a bağlı. Kalan USDG yeni EOA'ya döner |
| WF-7 | Hesap bakiyesi 0; hesap gas ödemedi |

Notlar:
- Her alımda SDK forwarded doğrulaması yapılır.
- Her redde, o denemede kullanılan delegasyonun sayaçları değişmemeli.
- İmzalar ihtiyaç anında, sırayla istenir.
- UserOp ekranında gösterilenler: çözülmüş calldata (hedef, fonksiyon, alıcı, tutar), sender, nonce, gas üst sınırları, paymaster ve ana ağ kontrolü, `validUntil`.

**Kayıt:** typed data, imzalar, her adımın sonucu ve ana ağ kontrolleri. Public işlem sayısı 0 (relay yazma yöntemlerini reddediyor).

Mod seçimi: `--mode live` (taze teklif, API anahtarı `--env-file`'dan) ya da `--mode replay`.

## 5. Kullanıcının yapacakları

1. MetaMask'ta yeni bir hesap aç. Bu hesaba hiçbir zaman para gönderme.
2. Sayfaya yalnızca bu hesabı bağla. Ağ: Robinhood Chain (4663).
3. Betiği çalıştır.
4. Sayfada 4 imza at. Her birinde gösterilen değerleri MetaMask ekranındakilerle karşılaştır.

İsteğe bağlı: aynı akışı Rabby ile tekrarla.

## 6. Kabul ölçütleri
- WF-1…WF-7 PASS.
- Ana ağ kontrolleri kaydedilmiş: `F*` ve `P`'de kod yok.
- `publicTransactions = 0`.
- 4 imza yeni EOA'ya dönüyor.
- `PM*` ve `F*` için ana ağ kontrolleri her koşuda kaydedilir.
- `0xb193…` hiçbir yerde geçmiyor.
