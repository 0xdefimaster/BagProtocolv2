// Checks for the three requests of the RecurringPurchaseExecutor signing flow (model A: the funds stay in the
// signer's own address). Shared by the signing page (browser) and the Node runner/tests; no dependencies.
// Each check decodes the request from its typed data and lists every difference from what the runner
// prepared. The page shows the decoded values and refuses to ask for a signature when the list is not empty.

export const AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'owner', type: 'address' }, { name: 'sourceAccount', type: 'address' }, { name: 'recipient', type: 'address' },
    { name: 'fundingKind', type: 'uint8' }, { name: 'fundingContract', type: 'address' }, { name: 'inputToken', type: 'address' },
    { name: 'bag', type: 'BagRef' }, { name: 'assets', type: 'AssetLimit[]' }, { name: 'schedule', type: 'Schedule' },
    { name: 'route', type: 'Route' }, { name: 'nonce', type: 'uint256' },
  ],
  AssetLimit: [{ name: 'asset', type: 'address' }, { name: 'symbol', type: 'string' }, { name: 'weightBps', type: 'uint16' }, { name: 'decimals', type: 'uint8' }, { name: 'maxPriceRaw', type: 'uint256' }],
  BagRef: [
    { name: 'bagId', type: 'bytes32' }, { name: 'bagVersion', type: 'uint256' }, { name: 'compositionHash', type: 'bytes32' },
    { name: 'definitionHash', type: 'bytes32' }, { name: 'strategyId', type: 'bytes32' }, { name: 'strategyVersion', type: 'uint32' },
  ],
  Route: [{ name: 'router', type: 'address' }, { name: 'swapTarget', type: 'address' }, { name: 'allowedFees', type: 'uint24[]' }],
  Schedule: [
    { name: 'grossAmountPerRun', type: 'uint256' }, { name: 'totalBudget', type: 'uint256' }, { name: 'maxExecutions', type: 'uint32' },
    { name: 'startsAt', type: 'uint64' }, { name: 'periodSeconds', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' },
  ],
};
export const PERMIT_TYPES = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
export const REVOCATION_TYPES = { Revocation: [{ name: 'owner', type: 'address' }, { name: 'authorizationId', type: 'bytes32' }] };
export const EXECUTOR_DOMAIN = { name: 'BagRecurringPurchase', version: '1' };
export const USDG_DOMAIN = { name: 'Global Dollar', version: '1' };
export const CHAIN_ID = 4663;

const lc = x => String(x ?? '').toLowerCase();
const big = x => { try { return BigInt(x); } catch { return null; } };
const withoutDomain = types => Object.fromEntries(Object.entries(types ?? {}).filter(([k]) => k !== 'EIP712Domain'));

/** Every leaf of `want` must equal `got` (addresses/hex case-insensitive, numbers as integers). */
function diff(got, want, path, bad) {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return void bad.push(`${path}: length differs`);
    want.forEach((w, i) => diff(got[i], w, `${path}[${i}]`, bad));
  } else if (want !== null && typeof want === 'object') {
    for (const k of Object.keys(want)) diff(got?.[k], want[k], path ? `${path}.${k}` : k, bad);
    for (const k of Object.keys(got ?? {})) if (!(k in want)) bad.push(`${path ? path + '.' : ''}${k}: unexpected field`);
  } else if (lc(got) !== lc(want)) bad.push(`${path}: ${String(got)} ≠ ${String(want)}`);
}

function domainChecks(td, name, version, verifyingContract, bad) {
  const d = td?.domain ?? {};
  if (d.name !== name || d.version !== version) bad.push(`domain is ${d.name} v${d.version}, expected ${name} v${version}`);
  if (Number(d.chainId) !== CHAIN_ID) bad.push(`domain chainId ${d.chainId} is not ${CHAIN_ID}`);
  if (lc(d.verifyingContract) !== lc(verifyingContract)) bad.push(`domain verifyingContract ${d.verifyingContract} is not ${verifyingContract}`);
}

