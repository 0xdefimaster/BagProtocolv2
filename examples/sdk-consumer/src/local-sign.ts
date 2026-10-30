// Local signing page for a live SDK purchase: the SDK quotes, simulates and verifies in this Node
// process; the browser only asks the user's own wallet (EIP-1193, e.g. MetaMask) to send the exact
// transactions this process returns. Listens on 127.0.0.1 only and requires the session token it
// prints. API keys and the RPC URL never reach the page. No private key is read or used.
//
//   node dist/local-sign.js <bag.json> <amountRaw> [port]
//
// Env: RPC_URL, LIFI_API_KEY, COMPOSER_FACTORY, COMPOSER_FACTORY_CODE_HASH, INPUT_TOKEN,
// optional COMPOSER_URL, QUOTE_MAX_AGE_MS (default 60000), RECEIPT_EVIDENCE_MODE.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSdkErrorInfo, simulateBag, type CompiledPurchase, type Hex } from '@bagprotocol/sdk';
import { withReceiptEvidence, type ReceiptEvidenceOptions } from '@bagprotocol/sdk/evm';
import { createPublicClient, encodeFunctionData, http } from 'viem';
import { createIntent, preparePurchase, restoreIntent, verifySubmitted, type PlanningClient } from './purchase.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const approveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);

/** This file's own messages: no credentials or upstream text, so the page may show them as they are. */
class LocalError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new LocalError(`Missing ${name}.`);
  return value;
}

interface Session {
  signer: Hex | null;
  pending: CompiledPurchase | null;
  intent: { file: string; text: string; hash: Hex } | null;
  /** Set once the wallet returned the purchase hash; no second purchase for this intent. */
  purchaseHash: Hex | null;
}

