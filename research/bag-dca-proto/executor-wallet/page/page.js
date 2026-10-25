// Signing page for the RecurringPurchaseExecutor fork flow (model A). Every value shown is decoded from the
// typed data the wallet will sign (lib/sign-checks.mjs, the same code the runner's tests use). When anything
// differs from the prepared terms, the page lists it and does not ask for a signature.
import { checkStep } from '/lib/sign-checks.mjs';

const secret = location.hash.slice(1);
history.replaceState(null, '', location.pathname); // keep the session secret out of the address bar
const $ = id => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-bag-session': secret, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const units = (x, d) => { if (x === null || x === undefined) return '?'; const n = BigInt(x), u = 10n ** BigInt(d); const f = (n % u).toString().padStart(d, '0').replace(/0+$/, ''); return (n / u).toString() + (f ? ',' + f : ''); };
const usdg = x => units(x, 6) + ' USDG';
const date = s => { if (s === null || s === undefined) return '?'; const d = new Date(Number(s) * 1000); return `${d.toLocaleString('tr-TR')} (${d.toISOString().replace('.000Z', 'Z')})`; };
const days = s => (s === null ? '?' : `${Number(s) / 86400} gün (${s} sn)`);
const code = a => `<code>${esc(a)}</code>`;
const lc = a => String(a ?? '').toLowerCase();

const wallets = [];
window.addEventListener('eip6963:announceProvider', e => { if (!wallets.some(w => w.info.uuid === e.detail.info.uuid)) { wallets.push(e.detail); renderWallets(); } });
window.dispatchEvent(new Event('eip6963:requestProvider'));
function renderWallets() { $('wallet').innerHTML = wallets.map((w, i) => `<option value="${i}">${esc(w.info.name)}</option>`).join('') || '<option>Cüzdan bulunamadı</option>'; }
renderWallets();
let provider = null, account = null, pendingId = null;

$('connectBtn').onclick = async () => {
  try {
    const w = wallets[Number($('wallet').value)]; if (!w) throw new Error('Cüzdan bulunamadı');
    provider = w.provider;
    [account] = await provider.request({ method: 'eth_requestAccounts' });
    let chainId = await provider.request({ method: 'eth_chainId' });
    if (lc(chainId) !== '0x1237') { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }); chainId = await provider.request({ method: 'eth_chainId' }); }
    if (lc(chainId) !== '0x1237') throw new Error('Cüzdan Robinhood Chain (4663) ağında olmalı');
    // The automated test provider announces this rdns, so its run is never labelled a human signature.
    await api('/api/account', { address: account, chainId: parseInt(chainId, 16), wallet: `${w.info.name} (${w.info.rdns})`, automated: w.info.rdns === 'local.bag.test-key' });
    $('connectInfo').textContent = `Bağlı hesap: ${account} (${w.info.name}). Hesabın boş olduğu ana ağda kontrol ediliyor…`;
    $('connectBtn').disabled = true;
  } catch (e) { $('connectInfo').textContent = 'Hata: ' + e.message; }
};

const rows = list => { $('details').querySelector('tbody').innerHTML = list.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join(''); };

function renderAuthorization(p, d) {
  const sym = Object.fromEntries((p.info?.assets ?? []).map(a => [lc(a.asset), a]));
  $('planSummary').innerHTML = [
    `Her dönem <strong>${usdg(d.grossAmountPerRun)}</strong>, en fazla <strong>${d.runs}</strong> alım, toplam <strong>${usdg(d.totalBudget)}</strong>.`,
    'USDG <strong>bu adreste kalır</strong>; her alımda yalnızca o dönemin tutarı çekilir (ALLOWANCE).',
    'Kaçırılan dönem birikmez; aynı dönemde ikinci alım olmaz; başarısız alım bütçeyi tüketmez.',
  ].map(x => `<li>${x}</li>`).join('');
  rows([
    ['Fonların kaynağı ve imzalayan', `${code(d.owner)} (bu hesap)`],
    ['Alınan hisselerin alıcısı', code(d.recipient)],
    ['Dönem başına / alım sayısı / toplam', `${usdg(d.grossAmountPerRun)} / ${d.runs} / ${usdg(d.totalBudget)}`],
    ['Dönem süresi', days(d.periodSeconds)],
    ['İlk dönem / son dönem başlangıcı', `${date(d.startsAt)} / ${date(d.lastWindowStart)}`],
    ['Bitiş (bundan sonra alım yok)', date(d.expiresAt)],
    ['Sepet ve fiyat sınırları', d.assets.map(a => `${esc(sym[lc(a.asset)]?.symbol ?? a.asset)} %${a.weightBps / 100}: en fazla ${usdg(a.maxPriceRaw)} / adet (bu dönemde en az ${units(sym[lc(a.asset)]?.minimumOutRaw ?? 0n, a.decimals)} adet)`).join('<br>')],
    ['BAG kimliği (zincirde kontrol edilir)', `bagId ${code(d.bag?.bagId)}, sürüm ${esc(d.bag?.bagVersion)}, bileşim ${code(d.bag?.compositionHash)}, tanım ${code(d.bag?.definitionHash)}`],
    ['Rota', `router ${code(d.route?.router)}, swap ${code(d.route?.swapTarget)} (Uniswap v3), ücret seviyeleri ${esc((d.route?.allowedFees ?? []).join(', '))}`],
    ['Doğrulayan kontrat', `${code(d.executor)} — 4663 ana ağında kodu ve nonce'u yok (${esc(p.info?.keyless ?? '')}); bu imza ana ağda kullanılamaz`],
    ['Fiyat sınırının kaynağı', esc(p.info?.priceLimitSource ?? '')],
  ]);
}

