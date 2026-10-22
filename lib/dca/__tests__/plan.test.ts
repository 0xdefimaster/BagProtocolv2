import { describe, it, expect } from 'vitest';
import { buildDcaPlan, displayUsdg, usdgRaw } from '../plan';
const settings = { budget: '105', amount: '10', interval: '1', unit: 'days' as const };
describe('DCA local plan', () => {
  it('uses whole purchases, exact decimal units and an untouched remainder', () => {
    const plan = buildDcaPlan(settings, Date.UTC(2026, 9, 23));
    expect(plan).toMatchObject({ budgetRaw: '105000000', amountRaw: '10000000', purchases: 10, remainderRaw: '5000000', intervalSeconds: 86400 });
    expect(plan.firstAt).toBe('2026-10-24T00:00:00.000Z'); expect(plan.lastAt).toBe('2026-11-02T00:00:00.000Z');
  });
  it('does not round six-decimal amounts through floating point', () => {
    expect(usdgRaw('1.000001')).toBe(BigInt(1000001)); expect(displayUsdg('1000001')).toBe('1.000001');
    expect(buildDcaPlan({ ...settings, budget: '3.000004', amount: '1.000001' }).remainderRaw).toBe('1');
  });
  it.each(['0', '-1', '1e3', 'Infinity', '0x10', '1.0000001', ' 10', '01'])('rejects invalid purchase amount %s', amount => expect(() => buildDcaPlan({ ...settings, amount })).toThrow());
  it('rejects insufficient and oversized budgets', () => {
    expect(() => buildDcaPlan({ ...settings, budget: '9' })).toThrow('cover');
    expect(() => buildDcaPlan({ ...settings, budget: '1000.000001' })).toThrow('1,000');
    expect(() => buildDcaPlan({ ...settings, budget: '210' })).toThrow('20 purchases');
  });
  it.each(['0', '-1', '1.1', '366', '1e2'])('rejects invalid interval %s', interval => expect(() => buildDcaPlan({ ...settings, interval })).toThrow());
  it('rejects unknown and inherited interval names', () => {
    for (const unit of ['months', 'constructor', '__proto__']) expect(() => buildDcaPlan({ ...settings, unit: unit as 'days' })).toThrow();
  });
  it('converts each supported interval explicitly', () => {
    for (const [unit, seconds] of Object.entries({ minutes: 60, hours: 3600, days: 86400, weeks: 604800 })) expect(buildDcaPlan({ ...settings, interval: '2', unit: unit as 'days' }).intervalSeconds).toBe(seconds * 2);
  });
});
