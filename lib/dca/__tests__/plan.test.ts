import { describe, it, expect } from 'vitest';
import { buildDcaPlan, displayUsdg, usdgRaw } from '../plan';
const settings = { budget: '100', amount: '10', purchases: '10', interval: '1', unit: 'days' as const };
describe('DCA local plan', () => {
  it('uses the explicit purchase count and derives first and last dates', () => {
    const plan = buildDcaPlan(settings, Date.UTC(2026, 9, 23));
    expect(plan).toMatchObject({ budgetRaw: '100000000', amountRaw: '10000000', purchases: 10, remainderRaw: '0', intervalSeconds: 86400 });
    expect(plan.firstAt).toBe('2026-10-24T00:00:00.000Z'); expect(plan.lastAt).toBe('2026-11-02T00:00:00.000Z');
  });
  it('does not round six-decimal amounts through floating point', () => {
    expect(usdgRaw('1.000001')).toBe(BigInt(1000001)); expect(displayUsdg('1000001')).toBe('1.000001');
    expect(buildDcaPlan({ ...settings, budget: '3.000003', amount: '1.000001', purchases: '3' }).remainderRaw).toBe('0');
    expect(() => buildDcaPlan({ ...settings, budget: '3.000004', amount: '1.000001', purchases: '3' })).toThrow('3.000003 USDG');
  });
  it.each(['0', '-1', '1e3', 'Infinity', '0x10', '1.0000001', ' 10', '01'])('rejects invalid purchase amount %s', amount => expect(() => buildDcaPlan({ ...settings, amount })).toThrow());
  it('rejects insufficient and oversized budgets', () => {
    expect(() => buildDcaPlan({ ...settings, budget: '9' })).toThrow('cover');
    expect(() => buildDcaPlan({ ...settings, budget: '1000.000001' })).toThrow('1,000');
    expect(() => buildDcaPlan({ ...settings, budget: '210', purchases: '21' })).toThrow('1 to 20');
  });
  it('accepts five purchases of five USDG with a total of 25', () => {
    expect(buildDcaPlan({ ...settings, purchases: '5', amount: '5', budget: '25' }).purchases).toBe(5);
  });
  it.each(['24', '25.000001', '30'])('rejects a mismatched total of %s for five purchases of five', budget => {
    expect(() => buildDcaPlan({ ...settings, purchases: '5', amount: '5', budget })).toThrow('5 purchases × 5 USDG = 25 USDG');
  });
  it.each(['', '0', '-1', '1.5', '21', '01', '1e1', undefined, 5])('requires a valid explicit purchase count %s', purchases => {
    expect(() => buildDcaPlan({ ...settings, purchases: purchases as string })).toThrow('1 to 20');
  });
  it.each(['0', '-1', '1.1', '366', '1e2'])('rejects invalid interval %s', interval => expect(() => buildDcaPlan({ ...settings, interval })).toThrow());
  it('rejects unknown and inherited interval names', () => {
    for (const unit of ['months', 'constructor', '__proto__']) expect(() => buildDcaPlan({ ...settings, unit: unit as 'days' })).toThrow();
  });
  it('converts each supported interval explicitly', () => {
    for (const [unit, seconds] of Object.entries({ minutes: 60, hours: 3600, days: 86400, weeks: 604800 })) expect(buildDcaPlan({ ...settings, interval: '2', unit: unit as 'days' }).intervalSeconds).toBe(seconds * 2);
  });
});
