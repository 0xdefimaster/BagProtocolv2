// BAG DCA plan rules: the single implementation used by the wallet-fork runner (Node) and the
// local signing page (browser). Pure ESM, no dependencies, BigInt only: no floating point anywhere
// in amount or time arithmetic.
//
// Semantics (documented in DECISIONS.md):
// - A plan is `runs` purchases of `amountPerRun` USDG, one per window of `periodSeconds`.
// - Windows are FIXED, consecutive intervals from `startTime` (calendar windows, not a rolling
//   24 h limit): window k = [startTime + k*period, startTime + (k+1)*period).
// - Missed windows do NOT accumulate. Each window allows at most one purchase; an unused window
//   is lost. When the plan expires, unspent budget simply stays in the funding account.
// - First purchase: 'IMMEDIATE' (window 0 opens now) or 'AT_START' (window 0 opens at a chosen
//   future time). There is no other difference.
// - Expiry = startTime + runs * period (end of the last window).

export class DcaRuleError extends Error {
  constructor(code, message, field) { super(message); this.code = code; this.field = field; }
}

export const TOTAL_MISMATCH_MESSAGE = 'Toplam tutar, alım sayısı × alım tutarıyla eşleşmiyor';
export const PERIOD_UNITS = Object.freeze({ minute: 60n, hour: 3600n, day: 86400n, week: 604800n });
export const PERIOD_UNIT_LABELS = Object.freeze({ minute: 'dakika', hour: 'saat', day: 'gün', week: 'hafta' });
// Bounds of the research plan contract (DcaComposerPlan: maxRuns <= 20, grossPerRun >= 1 USDG, period >= 60 s).
export const LIMITS = Object.freeze({ maxRuns: 20, minPerRunUnits: 1n, maxPeriodSeconds: 366n * 86400n, maxTotalUnits: 10n ** 12n, maxStartDelaySeconds: 366n * 86400n });

/** Parses a non-negative decimal string into raw token units. Rejects signs, exponents, separators,
 * empty input, zero and more fractional digits than the token supports. */
export function parseTokenAmount(text, decimals, field = 'amount') {
  if (typeof text !== 'string') throw new DcaRuleError('AMOUNT_NOT_TEXT', 'Tutar metin olarak girilmeli.', field);
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new DcaRuleError('AMOUNT_FORMAT', 'Tutar yalnızca rakam ve en fazla bir nokta içerebilir (örnek: 5 veya 5.25). Eksi işareti, virgül ve üs kullanılamaz.', field);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new DcaRuleError('TOO_MANY_DECIMALS', `Bu token en fazla ${decimals} ondalık basamak destekliyor.`, field);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw === 0n) throw new DcaRuleError('ZERO_AMOUNT', 'Tutar sıfırdan büyük olmalı.', field);
  if (raw > LIMITS.maxTotalUnits * 10n ** BigInt(decimals)) throw new DcaRuleError('AMOUNT_TOO_LARGE', 'Tutar desteklenen üst sınırı aşıyor.', field);
  return raw;
}

export function formatTokenAmount(raw, decimals) {
  const neg = raw < 0n, a = neg ? -raw : raw, base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (a / base).toString() + (frac ? '.' + frac : '');
}

export function parsePeriod(period) {
  const unit = period?.unit, count = period?.count;
  if (!(unit in PERIOD_UNITS)) throw new DcaRuleError('PERIOD_UNIT', 'Periyot birimi dakika, saat, gün veya hafta olmalı.', 'period');
  if (!Number.isSafeInteger(count) || count < 1) throw new DcaRuleError('PERIOD_COUNT', 'Periyot 1 veya daha büyük bir tam sayı olmalı.', 'period');
  const seconds = BigInt(count) * PERIOD_UNITS[unit];
  if (seconds > LIMITS.maxPeriodSeconds) throw new DcaRuleError('PERIOD_TOO_LONG', 'Periyot en fazla 366 gün olabilir.', 'period');
  return seconds;
}

const isAddress = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = a => a.toLowerCase();
const isoUtc = s => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z');

/**
 * Builds and validates a DCA plan. Throws DcaRuleError on the first invalid input; never adjusts a
 * field silently. `now` (unix seconds, BigInt or number) is injected so tests and the runner agree.
 */
