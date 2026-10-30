# Buradan başla: gerçek cüzdan imzalı DCA, yalnızca yerel fork'ta

Bu bir araştırma akışıdır. Gerçek para kullanılmaz, ana ağa işlem gönderilmez ve para yatırma adımı yoktur. İmzaları sen atarsın; senden anahtar ya da seed istenmez.

> **Bu akış B modelidir:** USDG, EOA'nın sahibi olduğu ayrı bir smart account'tan harcanır. MetaMask'ın native izin yolu (USDG ana cüzdanda kalır) şu an dış bir hata yüzünden kapalı (`DECISIONS.md` §2). Bu akış onun yerine geçmez.

## Bir kez hazırlık (Windows)

1. **Node.js 24** kurulu olsun. Kontrol: `node --version` → `v24.x`.
2. **SDK checkout'u:** BagProtocolv2'nin entegrasyon commit'i `dadef00`. Daha önce kurduysan aynı klasörü kullan:
   ```
   git -C "C:\...\BagProtocolv2" worktree add "C:\...\BagProtocolv2-integ" dadef00
   cd "C:\...\BagProtocolv2-integ"
   npm ci
   npm run build --prefix packages/bag-sdk
   ```
3. **Bu klasörde** bir kez `npm ci` çalıştır.

## Tek komut

```
start.cmd wallet --sdk "C:\...\BagProtocolv2-integ\packages\bag-sdk"
```

- **Yol kontrolleri:** Yolda boşluk varsa tırnak içinde yaz. Launcher önce kontrolleri yazar (`OK …`). `FAIL` görürsen hiçbir şey çalışmaz ve sebebi o satırda yazar.
- **İsteğe bağlı RPC:** Kendi RPC'ni kullanmak için `--env-file "C:\...\.env.local"` ekle. Dosyadan yalnızca `ROBINHOOD_RPC_URL` okunur ve değeri ekrana yazılmaz. Bu mod Composer anahtarı istemez; kayıtlı program kullanılır.

## Hangi cüzdan, hangi hesap, hangi ağ

- **Cüzdan:** MetaMask ya da Rabby. Sayfa, kurulu cüzdanları listeler.
- **Hesap:** **Yeni ve boş** bir hesap oluştur. ETH 0, USDG 0 olmalı ve hiç kullanılmamış olmalı.
  - Eski bakiyeli `0xb193…56b8` hesabını kullanma; çalıştırıcı onu reddeder.
  - Çalıştırıcı, imzadan önce hesabın ana ağda boş olduğunu salt okunur kontrol eder.
- **Ağ:** Robinhood Chain (4663). Sayfa geçiş ister.
- **Fon:** Hesaba para gönderme. Testte kullanılan 50 USDG yalnızca fork'ta, gerçek bir USDG sahibinin fork'taki bakiyesinden aktarılır.

## Ekranlar ve dört imza

Tarayıcıda `http://127.0.0.1:<port>/#…` açılır. Açılmazsa konsoldaki adresi bu bilgisayardaki tarayıcıya yapıştır.

1. **Cüzdanı bağla:** "Bağlan" → hesabını seç → ağ geçişini onayla.
2. **İzin 1/2 — limit testi.** İmza tipi EIP-712 Delegation. Tabloda şunlar görünür:
   - smart account adresi ve plan adresi
   - dönem başına en fazla 5 USDG, 2 dakikalık takvim pencereleri
   - toplam 10 USDG, en fazla 2 alım
   - başlangıç ve bitiş tarihi
   - alıcı: kendi adresin
3. **İzin 2/2 — 3 alım × 5 USDG = 15 USDG.** Bütçesi bitmeden iptal edilecek.
4. **İptal:** İkinci izni kapatan userOp. Gas'ı fork'a özel paymaster öder. Geçerlilik sonu tabloda yazar.
5. **Çekim:** Kalan USDG'yi (35 USDG) kendi adresine geri gönderen userOp.

Her imzada cüzdanın gösterdiği veriyi sayfadaki tabloyla karşılaştır. Sayfa veriyi imzalanacak typed data'nın kendisinden çözer. Bir şey planla eşleşmezse **"İmza istenmeyecek"** yazar ve imza düğmesi kapanır. O durumda imzalama: çalıştırıcı durur, hiçbir şey yürümez.

## Ne beklenir

- **İmzalardan sonra:** Fork'ta yaşam döngüsü 5–10 dakika sürer:
  - alım
  - aynı dönemde ret
  - sonraki dönemde alım
  - toplam limitte ret
  - bütçe kalmışken iptal
  - çekim
  - ek sınır testleri
- **Başarılı bitiş:** Sayfa "Bitti: bütün kontroller geçti" der. Konsoldaki son satırlar:
  ```
  PASS no signature in the shareable output folder
  SUMMARY status=PASSED signer=wallet mode=replay pass=30 fail=0 purchases=3 userOps=2
  ```
- **Paylaşılacak klasör:** `wallet-fork\out\<oturum>-wallet\`.
- **Paylaşılmayacak klasör:** `wallet-fork\private\`. İmzalar buradadır. Fork'a bağlıdırlar ve süreleri birkaç dakikada dolar, ama yine de paylaşma.

## Bir şey ters giderse

- **Bir kontrol başarısız olursa:** Konsolda `FAIL <id> …` satırı çıkar ve rapor yine yazılır. `results.json`'u gönder.
- **Süreç kapanırsa:** Komutu yeniden çalıştır. Yeni bir fork ve yeni imzalar gerekir; eski oturum kaldığı yerden sürmez, çünkü eski imzaların bitiş süresi geçmiş olur.
- **Eski sayfa:** `wallet/serve.mjs` bilerek kullanılamayan imzaları ölçen eski sayfaydı. Bu akış o değil.

## Diğer komutlar

| Komut | Ne yapar |
|---|---|
| `start.cmd unit` | Birim testleri (kurallar, sunucu, fiyat kapısı, adaptör, hazırlık) |
| `start.cmd test --sdk "<…>\packages\bag-sdk"` | Aynı yaşam döngüsü, yerel test anahtarıyla (cüzdan gerekmez) |
| `start.cmd shadow --app "<BagProtocolv2 checkout>"` | Composer'sız gölge ölçüm. Bkz. `shadow/README.md` |
| `start.cmd preflight --sdk … --app …` | Yalnızca kontroller |

Durum ve kanıt yolları: `STATUS.md`. Kararlar: `DECISIONS.md`.
