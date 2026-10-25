// executor-wallet/lib/sign-checks.mjs: the page refuses to ask for a signature whenever the typed data differs from
// the prepared terms. Every tamper class below must produce at least one listed difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZATION_TYPES, PERMIT_TYPES, REVOCATION_TYPES, checkStep, authorizationDisclosures } from '../executor-wallet/lib/sign-checks.mjs';

const EXEC = '0x008f01d056eb06d708eaec1e2e27b82435910cb9', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', ME = '0x1111111111111111111111111111111111111111';
const D = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const auth = {
  owner: ME, sourceAccount: ME, recipient: ME, fundingKind: '0', fundingContract: USDG, inputToken: USDG,
  bag: { bagId: '0x' + '37'.repeat(32), bagVersion: '1', compositionHash: '0x' + 'b0'.repeat(32), definitionHash: '0x' + '5d'.repeat(32), strategyId: '0x' + '00'.repeat(32), strategyVersion: '0' },
  assets: [{ asset: '0x2222222222222222222222222222222222222222', symbol: 'GME', weightBps: '10000', decimals: '18', maxPriceRaw: '25000000' }],
  schedule: { grossAmountPerRun: '5000000', totalBudget: '15000000', maxExecutions: '3', startsAt: '1000', periodSeconds: '86400', expiresAt: '260200' },
  route: { router: '0x3333333333333333333333333333333333333333', swapTarget: '0xcaf681a66d020601342297493863e78c959e5cb2', allowedFees: ['500', '3000'] },
  nonce: '1',
};
const clone = x => JSON.parse(JSON.stringify(x));
const authStep = () => ({ kind: 'authorization', typedData: { domain: { name: 'BagRecurringPurchase', version: '1', chainId: 4663, verifyingContract: EXEC }, primaryType: 'Authorization', types: { EIP712Domain: D, ...clone(AUTHORIZATION_TYPES) }, message: clone(auth) }, expect: { executor: EXEC, authorization: clone(auth) } });
const NOW = 1_800_000_000;
const permitStep = () => ({ kind: 'permit', typedData: { domain: { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: USDG }, primaryType: 'Permit', types: { EIP712Domain: D, ...clone(PERMIT_TYPES) }, message: { owner: ME, spender: EXEC, value: '15000000', nonce: '0', deadline: String(NOW + 3600) } }, expect: { token: USDG, executor: EXEC, value: '15000000', nonce: '0' } });
const revokeStep = () => ({ kind: 'revocation', typedData: { domain: { name: 'BagRecurringPurchase', version: '1', chainId: 4663, verifyingContract: EXEC }, primaryType: 'Revocation', types: { EIP712Domain: D, ...clone(REVOCATION_TYPES) }, message: { owner: ME, authorizationId: '0x' + 'ab'.repeat(32) } }, expect: { executor: EXEC, authorizationId: '0x' + 'ab'.repeat(32) } });
const bad = (p, account = ME) => checkStep(p, account, NOW).bad;

test('untouched requests pass (addresses compared case-insensitively)', () => {
  assert.deepEqual(bad(authStep()), []);
  assert.deepEqual(bad(authStep(), ME.toUpperCase().replace('0X', '0x')), []);
  assert.deepEqual(bad(permitStep()), []);
  assert.deepEqual(bad(revokeStep()), []);
});