export function buildDcaPlan(input) {
  const { bag, token, amountPerRun, runs, totalAmount, period, start, now, owner, fundingAccount, recipient } = input;
  if (!bag || !/^0x[0-9a-fA-F]{64}$/.test(bag.definitionHash ?? '')) throw new DcaRuleError('BAG_HASH', 'BAG tanım hash\'i eksik veya geçersiz.', 'bag');
  if (bag.chainId !== 4663) throw new DcaRuleError('BAG_CHAIN', 'Bu prototip yalnızca Robinhood Chain (4663) BAG\'lerini destekler.', 'bag');
  if (!token || !isAddress(token.address) || token.verifiedOnChain !== true || token.decimals !== 6 || token.symbol !== 'USDG')
    throw new DcaRuleError('TOKEN_UNVERIFIED', 'USDG tanımı zincirden doğrulanmadı (adres, sembol ve 6 ondalık).', 'token');
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > LIMITS.maxRuns) throw new DcaRuleError('RUNS', `Alım sayısı 1 ile ${LIMITS.maxRuns} arasında bir tam sayı olmalı (araştırma plan kontratının sınırı).`, 'runs');
  for (const [k, a] of [['owner', owner], ['fundingAccount', fundingAccount], ['recipient', recipient]])
    if (!isAddress(a)) throw new DcaRuleError('ADDRESS', `${k} adresi geçersiz.`, k);
  const perRunRaw = parseTokenAmount(amountPerRun, token.decimals, 'amountPerRun');
  if (perRunRaw < LIMITS.minPerRunUnits * 10n ** BigInt(token.decimals)) throw new DcaRuleError('AMOUNT_BELOW_MIN', 'Alım başına tutar en az 1 USDG olmalı.', 'amountPerRun');
  const computedTotal = perRunRaw * BigInt(runs);
  // An editable total is a check, not an input: a mismatch is an error, never auto-corrected.
  if (totalAmount !== undefined && totalAmount !== null && String(totalAmount).trim() !== '') {
    const enteredTotal = parseTokenAmount(String(totalAmount), token.decimals, 'totalAmount');
    if (enteredTotal !== computedTotal) throw new DcaRuleError('TOTAL_MISMATCH', TOTAL_MISMATCH_MESSAGE, 'totalAmount');
  }
  const periodSeconds = parsePeriod(period);
  const nowS = BigInt(now);
  let startTime, firstPurchase;
  if (start?.mode === 'now') { startTime = nowS; firstPurchase = 'IMMEDIATE'; }
  else if (start?.mode === 'at') {
    const at = BigInt(start.at);
    if (at < nowS) throw new DcaRuleError('START_IN_PAST', 'Başlangıç zamanı geçmişte olamaz.', 'start');
    if (at - nowS > LIMITS.maxStartDelaySeconds) throw new DcaRuleError('START_TOO_FAR', 'Başlangıç en fazla 366 gün sonra olabilir.', 'start');
    startTime = at; firstPurchase = at === nowS ? 'IMMEDIATE' : 'AT_START';
  } else throw new DcaRuleError('START_MODE', 'İlk alım "hemen" veya "seçilen zamanda" olmalı.', 'start');
  const expiry = startTime + periodSeconds * BigInt(runs);
  const windows = Array.from({ length: runs }, (_, k) => ({ index: k, opensAt: startTime + periodSeconds * BigInt(k), closesAt: startTime + periodSeconds * BigInt(k + 1) - 1n }));
  const unitLabel = PERIOD_UNIT_LABELS[period.unit];
  const fmt = r => formatTokenAmount(r, token.decimals);
  return {
    version: 'bag-dca-plan/v1',
    bag: { definitionHash: lower(bag.definitionHash), strategyId: bag.strategyId ?? null, version: bag.version ?? null, chainId: bag.chainId },
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    owner, fundingAccount, recipient,
    perRunRaw, runs, totalRaw: computedTotal, periodSeconds, startTime, expiry, firstPurchase, windows,
    missedWindowPolicy: 'NO_ACCUMULATION',
    summary: {
      tr: [
        `${runs} alım × ${fmt(perRunRaw)} USDG = toplam ${fmt(computedTotal)} USDG`,
        `Her ${period.count} ${unitLabel} en fazla bir alım (${periodSeconds} sn'lik sabit takvim pencereleri; kayan 24 saat sınırı değil). Plan ayrıca iki alım arasında en az bir periyot bekler`,
        firstPurchase === 'IMMEDIATE' ? `İlk alım hemen: ${isoUtc(startTime)}` : `İlk alım seçilen başlangıçta: ${isoUtc(startTime)}`,
        `Son pencere: ${isoUtc(windows[runs - 1].opensAt)} – ${isoUtc(windows[runs - 1].closesAt)}; izin ${isoUtc(expiry)} itibarıyla sona erer`,
        'Kaçırılan pencere birikmez; yapılamayan alımın parası fonlama hesabında kalır',
        `Alınan hisselerin alıcısı: ${recipient}`,
      ],
      startUtc: isoUtc(startTime), expiryUtc: isoUtc(expiry),
    },
  };
}