function renderPermit(p, d) {
  $('planSummary').innerHTML = [
    'Bu bir <strong>EIP-2612 USDG izni</strong>: işlem değil, imza. Executor\'a toplam bütçe kadar harcama izni verir.',
    '<strong>Uyarı:</strong> Bu permit 4663 ana ağındaki gerçek USDG için de geçerli bir imzadır. Harcayabilecek adres anahtarsız executor adresidir (ana ağda kodu yok), hesap boştur ve süre kısadır; bu yüzden ana ağda kullanılamaz. Yine de yalnızca boş bir test hesabıyla imzala.',
  ].map(x => `<li>${x}</li>`).join('');
  rows([
    ['Token', `${code(d.token)} (USDG, "Global Dollar" v1)`],
    ['Sahip (bu hesap)', code(d.owner)],
    ['Harcayabilecek adres', `${code(d.spender)} (RecurringPurchaseExecutor, fork'a özel)`],
    ['Tutar', `${usdg(d.value)} (= toplam bütçe)`],
    ['Nonce / son geçerlilik', `${esc(d.nonce)} / ${date(d.deadline)}`],
  ]);
}

function renderRevocation(p, d) {
  $('planSummary').innerHTML = [
    'Bu imza yetkiyi <strong>iptal eder</strong>. Herkes zincire gönderebilir (gas ödemezsin); fork\'ta test anahtarlı bir aracı gönderecek.',
    'İptal ve USDG izninin sıfırlanması <strong>ayrı</strong> şeylerdir: iptalden sonra kalan izin görünür kalır, ama hiçbir alım yapılamaz. İzni sıfırlamak ayrı bir approve(0) işlemidir.',
  ].map(x => `<li>${x}</li>`).join('');
  rows([['Sahip', code(d.owner)], ['İptal edilen yetki', code(d.authorizationId)], ['Doğrulayan kontrat', code(d.executor)]]);
}

async function poll() {
  try {
    const s = await api('/api/state');
    $('phase').textContent = { AWAITING_ACCOUNT: 'Bağlantı bekleniyor…', PREPARING: 'Hazırlanıyor…', AWAITING_SIGNATURE: 'İmza bekleniyor', WORKING: 'Fork üzerinde çalışıyor…', DONE: 'Bitti', REJECTED: 'Reddedildi; çalıştırıcı durdu' }[s.phase] ?? s.phase;
    $('history').innerHTML = s.history.map(h => `<li class="ok">${esc(h.title)} — imzalandı</li>`).join('');
    $('status').innerHTML = s.status.map(x => `<li>${esc(x.text)}</li>`).join('');
    const p = s.pending;
    if (p && p.id !== pendingId) {
      pendingId = p.id; $('step').hidden = false; $('stepTitle').textContent = p.title; $('stepError').textContent = '';
      $('stepKind').textContent = { authorization: 'EIP-712 Authorization (RecurringPurchaseExecutor)', permit: 'EIP-712 Permit (USDG, EIP-2612)', revocation: 'EIP-712 Revocation (RecurringPurchaseExecutor)' }[p.kind] ?? p.kind;
      let bad;
      try {
        const r = checkStep(p, account, Math.floor(Date.now() / 1000)); bad = r.bad;
        if (p.kind === 'authorization') renderAuthorization(p, r.decoded); else if (p.kind === 'permit') renderPermit(p, r.decoded); else renderRevocation(p, r.decoded);
      } catch (e) { bad = ['decode failed: ' + e.message]; }
      $('mismatch').hidden = bad.length === 0; $('mismatch').innerHTML = bad.length ? '<strong>İmza istenmeyecek: veri hazırlanan şartlarla eşleşmiyor.</strong><br>' + bad.map(esc).join('<br>') : '';
      $('signBtn').disabled = bad.length > 0;
    }
    if (!p) { $('step').hidden = true; pendingId = null; }
  } catch (e) { $('phase').textContent = 'Sunucuya ulaşılamıyor: ' + e.message; }
  setTimeout(poll, 1500);
}

$('signBtn').onclick = async () => {
  try {
    const s = await api('/api/state'); const p = s.pending; if (!p || p.id !== pendingId) return;
    $('signBtn').disabled = true;
    const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(p.typedData)] });
    await api('/api/signature', { stepId: p.id, signature });
  } catch (e) { $('stepError').textContent = 'İmza alınamadı: ' + (e.message ?? e); $('signBtn').disabled = false; }
};
$('rejectBtn').onclick = async () => { if (pendingId) await api('/api/reject', { stepId: pendingId, reason: 'user rejected in page' }).catch(() => {}); };
poll();
