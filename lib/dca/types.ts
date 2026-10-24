import type { DcaPlan } from './plan';
export interface DcaTrialState {
  id: string; state: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; plan: DcaPlan;
  completedChecks: number; completedPurchases: number; definitionHash: string;
  result?: { checks: { pass: number; fail: number }; finalUsdgRaw: string; reservedUsdgRaw: string; spentUsdgRaw: string; publicTransactions: number; received?: { token: string; symbol: string; amountRaw: string; decimals: number }[] };
  error?: string;
}