/** Delegation caveat values the plan requires (Delegation Framework v1.3.0 enforcer terms). */
export function planCaveatSpec(plan, planAddress, { maxCalls } = {}) {
  return {
    token: lower(plan.token.address), periodAmount: plan.perRunRaw, periodSeconds: plan.periodSeconds, periodStart: plan.startTime,
    totalAmount: plan.totalRaw, maxCalls: BigInt(maxCalls ?? plan.runs), notBefore: plan.startTime - 1n, notAfter: plan.expiry,
    redeemer: lower(planAddress), transferRecipient: lower(planAddress),
  };
}

// ---- Hex helpers (browser-safe) -----------------------------------------------------------------
const strip = h => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
const word = (h, i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));
const addrAt = (h, byteOffset) => '0x' + h.slice(byteOffset * 2, byteOffset * 2 + 40);
const uintAt = (h, byteOffset, bytes) => BigInt('0x' + h.slice(byteOffset * 2, (byteOffset + bytes) * 2));

/**
 * Decodes the Delegation EIP-712 typed data the wallet will sign into plain values, using only the
 * typed data itself and a map of the trusted enforcer addresses. Unknown or duplicate enforcers,
 * wrong term lengths or args are reported as errors (the caller must refuse to sign).
 */
export function decodeDelegationTypedData(typedData, enforcers) {
  const errors = [], out = { caveats: {} };
  if (typedData?.primaryType !== 'Delegation') errors.push('primaryType is not Delegation');
  const d = typedData?.domain ?? {}, m = typedData?.message ?? {};
  out.domain = { name: d.name, version: d.version, chainId: Number(d.chainId), verifyingContract: lower(d.verifyingContract ?? '') };
  out.delegate = lower(m.delegate ?? ''); out.delegator = lower(m.delegator ?? ''); out.authority = lower(m.authority ?? ''); out.salt = String(m.salt);
  const byAddr = Object.fromEntries(Object.entries(enforcers).map(([k, a]) => [lower(a), k]));
  for (const c of m.caveats ?? []) {
    const kind = byAddr[lower(c.enforcer ?? '')];
    if (!kind) { errors.push(`unknown enforcer ${c.enforcer}`); continue; }
    if (out.caveats[kind]) { errors.push(`duplicate caveat ${kind}`); continue; }
    if (c.args !== undefined && c.args !== '0x') errors.push(`caveat ${kind} carries args`);
    const h = strip(c.terms ?? '0x'), n = h.length / 2;
    try {
      if (kind === 'ERC20PeriodTransferEnforcer') { if (n !== 116) throw 0; out.caveats[kind] = { token: addrAt(h, 0), periodAmount: uintAt(h, 20, 32), periodSeconds: uintAt(h, 52, 32), periodStart: uintAt(h, 84, 32) }; }
      else if (kind === 'ERC20TransferAmountEnforcer') { if (n !== 52) throw 0; out.caveats[kind] = { token: addrAt(h, 0), totalAmount: uintAt(h, 20, 32) }; }
      else if (kind === 'LimitedCallsEnforcer') { if (n !== 32) throw 0; out.caveats[kind] = { maxCalls: uintAt(h, 0, 32) }; }
      else if (kind === 'TimestampEnforcer') { if (n !== 32) throw 0; out.caveats[kind] = { notBefore: uintAt(h, 0, 16), notAfter: uintAt(h, 16, 16) }; }
      else if (kind === 'RedeemerEnforcer') { if (n !== 20) throw 0; out.caveats[kind] = { redeemer: addrAt(h, 0) }; }
      else if (kind === 'AllowedCalldataEnforcer') { if (n !== 64) throw 0; out.caveats[kind] = { offset: uintAt(h, 0, 32), value: '0x' + h.slice(64), valueAsAddress: '0x' + h.slice(64 + 24, 128) }; }
    } catch { errors.push(`caveat ${kind} has unexpected terms length ${n}`); }
  }
  for (const k of Object.keys(enforcers)) if (!out.caveats[k]) errors.push(`missing caveat ${k}`);
  return { decoded: out, errors };
}

