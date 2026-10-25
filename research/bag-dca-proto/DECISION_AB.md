# DCA yetki modeli: A mı B mi? (karar notu, 24.10.2026, revize)

**A:** Para kullanıcının EOA'sında. Tek USDG `permit` imzası. Limitleri yalnızca bizim CREATE2 plan kontratımız uygular.
**B:** Para kullanıcının MetaMask MultiSig smart account'unda. Delegation imzası. Limitleri MetaMask enforcer'ları **ve** plan kontratı uygular.

İki modelde de BAG, bacaklar, floor, alıcı ve Composer şablonu aynı plan kontratında (`DcaComposerPlan`). B'nin eklediği, para çıkışına plan kontratından bağımsız ikinci bir dönemlik sınır.

## Kanıt durumu

| Kanıt | A | B | Kaynak |
|---|---|---|---|
| Yetki testleri (mock router, fork) | 14/14 | 9/9 + V-B1 a–i | `REPORT.md` |
| Zincirdeki sözleşmeler = denetlenmiş kaynak | gerekmiyor | 9 MATCH, 27/27 immutable. Hybrid MISMATCH, kullanılmıyor | `out/bytecode-verification.json` |
| Gerçek Composer + fork (canlı teklif) | 2 alım ✅ | 2 alım ✅ | `results/sdk127-live-…` |
| Yaşam döngüsü, gerçek Composer programı (replay) | erken alım, sayı sınırı, iptal ✅ | erken alım; **aynı delegasyonda** periyot, toplam ve çağrı sınırı; iptal; çekim ✅ | `RESULTS.md`, 71/71 |
| Cüzdan imzası | Rabby ve MetaMask imzaladı | Rabby ve MetaMask imzaladı; fork'taki hesap imzayı geçerli kabul etti. EOA delegator ise MetaMask engelliyor (#10667) | `RESULTS.md` §4 |
| Cüzdanda okunabilirlik | **ölçülmedi** (yalnızca Rabby permit "okunabildi" işaretli) | **ölçülmedi** | |

Teknik engel yok; iki model de uçtan uca çalışıyor.

## Farklar

| | A | B |
|---|---|---|
| **Dönemlik sınır** | Yalnızca plan kontratının `lastExecution + period` kontrolü. Token izni toplam bütçe kadar açık | Plan kontrolüne ek olarak hesap yetkisi katmanında: periyot başına tutar, toplam, çağrı sayısı (B-13…B-18) |
| **Plan kontratında bug olursa** | Kalan bütçenin tamamı tek işlemde gidebilir | Periyot başına 1 alım tutarı (periyot sınırında 2), zaman içinde toplam bütçe. Fark edip iptal etmek için zaman kalır |
| **Para nerede** | EOA'da, cüzdanda görünür | Ayrı smart account'ta, kullanıcının kontrolünde; cüzdan bu hesabı varsayılan olarak göstermez |
| **Kurulum (kullanıcı)** | 1 imza, gas yok | 1 transfer (gas) + 1 imza |
| **İptal / çekim** | 1 işlem (`cancel`) | Kullanıcının imzaladığı userOp; hesapta ETH ya da paymaster gerekir (B-6) |
| **Bağımlılık** | Yalnızca bizim kontratımız | + MetaMask DF v1.3.0 + keeper `handleOps` |

## Öneri (revize)

**B.** Kullanıcının açık şartı, iznin bütçe bitene kadar serbestçe açık kalmaması ve harcamanın dönemlik sınırlanması. Bunu plan kontratından bağımsız olarak yalnızca B sağlıyor, ve bu artık aynı delegasyon üzerinde gerçek Composer programıyla gösterildi.

Önceki sürümde A'yı öneriyordum. Gerekçelerimden biri "delegation cüzdanda okunmuyor" idi. Bu ölçülmemişti: boş gözlem kutularını yanlış yorumlamıştım. O gerekçe düşünce A'nın kalan avantajları kurulum kolaylığı ve paranın EOA'da durması. Bunlar dönemlik sınırın yerine geçmiyor.

B'nin maliyetleri ve şartları:
- Kullanıcı USDG'yi smart account'a taşıyor. Uygulama hesabın bakiyesini ve "çek" düğmesini açıkça göstermeli.
- İptal ve çekim için gas kaynağı (hesapta küçük ETH ya da paymaster) ve keeper `handleOps` gerekiyor.
- Delegasyon imzası ham EIP-712. Uygulama limitleri imzadan önce okunur göstermeli; cüzdan okunabilirliği ayrıca ölçülmeli.
- Plan kontratı ve factory yine dış denetimden geçmeli; B yalnızca bug durumundaki kaybın hızını sınırlıyor.

A, daha basit bir ürün ve risk tercihi olarak geçerli bir seçenek olarak kalıyor. Karar senin.

## Açık kalanlar (sıra)
1. Taze Composer teklifleriyle yaşam döngüsü: `--mode live` (bakımcı makinesi, API anahtarı yerelde).
2. Gerçek cüzdanda imzalanmış, **yalnızca yerel fork'ta kullanılabilir** dönemlik yetkiyle alım; gerçek cüzdan imzalı userOp ile EntryPoint üzerinden iptal ve çekim.
3. Cüzdan okunabilirliğinin ölçülmesi (gözlem kutuları + ekran görüntüleri).
4. Canlı negatif teklifle fork alımı (`negativeQuotesUsed=0`, piyasaya bağlı).
- #126 ve #127 draft, merge yok.
