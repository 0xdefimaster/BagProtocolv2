/** App experiment only. A schedule is not an execution permission. Amounts are USDG units. */
export const DCA_INTERVALS = { minutes: 60, hours: 3600, days: 86400, weeks: 604800 } as const;
export interface DcaSettings { budget: string; amount: string; interval: string; unit: keyof typeof DCA_INTERVALS }
export interface DcaPlan {
  version: 1; budgetRaw: string; amountRaw: string; remainderRaw: string;
  purchases: number; intervalSeconds: number; firstAt: string; lastAt: string;
}
export class DcaPlanError extends Error {}
export function usdgRaw(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(value)) throw new DcaPlanError('Enter a USDG amount with up to six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, '0'));
}
export function displayUsdg(raw: string): string {
  const value = BigInt(raw), fraction = (value % BigInt(1_000_000)).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / BigInt(1_000_000)}${fraction ? `.${fraction}` : ''}`;
}
export function buildDcaPlan(input: DcaSettings, now = Date.now()): DcaPlan {
  if (!input || typeof input !== 'object') throw new DcaPlanError('Choose a budget, purchase amount and interval.');
  const budget = usdgRaw(input.budget), amount = usdgRaw(input.amount);
  if (amount < BigInt(1_000_000)) throw new DcaPlanError('Each trial purchase must be at least 1 USDG.');
  if (budget > BigInt(1_000_000_000)) throw new DcaPlanError('The local trial supports a budget of up to 1,000 USDG.');
  if (budget < amount) throw new DcaPlanError('The budget must cover at least one complete purchase.');
  const purchases = Number(budget / amount);
  if (purchases > 20) throw new DcaPlanError('The local trial supports up to 20 purchases. Increase the purchase amount.');
  if (typeof input.interval !== 'string' || !/^[1-9]\d{0,2}$/.test(input.interval) || Number(input.interval) > 365 || !Object.hasOwn(DCA_INTERVALS, input.unit)) throw new DcaPlanError('Choose an interval from 1 to 365 minutes, hours, days or weeks.');
  const intervalSeconds = Number(input.interval) * DCA_INTERVALS[input.unit];
  const last = now + purchases * intervalSeconds * 1000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(last)) throw new DcaPlanError('The schedule is outside the supported date range.');
  return { version: 1, budgetRaw: budget.toString(), amountRaw: amount.toString(), remainderRaw: (budget % amount).toString(), purchases, intervalSeconds,
    firstAt: new Date(now + intervalSeconds * 1000).toISOString(), lastAt: new Date(last).toISOString() };
}
