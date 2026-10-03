import { SupabaseClient } from '@supabase/supabase-js';
import { formatDecimalStringUsd } from '@/lib/format';

// -----------------------------------------------------------------------------
// The signed-in user's real activity, from the `activities` rows the
// accounting RPCs write (apply_purchase_execution, apply_redeem_execution,
// fee/royalty settlement). Turned into readable lines with the Bag's name and,
// for a purchase, the payment amount actually recorded on the intent. Nothing
// is estimated: an amount is shown only when it is stored.
// -----------------------------------------------------------------------------

export interface UserActivityItem {
  id: string;
  /** Human-readable line, e.g. "Bought $4.00 of asdasdad". */
  action: string;
  /** ms since epoch. */
  timestamp: number;
  kind: 'PURCHASE' | 'PURCHASE_PARTIAL' | 'REDEEM' | 'REDEEM_PARTIAL' | 'FORK_ROYALTY' | 'PERFORMANCE_FEE' | 'OTHER';
  bagId: string | null;
}

interface ActivityRow {
  id: string;
  action: string;
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

function usd(amount: string): string | null {
  return AMOUNT_RE.test(amount) ? formatDecimalStringUsd(amount) : null;
}

interface Parsed {
  kind: UserActivityItem['kind'];
  bagId: string | null;
  intentId: string | null;
  amount: string | null;
}

/** `CODE:a:b` → typed parts. Unknown codes are kept as OTHER (never dropped silently, never invented). */
export function parseActivityAction(action: string): Parsed {
  const [code, a, b] = action.split(':');
  const id = (v: string | undefined) => (v && UUID_RE.test(v) ? v : null);
  switch (code) {
    case 'PURCHASE_EXECUTED':
      return { kind: 'PURCHASE', intentId: id(a), bagId: id(b), amount: null };
    case 'PURCHASE_PARTIALLY_RECONCILED':
      return { kind: 'PURCHASE_PARTIAL', intentId: id(a), bagId: id(b), amount: null };
    case 'REDEEM_EXECUTED':
      return { kind: 'REDEEM', intentId: id(a), bagId: id(b), amount: null };
    case 'REDEEM_PARTIAL_RECONCILED':
      return { kind: 'REDEEM_PARTIAL', intentId: id(a), bagId: id(b), amount: null };
    case 'FORK_ROYALTY_EARNED':
      return { kind: 'FORK_ROYALTY', intentId: null, bagId: id(b), amount: a && AMOUNT_RE.test(a) ? a : null };
    case 'PERFORMANCE_FEE_EARNED':
      return { kind: 'PERFORMANCE_FEE', intentId: null, bagId: id(b), amount: a && AMOUNT_RE.test(a) ? a : null };
    default:
      return { kind: 'OTHER', intentId: null, bagId: null, amount: null };
  }
}

const OTHER_LABEL: Record<string, string> = {
  BOX_OPENED: 'Opened a box',
  NFT_ASSEMBLED: 'Assembled an NFT',
  INVESTMENT_COMMITTED: 'Committed an investment',
};

export function describeActivity(row: { action: string }, p: Parsed, bagName: string | null, purchaseAmount: string | null): string {
  const bag = bagName ?? 'a Bag';
  switch (p.kind) {
    case 'PURCHASE': {
      const amt = purchaseAmount ? usd(purchaseAmount) : null;
      return amt ? `Bought ${amt} of ${bag}` : `Bought ${bag}`;
    }
    case 'PURCHASE_PARTIAL':
      return `Purchase of ${bag} partially filled`;
    case 'REDEEM':
      return `Redeemed from ${bag}`;
    case 'REDEEM_PARTIAL':
      return `Redemption from ${bag} partially filled`;
    case 'FORK_ROYALTY': {
      const amt = p.amount ? usd(p.amount) : null;
      return amt ? `Earned ${amt} fork royalty from ${bag}` : `Earned a fork royalty from ${bag}`;
    }
    case 'PERFORMANCE_FEE': {
      const amt = p.amount ? usd(p.amount) : null;
      return amt ? `Earned ${amt} performance fee from ${bag}` : `Earned a performance fee from ${bag}`;
    }
    default:
      return OTHER_LABEL[row.action.split(':')[0]] ?? 'Account activity';
  }
}

export async function loadUserActivity(admin: SupabaseClient, userId: string, limit = 30): Promise<UserActivityItem[]> {
  const { data, error } = await admin.from('activities').select('id,action,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ActivityRow[];
  const parsed = rows.map((r) => parseActivityAction(r.action));

  const bagIds = Array.from(new Set(parsed.map((p) => p.bagId).filter((v): v is string => !!v)));
  const purchaseIds = Array.from(new Set(parsed.filter((p) => p.kind === 'PURCHASE' && p.intentId).map((p) => p.intentId as string)));
  const [bags, purchases] = await Promise.all([
    bagIds.length ? admin.from('bags').select('id,name').in('id', bagIds) : Promise.resolve({ data: [], error: null }),
    // Only this user's own intents (the activity is theirs, but the scope is enforced anyway).
    purchaseIds.length ? admin.from('purchase_intents').select('id,deposit_amount').eq('user_id', userId).in('id', purchaseIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const nameById = new Map(((bags.data ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]));
  const amountById = new Map(((purchases.data ?? []) as { id: string; deposit_amount: string | null }[]).map((p) => [p.id, p.deposit_amount]));

  return rows.map((r, i) => {
    const p = parsed[i];
    const amount = p.intentId ? (amountById.get(p.intentId) ?? null) : null;
    return {
      id: r.id,
      action: describeActivity(r, p, p.bagId ? (nameById.get(p.bagId) ?? null) : null, amount && amount !== '0' ? amount : null),
      timestamp: Date.parse(r.created_at),
      kind: p.kind,
      bagId: p.bagId,
    };
  });
}