async function main() {
  const [bagFile, amountArg, portArg] = process.argv.slice(2);
  if (!bagFile || !amountArg || !/^\d+$/.test(amountArg)) throw new LocalError('Usage: node dist/local-sign.js <bag.json> <amountRaw> [port]');
  const amountRaw = BigInt(amountArg);
  const port = Number(portArg ?? 8787);
  const inputToken = required('INPUT_TOKEN') as Hex;
  if (!ADDRESS.test(inputToken)) throw new LocalError('INPUT_TOKEN is not an address.');
  const maxQuoteAgeMs = Number(process.env.QUOTE_MAX_AGE_MS ?? 60_000);
  const mode = process.env.RECEIPT_EVIDENCE_MODE ?? 'ROBINHOOD_NITRO_TRANSACTION_INDEX';
  const client = createPublicClient({ transport: http(required('RPC_URL'), { retryCount: 0, timeout: 30_000 }) });
  const chainId = await client.getChainId();
  const deployment = { chainId, factory: required('COMPOSER_FACTORY') as Hex, factoryCodeHash: required('COMPOSER_FACTORY_CODE_HASH') as Hex };
  const apiKey = required('LIFI_API_KEY');
  const composerUrl = process.env.COMPOSER_URL ?? 'https://composer.li.quest';
  const bagText = await readFile(bagFile, 'utf8');
  const outDir = join(process.cwd(), 'live-purchases');
  await mkdir(outDir, { recursive: true });

  const token = randomBytes(24).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const session: Session = { signer: null, pending: null, intent: null, purchaseHash: null };

  const handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    async prepare(body) {
      if (session.purchaseHash) throw new LocalError('A purchase was already sent in this session. Restart for another one.');
      const signer = body.signer;
      if (typeof signer !== 'string' || !ADDRESS.test(signer)) throw new LocalError('Invalid signer.');
      const result = await preparePurchase({ bagText, inputToken, amountRaw, signer: signer as Hex, client: client as unknown as PlanningClient,
        deployment, apiKey, composerUrl, maxQuoteAgeMs });
      if (result.simulation.status !== 'OK' && result.simulation.status !== 'NEEDS_APPROVAL') {
        throw new LocalError(`Simulation is not ready: ${result.simulation.status}.`);
      }
      session.signer = signer as Hex;
      session.pending = result.compiled;
      session.intent = null;
      const q = result.compiled.quote;
      return { definitionHash: result.definitionHash, simulation: result.simulation.status, inputToken, amountRaw,
        swapAmountRaw: q.plan.swapAmountRaw, priceImpactBps: q.priceImpactBps, fees: q.fees, warnings: q.warnings.length,
        validUntilMs: q.validUntilMs, requestedAtMs: q.requestedAtMs, maxQuoteAgeMs,
        legs: q.legs.map(l => ({ token: l.token, expectedOutRaw: l.expectedOutRaw, minOutRaw: l.minOutRaw })),
        approvals: result.compiled.approvals };
    },
    async intent(body) {
      if (!session.pending || !session.signer) throw new LocalError('Get a quote first.');
      if (body.reviewed !== true) throw new LocalError('Confirm that you reviewed the minimums.');
      const minima = body.minima;
      if (!Array.isArray(minima)) throw new LocalError('Invalid minimums.');
      const snapshot = createIntent(session.pending, minima.map((m: { token?: unknown; amountRaw?: unknown }) => {
        if (typeof m?.token !== 'string' || typeof m.amountRaw !== 'string' || !/^\d+$/.test(m.amountRaw)) throw new LocalError('Invalid minimum.');
        return { token: m.token as Hex, amountRaw: BigInt(m.amountRaw) };
      }));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(outDir, `purchase-${stamp}.intent.json`);
      await writeFile(file, snapshot.text, { flag: 'wx' });
      await writeFile(join(outDir, `purchase-${stamp}.intent-hash.txt`), snapshot.integrityHash + '\n', { flag: 'wx' });
      session.intent = { file, text: snapshot.text, hash: snapshot.integrityHash };
      session.pending = null;
      return { intentHash: snapshot.integrityHash, file };
    },
    /** The next transaction to send: an approval, or the original purchase once simulation is OK. */
    async next() {
      if (!session.intent || !session.signer) throw new LocalError('Save a reviewed intent first.');
      if (session.purchaseHash) throw new LocalError('The purchase was already sent. Verify it; never send it twice.');
      const compiled = restoreIntent(session.intent.text, session.intent.hash).compiled;
      const sim = await simulateBag(compiled, { client: client as unknown as PlanningClient, maxQuoteAgeMs });
      if (sim.status === 'QUOTE_EXPIRED') return { kind: 'EXPIRED' };
      if (sim.status === 'NEEDS_APPROVAL') {
        const a = sim.missing[0];
        return { kind: 'APPROVAL', tx: { chainId: compiled.transaction.chainId, from: session.signer, to: a.token, value: '0x0',
          data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [a.spender, a.amountRaw] }) }, spender: a.spender, amountRaw: a.amountRaw };
      }
      if (sim.status !== 'OK') return { kind: 'NOT_READY', simulation: sim };
      const t = compiled.transaction;
      return { kind: 'PURCHASE', tx: { chainId: t.chainId, from: session.signer, to: t.to, data: t.data, value: '0x' + t.value.toString(16) } };
    },
    async approvalSent(body) {
      const hash = body.hash;
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new LocalError('Invalid hash.');
      const receipt = await client.waitForTransactionReceipt({ hash: hash as Hex, timeout: 180_000 });
      return { status: receipt.status };
    },
    async purchaseSent(body) {
      const hash = body.hash;
      if (!session.intent || typeof hash !== 'string' || !HASH.test(hash)) throw new LocalError('Invalid hash.');
      if (session.purchaseHash) throw new LocalError('A purchase hash is already recorded.');
      session.purchaseHash = hash as Hex;
      // Persist the hash with the intent BEFORE any receipt evidence is collected.
      await writeFile(session.intent.file.replace(/\.intent\.json$/, '.tx.txt'), hash + '\n', { flag: 'wx' });
      return { recorded: true };
    },
    async verify() {
      if (!session.intent || !session.purchaseHash) throw new LocalError('No purchase to verify.');
      const evidence = withReceiptEvidence(client, { balanceState: mode as ReceiptEvidenceOptions['balanceState'] });
      const result = await verifySubmitted({ snapshotText: session.intent.text, trustedIntentHash: session.intent.hash,
        transactionHash: session.purchaseHash, client: evidence });
      if (result.status === 'VERIFIED') {
        await writeFile(session.intent.file.replace(/\.intent\.json$/, '.verified.json'), JSON.stringify(JSON.parse(json(result)), null, 2) + '\n', { flag: 'wx' }).catch(() => undefined);
      }
      return result;
    },
  };

  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    // No CSP header: some wallet extensions inject their provider with a script a strict policy would block.
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 100_000) reject(new Error('too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== token) return send(res, 403, 'Open the exact URL printed in the terminal.', 'text/plain');
        return send(res, 200, PAGE.replace('__TOKEN__', token).replace('__CHAIN__', String(chainId)), 'text/html; charset=utf-8');
      }
      const name = url.pathname.replace(/^\/api\//, '');
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/') || !handlers[name]) return send(res, 404, '{}');
      // Only this page may call the API: same origin and the session token.
      if (req.headers.origin !== origin || req.headers['x-session-token'] !== token) return send(res, 403, json({ error: 'FORBIDDEN' }));
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      send(res, 200, json(await handlers[name](body)));
    } catch (error) {
      send(res, 400, json({ error: error instanceof LocalError ? { code: 'LOCAL', message: error.message } : getSdkErrorInfo(error) }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Chain ${chainId}. Open in the browser that has your wallet:\n\n  ${origin}/?t=${token}\n`);
    console.log(`Files are written to ${outDir}. Stop with Ctrl+C.`);
  });
}

const PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BAG SDK canlı alım</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111;background:#fafafa}
h1{font-size:20px}section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
button{font:inherit;padding:6px 14px;margin:4px 0;cursor:pointer}button:disabled{opacity:.5;cursor:default}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;font-family:monospace;font-size:13px}
input[type=text]{font-family:monospace;width:100%;box-sizing:border-box}#log{white-space:pre-wrap;font-family:monospace;font-size:12px;background:#111;color:#ddd;padding:10px;border-radius:6px;max-height:320px;overflow:auto}
.warn{color:#a40}</style></head><body>
<h1>BAG SDK canlı alım (3. kapı)</h1>
<p class="warn">Gerçek işlem. Küçük tutarla deneyin. Bu sayfa private key istemez; her işlemi cüzdanınızda kendiniz onaylarsınız.</p>
<section><b>1. Cüzdan</b><br><button id="connect">Cüzdanı bağla</button> <span id="acct"></span></section>
<section><b>2. Teklif</b><br><button id="quote" disabled>Teklif al</button><div id="quoteOut"></div></section>
<section><b>3. Minimumları onayla</b><div id="minOut">Önce teklif alın.</div>
<label><input type="checkbox" id="reviewed"> Her token için cüzdana en az gelmesi gereken miktarı kontrol ettim.</label><br>
<button id="save" disabled>Niyeti kaydet</button> <span id="intentOut"></span></section>
<section><b>4. Gönder</b><br><button id="buy" disabled>Onay + satın al</button></section>
<section><b>5. Doğrula</b><br><button id="verify" disabled>SDK ile doğrula</button></section>
<div id="log"></div>
<script>
const TOKEN='__TOKEN__', CHAIN=Number('__CHAIN__'); let account=null, legs=[];
const $=id=>document.getElementById(id);
const log=m=>{$('log').textContent+=new Date().toLocaleTimeString()+'  '+m+'\\n';$('log').scrollTop=1e9};
async function api(name,body){const r=await fetch('/api/'+name,{method:'POST',headers:{'content-type':'application/json','x-session-token':TOKEN},body:JSON.stringify(body||{})});
 const j=await r.json(); if(!r.ok) throw new Error((j.error&&(j.error.code+': '+(j.error.message||'')))||'error'); return j}
const eth=()=>{if(!window.ethereum) throw new Error('Tarayıcıda cüzdan yok (MetaMask).'); return window.ethereum};
async function checkWallet(){const id=Number(await eth().request({method:'eth_chainId'}));
 if(id!==CHAIN){await eth().request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+CHAIN.toString(16)}]})}
 const a=await eth().request({method:'eth_requestAccounts'}); if(!a.map(x=>x.toLowerCase()).includes(account)) throw new Error('Bağlı cüzdan değişti.')}
$('connect').onclick=async()=>{try{const a=await eth().request({method:'eth_requestAccounts'}); account=a[0].toLowerCase();
 const id=Number(await eth().request({method:'eth_chainId'})); if(id!==CHAIN) await eth().request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+CHAIN.toString(16)}]});
 $('acct').textContent=account; $('quote').disabled=false; log('Cüzdan: '+account)}catch(e){log('HATA '+e.message)}};
$('quote').onclick=async()=>{try{$('quote').disabled=true; log('Teklif alınıyor…'); const q=await api('prepare',{signer:account}); legs=q.legs;
 $('quoteOut').innerHTML='<table><tr><th>token</th><th>beklenen</th><th>swap minimumu</th></tr>'+q.legs.map(l=>'<tr><td>'+l.token+'</td><td>'+l.expectedOutRaw+'</td><td>'+l.minOutRaw+'</td></tr>').join('')+'</table>'+
  '<p>Girdi: '+q.amountRaw+' (ham birim), fiyat etkisi: '+q.priceImpactBps+' bps, uyarı: '+q.warnings+', simülasyon: '+q.simulation+', onay gerekli: '+(q.approvals.length?'evet':'hayır')+'</p>';
 $('minOut').innerHTML='<table><tr><th>token</th><th>cüzdana en az (ham)</th></tr>'+q.legs.map((l,i)=>'<tr><td>'+l.token+'</td><td><input type=text id=min'+i+' value="'+(l.minOutRaw||'')+'"></td></tr>').join('')+'</table><p>Varsayılan değer swap minimumudur; bunun altı kabul edilmez. İsterseniz yükseltin.</p>';
 $('save').disabled=false; log('Teklif hazır. Süre: '+Math.round(q.maxQuoteAgeMs/1000)+' sn içinde gönderin.')}catch(e){log('HATA '+e.message)}finally{$('quote').disabled=false}};
$('save').onclick=async()=>{try{const minima=legs.map((l,i)=>({token:l.token,amountRaw:$('min'+i).value.trim()}));
 const r=await api('intent',{minima,reviewed:$('reviewed').checked}); $('intentOut').textContent=r.intentHash; $('buy').disabled=false; $('save').disabled=true; log('Niyet kaydedildi: '+r.file)}catch(e){log('HATA '+e.message)}};
$('buy').onclick=async()=>{$('buy').disabled=true; try{for(let i=0;i<5;i++){await checkWallet(); const n=await api('next');
 if(n.kind==='EXPIRED'){log('Teklifin süresi doldu. Onay varsa korunur. "Teklif al" ile yeni teklif alıp minimumları yeniden onaylayın.'); $('save').disabled=true; return}
 if(n.kind==='NOT_READY'){log('Simülasyon hazır değil: '+JSON.stringify(n.simulation)); return}
 if(n.kind==='APPROVAL'){log('USDG onayı istenecek: '+n.amountRaw+' → '+n.spender); const h=await eth().request({method:'eth_sendTransaction',params:[n.tx]}); log('Onay gönderildi: '+h+' (bekleniyor)');
  const r=await api('approvalSent',{hash:h}); log('Onay sonucu: '+r.status); if(r.status!=='success') return; continue}
 if(n.kind==='PURCHASE'){log('Satın alma işlemi istenecek (orijinal derlenmiş işlem).'); const h=await eth().request({method:'eth_sendTransaction',params:[n.tx]});
  await api('purchaseSent',{hash:h}); log('SATIN ALMA GÖNDERİLDİ: '+h+'\\nBu hash dosyaya kaydedildi. Birkaç blok sonra "SDK ile doğrula"ya basın. Tekrar göndermeyin.'); $('verify').disabled=false; return}}
 }catch(e){log('HATA '+e.message+' (bir işlem gönderildiyse tekrar göndermeden önce cüzdandaki geçmişe bakın)')}};
$('verify').onclick=async()=>{try{log('Doğrulanıyor…'); const r=await api('verify'); log('SONUÇ: '+r.status+(r.reason?' / '+r.reason:'')+'\\n'+JSON.stringify(r,null,2))}catch(e){log('HATA '+e.message)}};
</script></body></html>`;

main().catch(error => { console.error(error instanceof LocalError ? error.message : json(getSdkErrorInfo(error))); process.exitCode = 1; });