export function checkAuthorizationStep(p, account) {
  const bad = [], td = p?.typedData, e = p?.expect ?? {};
  domainChecks(td, EXECUTOR_DOMAIN.name, EXECUTOR_DOMAIN.version, e.executor, bad);
  if (td?.primaryType !== 'Authorization') bad.push('not an Authorization request');
  if (JSON.stringify(withoutDomain(td?.types)) !== JSON.stringify(AUTHORIZATION_TYPES)) bad.push('typed data types differ from the executor type set');
  const m = td?.message ?? {};
  diff(m, e.authorization, '', bad);
  if (lc(m.owner) !== lc(account)) bad.push(`owner ${m.owner} is not the connected account ${account}`);
  if (lc(m.sourceAccount) !== lc(m.owner)) bad.push('the source of funds is not the signer');
  if (Number(m.fundingKind) !== 0 || lc(m.fundingContract) !== lc(m.inputToken)) bad.push('not ALLOWANCE funding: the funds would not stay in this address');
  const s = m.schedule ?? {};
  const gross = big(s.grossAmountPerRun), total = big(s.totalBudget), runs = big(s.maxExecutions), start = big(s.startsAt), period = big(s.periodSeconds), end = big(s.expiresAt);
  if (gross === null || total === null || runs === null || total !== gross * runs) bad.push('total budget is not amount per run × runs');
  if ((m.assets ?? []).some(a => big(a.maxPriceRaw) === null || big(a.maxPriceRaw) <= 0n)) bad.push('an asset has no price limit');
  if ((m.assets ?? []).some(a => typeof a.symbol !== 'string' || !/^[^:|]{1,64}$/.test(a.symbol))) bad.push('an asset symbol is missing or contains a composition separator');
  const decoded = {
    owner: m.owner, recipient: m.recipient, inputToken: m.inputToken, grossAmountPerRun: gross, totalBudget: total, runs, startsAt: start, periodSeconds: period, expiresAt: end,
    lastWindowStart: start !== null && period !== null && runs !== null ? start + period * (runs - 1n) : null,
    assets: (m.assets ?? []).map(a => ({ asset: a.asset, symbol: a.symbol, weightBps: Number(a.weightBps), decimals: Number(a.decimals), maxPriceRaw: big(a.maxPriceRaw) })),
    bag: m.bag, route: m.route, executor: td?.domain?.verifyingContract, nonce: m.nonce,
  };
  return { decoded, bad };
}

export function checkPermitStep(p, account, nowSeconds) {
  const bad = [], td = p?.typedData, e = p?.expect ?? {};
  domainChecks(td, USDG_DOMAIN.name, USDG_DOMAIN.version, e.token, bad);
  if (td?.primaryType !== 'Permit') bad.push('not a Permit request');
  if (JSON.stringify(withoutDomain(td?.types)) !== JSON.stringify(PERMIT_TYPES)) bad.push('typed data types differ from EIP-2612 Permit');
  const m = td?.message ?? {};
  if (lc(m.owner) !== lc(account)) bad.push(`owner ${m.owner} is not the connected account`);
  if (lc(m.spender) !== lc(e.executor)) bad.push(`spender ${m.spender} is not the executor ${e.executor}`);
  if (big(m.value) !== big(e.value)) bad.push(`value ${m.value} is not the total budget ${e.value}`);
  if (big(m.nonce) !== big(e.nonce)) bad.push(`nonce ${m.nonce} ≠ ${e.nonce}`);
  const deadline = big(m.deadline);
  if (deadline === null || deadline > BigInt(nowSeconds) + 7200n) bad.push('deadline is more than 2 hours away');
  return { decoded: { owner: m.owner, spender: m.spender, value: big(m.value), nonce: big(m.nonce), deadline, token: td?.domain?.verifyingContract }, bad };
}

