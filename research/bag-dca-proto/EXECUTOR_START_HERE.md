# RecurringPurchaseExecutor: gerçek cüzdan imzası (model A, yalnızca fork)

Bu adım G3 kapısının (gerçek cüzdan kullanılabilirliği) eksik kanıtıdır. Kod, sayfa ve otomatik sayfa testi hazır; **gerçek bir insanın MetaMask veya Rabby imzası henüz yok** (`HUMAN_SIGNATURE_REQUIRED`).

## Ne gerekir, ne gerekmez

- **Gerekir:** Bu depo (`claude/dca-keeper-evidence` dalı), Node 24, `research/bag-dca-proto` içinde `npm ci`, uygulama kökünde `npx hardhat build` ve `packages/bag-sdk` içinde `npm run build`.
- **Cüzdanda yeni ve boş bir hesap.** 4663 ana ağında ETH 0, USDG 0, hiç işlem yok, kod yok. Çalıştırıcı bunu ana ağdan okur; boş değilse hiçbir şey istemeden durur.
- **Gerekmez:** Para, özel anahtar, seed, API anahtarı. Cüzdandan **hiçbir işlem gönderilmez**. Fork'taki USDG, gerçek bir USDG sahibinin bakiyesinden yalnızca fork'ta aktarılır.

## Başlatma

```
start.cmd executor-wallet --app "C:\...\BagProtocolv2"            (Windows)
node research/bag-dca-proto/start.mjs executor-wallet --app .     (macOS/Linux, depo kökünden)
```

Launcher önce bağımlılıkları ve uygulama derlemesini kontrol eder, sonra imza sayfasını tarayıcıda açar. Sayfa yalnızca `127.0.0.1` üzerinde çalışır ve oturum sırrı URL'nin `#` kısmındadır.

## İmzalanacak üç mesaj (her ekran değerleri imzalanacak veriden çözer)

| # | Mesaj | Ne demek | Neden ana ağda kullanılamaz |
|---|---|---|---|
| 1 | `Authorization` (EIP-712, BagRecurringPurchase v1) | BAG 955df6e0 (GME/ASML/COIN/AAPL). Günde bir kez 5 USDG, en fazla 3 alım, toplam 15 USDG. Fonların kaynağı ve alıcısı senin adresin (ALLOWANCE). Her hisse için adres, sembol, ağırlık ve sabit azami fiyat imzalanır; executor bu listeden BAG'in bileşim hash'ini yeniden hesaplar ve kayıtlı içerikle eşleşmezse alımı reddeder. Bitiş: başlangıç + 3 gün | Doğrulayan kontrat anahtarsız `0x008f01d0…10CB9`. Bu adres `keccak("BAG RecurringPurchaseExecutor fork-only v1")` ile türetilir; 4663'te kodu ve nonce'u yok, bilinen bir anahtarı da yok |
| 2 | `Permit` (EIP-2612, USDG "Global Dollar" v1) | Executor'a 15 USDG harcama izni. Son geçerlilik: 1 saat | **Bu, 4663'teki gerçek USDG için de geçerli bir imzadır.** Harcayabilecek adres yukarıdaki anahtarsız executor olduğu ve hesap boş olduğu için kullanılamaz; süre de kısadır. Yine de yalnızca boş bir test hesabıyla imzala |
| 3 | `Revocation` (EIP-712) | Bu yetkiyi iptal eder; aracı gönderir (gas ödemezsin) | Aynı anahtarsız doğrulayan kontrat |

Sayfa, imzalanacak veride hazırlanan şartlardan farklı bir şey görürse farkları listeler ve imza istemez (`executor-wallet/lib/sign-checks.mjs`).

### Yetki imzasından önce sayfanın gösterdiği iki ayrı uyarı

1. **Fiyat tavanı sabittir, kayma koruması değildir.** Her hisse için kurulum anındaki piyasa fiyatı ile imzalanan azami fiyat yan yana gösterilir. Bir dönemde herhangi bir hisse tavanının üstündeyse o dönemde hiç alım yapılmaz. Atlanan dönem sonradan telafi edilmez. Fiyat bitişe kadar tavanın üstünde kalırsa kalan alımlar ve bütçe hiç kullanılmaz.
2. **planSigner ve keeper hizmetine bağımlılık.** Composer kullanılmaz. Ancak her alım için BAG'in plan imzalayıcısının (planSigner) imzası ve bir keeper işlemi gerekir.
   - **Yetki sınırı:** Bu hizmetler imzalanan sınırları aşamaz. Tutar, dönem, alıcı, sepet, fiyat tavanı ve rota zincirde kontrol edilir.
   - **Hizmetin çalışması:** Bu hizmetler çalışmazsa alımlar durur veya gecikir.

İmza düğmesi, bu iki maddeyi anladığını belirten kutu işaretlenene kadar kapalıdır.

## Beklenen sonuç

| Adım | Beklenen |
|---|---|
| P-1 | Hesap 4663'te boş |
| S-AUTH, S-PERMIT, S-REVOKE | Üç imza bağlı hesaba geri çözülür |
| H-1 | Alım 1. Permit, `execute` içinde kullanılır. SDK doğrulaması `VERIFIED`: mine edilen çağrı hazırlanan çağrıyla aynı (`PREPARED_INTENT`); kaynak ve alıcı bakiyeleri işlem kapsamında okundu. Fork'taki USDG 20 → 15 |
| H-2 | Aynı dönemde ikinci deneme `NotDue` ile reddedilir; hiçbir sayaç veya bakiye değişmez |
| H-3 | Ertesi gün alım 2: `VERIFIED` (`PREPARED_INTENT`), USDG 15 → 10 |
| H-4 | İptal imzası zincire gönderilir. İzin 5 USDG olarak kalır (iptal izni sıfırlamaz) |
| H-5 | Ertesi gün alım `RevokedAuthorization` ile reddedilir; kalan izin görünür |

Çıkış: `exit 0 COMPLETE (HUMAN_WALLET_SIGNATURE)`. Paylaşılabilir sonuç `executor-wallet/out/<oturum>-wallet/results.json` dosyasındadır; içinde imza yok, yalnızca imza hash'leri var. Kullanılabilir imzalar yalnızca git'e girmeyen `executor-wallet/private/<oturum>/` klasöründedir; iş bitince silinebilir.

## Bu adımın kanıtlamadığı şeyler

Public ağda işlem, gerçek fon kullanımı (G5), bağımsız fiyat referansı ve üretim dağıtımı. Fork'taki USDG ve alımlar yalnızca fork'tadır.
