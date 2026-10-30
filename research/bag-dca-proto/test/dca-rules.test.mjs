import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildDcaPlan, parseTokenAmount, formatTokenAmount, parsePeriod, planCaveatSpec, decodeDelegationTypedData, compareDelegationToPlan,
  decodeUserOpTypedData, TOTAL_MISMATCH_MESSAGE, DcaRuleError } from '../lib/dca-rules.mjs';
const v = createRequire(import.meta.url)('viem');

const USDG = { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6, verifiedOnChain: true };
const A = '0x' + '1'.repeat(40), P = '0x' + '2'.repeat(40), SA = '0x' + '3'.repeat(40);
const base = { bag: { definitionHash: '0x' + 'a'.repeat(64), strategyId: 's', version: 1, chainId: 4663 }, token: USDG, amountPerRun: '5', runs: 5,
  period: { count: 1, unit: 'day' }, start: { mode: 'now' }, now: 1_800_000_000, owner: A, fundingAccount: SA, recipient: A };
const code = fn => { try { fn(); return 'OK'; } catch (e) { assert(e instanceof DcaRuleError, String(e)); return e.code; } };

test('5 x 5 USDG = 25 USDG is valid; total is derived, not entered', () => {
  const p = buildDcaPlan(base);
  assert.equal(p.perRunRaw, 5_000_000n); assert.equal(p.totalRaw, 25_000_000n); assert.equal(formatTokenAmount(p.totalRaw, 6), '25');
  assert.equal(code(() => buildDcaPlan({ ...base, totalAmount: '25' })), 'OK');
  assert.equal(code(() => buildDcaPlan({ ...base, totalAmount: '25.000000' })), 'OK');
});

test('a total of 30 for 5 x 5 is rejected with the exact message, nothing is auto-corrected', () => {
  try { buildDcaPlan({ ...base, totalAmount: '30' }); assert.fail('accepted'); }
  catch (e) { assert.equal(e.code, 'TOTAL_MISMATCH'); assert.equal(e.message, TOTAL_MISMATCH_MESSAGE); assert.equal(e.field, 'totalAmount'); }
  assert.equal(TOTAL_MISMATCH_MESSAGE, 'Toplam tutar, alım sayısı × alım tutarıyla eşleşmiyor');
});

test('amount parsing: no floats, exact decimals, rejects zero/negative/exponent/comma/too many decimals/overflow', () => {
  assert.equal(parseTokenAmount('0.000001', 6), 1n); assert.equal(parseTokenAmount(' 12.5 ', 6), 12_500_000n);
  assert.equal(parseTokenAmount('0.1', 6) + parseTokenAmount('0.2', 6), parseTokenAmount('0.3', 6)); // float would fail
  for (const [s, c] of [['0', 'ZERO_AMOUNT'], ['0.000000', 'ZERO_AMOUNT'], ['-1', 'AMOUNT_FORMAT'], ['1e3', 'AMOUNT_FORMAT'], ['5,5', 'AMOUNT_FORMAT'],
    ['', 'AMOUNT_FORMAT'], ['.5', 'AMOUNT_FORMAT'], ['5.', 'AMOUNT_FORMAT'], ['5.1234567', 'TOO_MANY_DECIMALS'], ['1000000000001', 'AMOUNT_TOO_LARGE']])
    assert.equal(code(() => parseTokenAmount(s, 6)), c, s);
  assert.equal(code(() => parseTokenAmount(5, 6)), 'AMOUNT_NOT_TEXT');
});

test('period: units to seconds; invalid units and counts are rejected', () => {
  assert.equal(parsePeriod({ count: 1, unit: 'day' }), 86400n); assert.equal(parsePeriod({ count: 2, unit: 'week' }), 1_209_600n);
  assert.equal(code(() => parsePeriod({ count: 0, unit: 'day' })), 'PERIOD_COUNT'); assert.equal(code(() => parsePeriod({ count: 1.5, unit: 'day' })), 'PERIOD_COUNT');
  assert.equal(code(() => parsePeriod({ count: 1, unit: 'month' })), 'PERIOD_UNIT'); assert.equal(code(() => parsePeriod({ count: 53, unit: 'week' })), 'PERIOD_TOO_LONG');
});

