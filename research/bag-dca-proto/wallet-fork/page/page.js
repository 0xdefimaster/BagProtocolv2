// Signing page. Decodes every request from the typed data itself (lib/dca-rules.mjs, the same code the
// runner uses) and refuses to ask for a signature when anything differs from the plan.
import { formatTokenAmount } from '/lib/dca-rules.mjs';
import { checkDelegationStep, checkUserOpStep } from '/lib/sign-checks.mjs';

const secret = location.hash.slice(1);
history.replaceState(null, '', location.pathname); // keep the session secret out of the address bar
const $ = id => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-bag-session': secret, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j;
};
const usdg = x => formatTokenAmount(BigInt(x), 6) + ' USDG';
const date = s => { const d = new Date(Number(s) * 1000); return `${d.toLocaleString('tr-TR')} (${d.toISOString().replace('.000Z', 'Z')})`; };
const short = a => (a ? a.slice(0, 8) + '…' + a.slice(-6) : '');
const lc = a => String(a ?? '').toLowerCase();

// ---- wallets (EIP-6963) ----
const wallets = [];
window.addEventListener('eip6963:announceProvider', e => { if (!wallets.some(w => w.info.uuid === e.detail.info.uuid)) { wallets.push(e.detail); renderWallets(); } });
window.dispatchEvent(new Event('eip6963:requestProvider'));
function renderWallets() { $('wallet').innerHTML = wallets.map((w, i) => `<option value="${i}">${w.info.name}</option>`).join('') || '<option>Cüzdan bulunamadı</option>'; }
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
    await api('/api/account', { address: account, chainId: parseInt(chainId, 16) });
    $('connectInfo').textContent = `Bağlı hesap: ${account} (${w.info.name}). Hazırlık sürüyor…`;
    $('connectBtn').disabled = true;
  } catch (e) { $('connectInfo').textContent = 'Hata: ' + e.message; }
};

function rows(list) { $('details').querySelector('tbody').innerHTML = list.map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join(''); }

function renderDelegation(p) {
  const { decoded, bad } = checkDelegationStep(p);
  if (lc(account) !== lc(p.expect.owner)) bad.push('connected account differs from the plan owner');
  const c = decoded.caveats;
  $('planSummary').innerHTML = (p.plan?.summary?.tr ?? []).map(x => `<li>${x}</li>`).join('');
  rows([
    ['İzni veren hesap (smart account)', `<code>${decoded.delegator}</code> — sahibi: <code>${account}</code>`],
    ['USDG çekebilecek tek adres (plan)', `<code>${decoded.delegate}</code> (redeemer: <code>${c.RedeemerEnforcer?.redeemer}</code>; USDG yalnızca bu adrese: <code>${c.AllowedCalldataEnforcer?.valueAsAddress}</code>)`],
    ['Satın alınan hisselerin alıcısı', `<code>${p.plan?.recipient}</code>`],
    ['Dönem başına en fazla', usdg(c.ERC20PeriodTransferEnforcer?.periodAmount ?? 0)],
    ['Dönem süresi / ilk dönem', `${c.ERC20PeriodTransferEnforcer?.periodSeconds} sn / ${date(c.ERC20PeriodTransferEnforcer?.periodStart ?? 0)}`],
    ['Toplam bütçe', usdg(c.ERC20TransferAmountEnforcer?.totalAmount ?? 0)],
    ['En fazla alım (çağrı)', String(c.LimitedCallsEnforcer?.maxCalls)],
    ['Geçerlilik', `${date((c.TimestampEnforcer?.notBefore ?? 0n) + 1n)} → ${date(c.TimestampEnforcer?.notAfter ?? 0)}`],
    ['Token', `<code>${c.ERC20PeriodTransferEnforcer?.token}</code>`],
    ['Ağ / doğrulayan kontrat', `${decoded.domain.chainId} / <code>${decoded.domain.verifyingContract}</code>`],
    ['Ana ağ kontrolü', `fork'a özel factory <code>${short(p.expect.keylessFactory)}</code> ve paymaster <code>${short(p.expect.paymaster)}</code>: kod yok`],
  ]);
  return bad;
}

function renderUserOp(p) {
  const { decoded, bad } = checkUserOpStep(p);
  const what = p.id === 'CANCEL' ? `DelegationManager.disableDelegation (izin 2: plan <code>${short(p.expect.delegationToDisable?.delegate)}</code>)`
    : `USDG.transfer → <code>${decoded.call?.transfer?.to}</code>, ${usdg(decoded.call?.transfer?.amount ?? 0)}`;
  $('planSummary').innerHTML = '';
  rows([
    ['Hesap (sender)', `<code>${decoded.sender}</code>, nonce ${decoded.nonce}`],
    ['Yapılacak çağrı', what],
    ['Gas ödeyen', `fork'a özel paymaster <code>${decoded.paymaster?.address}</code> (ana ağda kodu yok)`],
    ['Geçerlilik sonu (paymaster)', date(decoded.paymaster?.validUntil ?? 0)],
    ['Gas üst sınırları', `doğrulama ${decoded.gas?.verificationGasLimit}, çağrı ${decoded.gas?.callGasLimit}, ön ${decoded.gas?.preVerificationGas}; maxFee ${decoded.fees?.maxFeePerGas} wei`],
    ['EntryPoint', `<code>${decoded.entryPoint}</code>`],
  ]);
  return bad;
}

async function poll() {
  try {
    const s = await api('/api/state');
    $('phase').textContent = { AWAITING_ACCOUNT: 'Bağlantı bekleniyor…', PREPARING: 'Hazırlanıyor…', AWAITING_SIGNATURE: 'İmza bekleniyor', WORKING: 'Fork üzerinde çalışıyor…', DONE: 'Bitti', REJECTED: 'Reddedildi; çalıştırıcı durdu' }[s.phase] ?? s.phase;
    $('history').innerHTML = s.history.map(h => `<li class="ok">${h.title} — imzalandı</li>`).join('');
    $('status').innerHTML = s.status.map(x => `<li>${x.text}</li>`).join('');
    const p = s.pending;
    if (p && p.id !== pendingId) {
      pendingId = p.id; $('step').hidden = false; $('stepTitle').textContent = p.title; $('stepError').textContent = '';
      $('stepKind').textContent = p.kind === 'delegation' ? 'EIP-712 Delegation (DelegationManager)' : 'EIP-712 PackedUserOperation (MultiSigDeleGator)';
      let bad; try { bad = p.kind === 'delegation' ? renderDelegation(p) : renderUserOp(p); } catch (e) { bad = ['decode failed: ' + e.message]; }
      $('mismatch').hidden = bad.length === 0; $('mismatch').innerHTML = bad.length ? '<strong>İmza istenmeyecek: veri planla eşleşmiyor.</strong><br>' + bad.join('<br>') : '';
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