test('authorization: domain, types, any value, signer, funding kind and budget tampering are listed', () => {
  const cases = {
    chainId: p => (p.typedData.domain.chainId = 1),
    verifyingContract: p => (p.typedData.domain.verifyingContract = USDG),
    domainName: p => (p.typedData.domain.name = 'Other'),
    extraType: p => (p.typedData.types.Extra = []),
    fieldOrder: p => p.typedData.types.Schedule.reverse(),
    recipient: p => (p.typedData.message.recipient = '0x9999999999999999999999999999999999999999'),
    amount: p => (p.typedData.message.schedule.grossAmountPerRun = '6000000'),
    priceLimit: p => (p.typedData.message.assets[0].maxPriceRaw = '99999999999'),
    feeTier: p => p.typedData.message.route.allowedFees.push('10000'),
    extraField: p => (p.typedData.message.extra = '1'),
    bagVersion: p => (p.typedData.message.bag.bagVersion = '2'),
    symbol: p => (p.typedData.message.assets[0].symbol = 'AAPL'),
    typesWithoutSymbol: p => (p.typedData.types.AssetLimit = p.typedData.types.AssetLimit.filter(f => f.name !== 'symbol')),
  };
  for (const [name, mutate] of Object.entries(cases)) { const p = authStep(); mutate(p); assert.ok(bad(p).length > 0, name); }
  assert.ok(bad(authStep(), '0x4444444444444444444444444444444444444444').some(x => /connected account/.test(x)));
  const del = authStep(); del.typedData.message.fundingKind = '1'; del.expect.authorization.fundingKind = '1';
  assert.ok(bad(del).some(x => /ALLOWANCE/.test(x)), 'DELEGATION funding is refused here: funds would leave the address');
  const sep = authStep(); sep.typedData.message.assets[0].symbol = 'GME|robinhood'; sep.expect.authorization.assets[0].symbol = 'GME|robinhood';
  assert.ok(bad(sep).some(x => /separator/.test(x)), 'a symbol that would inject a composition row is refused even when it matches the prepared terms');
  const total = authStep(); total.typedData.message.schedule.totalBudget = '30000000'; total.expect.authorization.schedule.totalBudget = '30000000';
  assert.ok(bad(total).some(x => /total budget/.test(x)), 'a consistent but wrong total is still refused');
});

test('permit: spender, value, nonce, token, owner and a far deadline are listed', () => {
  const cases = {
    spender: p => (p.typedData.message.spender = '0x9999999999999999999999999999999999999999'),
    value: p => (p.typedData.message.value = '115792089237316195423570985008687907853269984665640564039457584007913129639935'),
    nonce: p => (p.typedData.message.nonce = '1'),
    token: p => (p.typedData.domain.verifyingContract = EXEC),
    owner: p => (p.typedData.message.owner = '0x4444444444444444444444444444444444444444'),
    deadline: p => (p.typedData.message.deadline = String(NOW + 30 * 86400)),
    types: p => (p.typedData.types.Permit = p.typedData.types.Permit.slice(0, 4)),
  };
  for (const [name, mutate] of Object.entries(cases)) { const p = permitStep(); mutate(p); assert.ok(bad(p).length > 0, name); }
});

test('revocation: another authorization id, owner or executor is listed; unknown kinds are refused', () => {
  const id = revokeStep(); id.typedData.message.authorizationId = '0x' + 'cd'.repeat(32); assert.ok(bad(id).length > 0);
  const own = revokeStep(); own.typedData.message.owner = '0x4444444444444444444444444444444444444444'; assert.ok(bad(own).length > 0);
  const ex = revokeStep(); ex.typedData.domain.verifyingContract = USDG; assert.ok(bad(ex).length > 0);
  assert.ok(bad({ kind: 'transaction', typedData: {} }).length > 0);
});

test('disclosures: the fixed max price is not slippage protection and skipped windows are not made up; planSigner limits and availability are stated separately', () => {
  const { decoded } = checkStep(authStep(), ME, NOW);
  const x = authorizationDisclosures(decoded, { '0x2222222222222222222222222222222222222222': '20000000' });
  assert.deepEqual([x.priceLimit.kind, x.priceLimit.isSlippageProtection, x.priceLimit.catchUp, x.priceLimit.mayEndBeforeAllRuns], ['FIXED_MAX_PRICE_PER_ASSET', false, false, true]);
  assert.deepEqual(x.priceLimit.assets.map(a => [a.symbol, a.maxPriceRaw, a.marketPriceRaw, a.headroomBps]), [['GME', 25000000n, 20000000n, 2500]]);
  assert.match(x.priceLimit.text.join(' '), /kayma \(slippage\) koruması DEĞİLDİR/);
  assert.match(x.priceLimit.text.join(' '), /telafi edilmez/);
  assert.deepEqual([x.dependency.composer, x.dependency.canExceedSignedLimits, x.dependency.canStopOrDelayPurchases], ['NOT_USED', false, true]);
  assert.match(x.dependency.limits.join(' '), /AŞAMAZ/);
  assert.match(x.dependency.availability.join(' '), /BAĞIMLISIN/);
  assert.equal(authorizationDisclosures(decoded).priceLimit.assets[0].marketPriceRaw, null, 'no market price: shown as unknown, never invented');
});