test('start: now = immediate first purchase; a future time = AT_START; the past is rejected', () => {
  assert.equal(buildDcaPlan(base).firstPurchase, 'IMMEDIATE');
  const p = buildDcaPlan({ ...base, start: { mode: 'at', at: 1_800_003_600 } });
  assert.equal(p.firstPurchase, 'AT_START'); assert.equal(p.startTime, 1_800_003_600n); assert.equal(p.expiry, 1_800_003_600n + 5n * 86400n);
  assert.equal(code(() => buildDcaPlan({ ...base, start: { mode: 'at', at: 1_799_999_999 } })), 'START_IN_PAST');
  assert.equal(code(() => buildDcaPlan({ ...base, start: {} })), 'START_MODE');
});

test('fixed calendar windows, no accumulation, readable summary with exact UTC dates', () => {
  const p = buildDcaPlan(base);
  assert.equal(p.windows.length, 5); assert.equal(p.windows[0].opensAt, 1_800_000_000n); assert.equal(p.windows[1].opensAt - p.windows[0].opensAt, 86400n);
  assert.equal(p.windows[4].closesAt + 1n, p.expiry); assert.equal(p.missedWindowPolicy, 'NO_ACCUMULATION');
  assert.match(p.summary.tr.join('\n'), /5 alım × 5 USDG = toplam 25 USDG/); assert.match(p.summary.tr.join('\n'), /kayan 24 saat sınırı değil/);
  assert.equal(p.summary.startUtc, '2027-01-15T08:00:00Z');
});

test('token, BAG and addresses must be verified/valid', () => {
  assert.equal(code(() => buildDcaPlan({ ...base, token: { ...USDG, verifiedOnChain: false } })), 'TOKEN_UNVERIFIED');
  assert.equal(code(() => buildDcaPlan({ ...base, token: { ...USDG, decimals: 18 } })), 'TOKEN_UNVERIFIED');
  assert.equal(code(() => buildDcaPlan({ ...base, bag: { ...base.bag, chainId: 1 } })), 'BAG_CHAIN');
  assert.equal(code(() => buildDcaPlan({ ...base, bag: { ...base.bag, definitionHash: '0x12' } })), 'BAG_HASH');
  assert.equal(code(() => buildDcaPlan({ ...base, recipient: '0x12' })), 'ADDRESS');
  assert.equal(code(() => buildDcaPlan({ ...base, runs: 0 })), 'RUNS'); assert.equal(code(() => buildDcaPlan({ ...base, runs: 21 })), 'RUNS');
  assert.equal(code(() => buildDcaPlan({ ...base, amountPerRun: '0.5' })), 'AMOUNT_BELOW_MIN');
});

// ---- typed data decoding --------------------------------------------------------------------
const ENF = { ERC20PeriodTransferEnforcer: '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB', ERC20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
  LimitedCallsEnforcer: '0x04658B29F6b82ed55274221a06Fc97D318E25416', TimestampEnforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069',
  RedeemerEnforcer: '0xE144b0b2618071B4E56f746313528a669c7E65c5', AllowedCalldataEnforcer: '0xc2b0d624c1c4319760C96503BA27C347F3260f55' };
const DM = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
function typedFor(spec, over = {}) {
  const caveats = [
    { enforcer: ENF.ERC20PeriodTransferEnforcer, terms: v.encodePacked(['address', 'uint256', 'uint256', 'uint256'], [spec.token, spec.periodAmount, spec.periodSeconds, spec.periodStart]), args: '0x' },
    { enforcer: ENF.ERC20TransferAmountEnforcer, terms: v.encodePacked(['address', 'uint256'], [spec.token, spec.totalAmount]), args: '0x' },
    { enforcer: ENF.LimitedCallsEnforcer, terms: v.encodePacked(['uint256'], [spec.maxCalls]), args: '0x' },
    { enforcer: ENF.TimestampEnforcer, terms: v.encodePacked(['uint128', 'uint128'], [spec.notBefore, spec.notAfter]), args: '0x' },
    { enforcer: ENF.RedeemerEnforcer, terms: spec.redeemer, args: '0x' },
    { enforcer: ENF.AllowedCalldataEnforcer, terms: v.concat([v.toHex(4n, { size: 32 }), v.pad(spec.transferRecipient, { size: 32 })]), args: '0x' }, ...(over.extra ?? [])];
  return { primaryType: 'Delegation', domain: { name: 'DelegationManager', version: '1', chainId: 4663, verifyingContract: DM },
    message: { delegate: over.delegate ?? spec.redeemer, delegator: SA, authority: '0x' + 'f'.repeat(64), caveats: over.caveats?.(caveats) ?? caveats, salt: 1n } };
}