/** Compares a decoded delegation with the plan (and expected addresses). Returns a list of mismatches. */
export function compareDelegationToPlan(decoded, spec, expect) {
  const bad = [], c = decoded.caveats, eq = (label, a, b) => { if (String(a).toLowerCase() !== String(b).toLowerCase()) bad.push(`${label}: imzalanacak=${a} beklenen=${b}`); };
  eq('domain.chainId', decoded.domain.chainId, 4663); eq('domain.name', decoded.domain.name, 'DelegationManager'); eq('domain.verifyingContract', decoded.domain.verifyingContract, expect.delegationManager);
  eq('delegate', decoded.delegate, spec.redeemer); eq('delegator', decoded.delegator, expect.delegator); eq('authority', decoded.authority, '0x' + 'f'.repeat(64));
  const P = c.ERC20PeriodTransferEnforcer ?? {}, T = c.ERC20TransferAmountEnforcer ?? {}, L = c.LimitedCallsEnforcer ?? {}, S = c.TimestampEnforcer ?? {}, R = c.RedeemerEnforcer ?? {}, A = c.AllowedCalldataEnforcer ?? {};
  eq('period.token', P.token, spec.token); eq('period.amount', P.periodAmount, spec.periodAmount); eq('period.seconds', P.periodSeconds, spec.periodSeconds); eq('period.start', P.periodStart, spec.periodStart);
  eq('total.token', T.token, spec.token); eq('total.amount', T.totalAmount, spec.totalAmount);
  eq('calls.max', L.maxCalls, spec.maxCalls); eq('time.notBefore', S.notBefore, spec.notBefore); eq('time.notAfter', S.notAfter, spec.notAfter);
  eq('redeemer', R.redeemer, spec.redeemer); eq('allowedCalldata.offset', A.offset, 4n); eq('transfer recipient', A.valueAsAddress, spec.transferRecipient);
  if (A.value && A.value.slice(2, 26) !== '0'.repeat(24)) bad.push('allowedCalldata value is not a left-padded address');
  return bad;
}

/**
 * Decodes a MultiSigDeleGator PackedUserOperation typed data for display and checks: the inner single
 * call (execute(Execution)), the paymaster binding and its validity window.
 */
export function decodeUserOpTypedData(typedData) {
  const errors = [], m = typedData?.message ?? {}, d = typedData?.domain ?? {};
  if (typedData?.primaryType !== 'PackedUserOperation') errors.push('primaryType is not PackedUserOperation');
  const out = { domain: { name: d.name, chainId: Number(d.chainId), verifyingContract: lower(d.verifyingContract ?? '') }, sender: lower(m.sender ?? ''), nonce: String(m.nonce), entryPoint: lower(m.entryPoint ?? '') };
  const cd = strip(m.callData ?? '0x');
  if (cd.slice(0, 8) !== '5c1c6dcd') errors.push(`callData selector 0x${cd.slice(0, 8)} is not execute(Execution)`);
  else {
    const body = cd.slice(8); // tuple offset, then (target, value, bytes offset, len, data)
    const t = Number(word(body, 0)) * 2, tuple = body.slice(t);
    out.call = { target: '0x' + tuple.slice(24, 64), value: word(tuple, 1) };
    const dataOff = Number(word(tuple, 2)) * 2, len = Number(BigInt('0x' + tuple.slice(dataOff, dataOff + 64))) * 2;
    out.call.data = '0x' + tuple.slice(dataOff + 64, dataOff + 64 + len);
    out.call.selector = out.call.data.slice(0, 10);
    if (out.call.selector === '0xa9059cbb') out.call.transfer = { to: '0x' + out.call.data.slice(10 + 24, 10 + 64), amount: BigInt('0x' + out.call.data.slice(74, 138)) };
  }
  const pm = strip(m.paymasterAndData ?? '0x');
  if (pm.length !== 128) errors.push(`paymasterAndData has ${pm.length / 2} bytes, expected 64`);
  else out.paymaster = { address: '0x' + pm.slice(0, 40), verificationGas: BigInt('0x' + pm.slice(40, 72)), postOpGas: BigInt('0x' + pm.slice(72, 104)), validUntil: BigInt('0x' + pm.slice(104, 116)), validAfter: BigInt('0x' + pm.slice(116, 128)) };
  const g = strip(m.accountGasLimits ?? '0x'), f = strip(m.gasFees ?? '0x');
  if (g.length === 64) out.gas = { verificationGasLimit: BigInt('0x' + g.slice(0, 32)), callGasLimit: BigInt('0x' + g.slice(32)), preVerificationGas: BigInt(m.preVerificationGas ?? 0) };
  if (f.length === 64) out.fees = { maxPriorityFeePerGas: BigInt('0x' + f.slice(0, 32)), maxFeePerGas: BigInt('0x' + f.slice(32)) };
  return { decoded: out, errors };
}

/** JSON with BigInt as decimal strings; stable key order for hashing. */
export function canonicalJson(x) {
  const norm = v => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v);
  return JSON.stringify(norm(x));
}