export function checkRevocationStep(p, account) {
  const bad = [], td = p?.typedData, e = p?.expect ?? {};
  domainChecks(td, EXECUTOR_DOMAIN.name, EXECUTOR_DOMAIN.version, e.executor, bad);
  if (td?.primaryType !== 'Revocation') bad.push('not a Revocation request');
  if (JSON.stringify(withoutDomain(td?.types)) !== JSON.stringify(REVOCATION_TYPES)) bad.push('typed data types differ from Revocation');
  const m = td?.message ?? {};
  if (lc(m.owner) !== lc(account)) bad.push('owner is not the connected account');
  if (lc(m.authorizationId) !== lc(e.authorizationId)) bad.push(`authorizationId ${m.authorizationId} is not the signed authorization ${e.authorizationId}`);
  return { decoded: { owner: m.owner, authorizationId: m.authorizationId, executor: td?.domain?.verifyingContract }, bad };
}

export const checkStep = (p, account, nowSeconds) =>
  p?.kind === 'authorization' ? checkAuthorizationStep(p, account) : p?.kind === 'permit' ? checkPermitStep(p, account, nowSeconds) : p?.kind === 'revocation' ? checkRevocationStep(p, account) : { decoded: null, bad: [`unknown step kind ${p?.kind}`] };

/**
 * What the page must say before an Authorization is signed, beyond the decoded values. Two separate facts:
 *  - the per-asset max price is a FIXED ceiling, not slippage protection against the current market price: a window in
 *    which any asset is above it has no purchase, is not made up later, and the plan may end with budget unused;
 *  - every purchase needs a planSigner signature and a keeper transaction. They cannot exceed the signed limits (the
 *    executor checks them on chain), but the service must be running for purchases to happen.
 * `market` maps an asset to the price observed when the terms were prepared (raw input units per whole token), if any.
 */
export function authorizationDisclosures(decoded, market = {}) {
  const lines = (decoded?.assets ?? []).map(a => {
    const now = big(market[lc(a.asset)]);
    return { asset: a.asset, symbol: a.symbol, maxPriceRaw: a.maxPriceRaw, marketPriceRaw: now, headroomBps: now && now > 0n ? Number(((a.maxPriceRaw - now) * 10_000n) / now) : null };
  });
  return {
    priceLimit: {
      kind: 'FIXED_MAX_PRICE_PER_ASSET', isSlippageProtection: false, windowSkippedWhileAbove: true, catchUp: false, mayEndBeforeAllRuns: true, assets: lines,
      text: [
        'Azami fiyat SABİT bir tavandır; güncel piyasa fiyatına göre kayma (slippage) koruması DEĞİLDİR.',
        'Bir dönemde sepetteki herhangi bir hissenin fiyatı tavanının üstündeyse o dönemde HİÇ alım yapılmaz.',
        'Atlanan dönem sonradan telafi edilmez; fiyat bitişe kadar tavanın üstünde kalırsa kalan alımlar ve bütçe hiç kullanılmaz.',
        'Fiyat yükselince tavanı yükseltmek için yeni bir yetki imzalamak gerekir; bu yetki kendiliğinden güncellenmez.',
      ],
    },
    dependency: {
      composer: 'NOT_USED', planSignerSignatureEachRun: true, keeperTransactionEachRun: true, canExceedSignedLimits: false, canStopOrDelayPurchases: true,
      limits: [
        'Composer kullanılmaz. Her alım için BAG\'in plan imzalayıcısının (planSigner) o dönemin planını imzalaması ve bir keeper\'ın işlemi göndermesi gerekir.',
        'planSigner ve keeper imzaladığın sınırları AŞAMAZ: tutar, dönem, alıcı, sepet, fiyat tavanı ve rota her alımda zincirde kontrol edilir.',
      ],
      availability: [
        'Ama hizmete BAĞIMLISIN: planSigner veya keeper çalışmazsa ya da imzalamazsa alımlar durur veya gecikir. Bu, yetki sınırlarından ayrı bir risktir.',
        'Yetkiyi istediğin an iptal edebilirsin; iptal ve USDG izninin sıfırlanması ayrı işlemlerdir.',
      ],
    },
    ack: 'Sabit fiyat tavanı aşılırsa o dönemin alımının yapılmayacağını ve telafi edilmeyeceğini; her alımın planSigner ve keeper hizmetinin çalışmasına bağlı olduğunu anladım.',
  };
}