test('delegation typed data decodes to exactly the plan; any change is reported', () => {
  const plan = buildDcaPlan(base), spec = planCaveatSpec(plan, P);
  const ok = decodeDelegationTypedData(typedFor(spec), ENF);
  assert.deepEqual(ok.errors, []); assert.deepEqual(compareDelegationToPlan(ok.decoded, spec, { delegationManager: DM, delegator: SA }), []);
  const more = decodeDelegationTypedData(typedFor({ ...spec, periodAmount: spec.periodAmount + 1n }), ENF);
  assert.match(compareDelegationToPlan(more.decoded, spec, { delegationManager: DM, delegator: SA }).join(';'), /period.amount/);
  const elsewhere = decodeDelegationTypedData(typedFor({ ...spec, transferRecipient: A }), ENF);
  assert.match(compareDelegationToPlan(elsewhere.decoded, spec, { delegationManager: DM, delegator: SA }).join(';'), /transfer recipient/);
  const otherDelegate = decodeDelegationTypedData(typedFor(spec, { delegate: A }), ENF);
  assert.match(compareDelegationToPlan(otherDelegate.decoded, spec, { delegationManager: DM, delegator: SA }).join(';'), /delegate/);
  assert.match(decodeDelegationTypedData(typedFor(spec, { extra: [{ enforcer: A, terms: '0x', args: '0x' }] }), ENF).errors.join(';'), /unknown enforcer/);
  assert.match(decodeDelegationTypedData(typedFor(spec, { caveats: c => c.slice(1) }), ENF).errors.join(';'), /missing caveat ERC20PeriodTransferEnforcer/);
  assert.match(decodeDelegationTypedData(typedFor(spec, { caveats: c => c.map((x, i) => (i === 2 ? { ...x, args: '0x01' } : x)) }), ENF).errors.join(';'), /carries args/);
});

test('userOp typed data: inner transfer, paymaster binding and window are decoded', () => {
  const inner = v.encodeFunctionData({ abi: v.parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [A, 7n] });
  const callData = v.encodeFunctionData({ abi: v.parseAbi(['function execute((address target,uint256 value,bytes callData))']), functionName: 'execute', args: [{ target: USDG.address, value: 0n, callData: inner }] });
  const PM = '0x03fd2c77d32302eeF2f6F3063DbB7b899b1116D3';
  const pmd = v.concat([PM, v.toHex(100000n, { size: 16 }), v.toHex(0n, { size: 16 }), v.toHex(1_800_007_200n, { size: 6 }), v.toHex(0n, { size: 6 })]);
  const { decoded, errors } = decodeUserOpTypedData({ primaryType: 'PackedUserOperation', domain: { name: 'MultiSigDeleGator', chainId: 4663, verifyingContract: SA },
    message: { sender: SA, nonce: 0n, callData, paymasterAndData: pmd, accountGasLimits: v.concat([v.toHex(500000n, { size: 16 }), v.toHex(400000n, { size: 16 })]), gasFees: v.concat([v.toHex(1n, { size: 16 }), v.toHex(2n, { size: 16 })]), preVerificationGas: 100000n, entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' } });
  assert.deepEqual(errors, []); assert.equal(decoded.call.target.toLowerCase(), USDG.address.toLowerCase()); assert.equal(decoded.call.transfer.to, A); assert.equal(decoded.call.transfer.amount, 7n);
  assert.equal(decoded.paymaster.address, PM.toLowerCase()); assert.equal(decoded.paymaster.validUntil, 1_800_007_200n); assert.equal(decoded.gas.callGasLimit, 400000n);
  assert.match(decodeUserOpTypedData({ primaryType: 'PackedUserOperation', domain: {}, message: { callData, paymasterAndData: '0x' } }).errors.join(';'), /paymasterAndData has 0 bytes/);
});
