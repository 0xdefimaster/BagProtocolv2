import { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import { PriceProvider } from '@/lib/domain/basket-protocol/pricing';
import { PositionAssetInput, PositionValue, effectiveQuantityRaw, valuePosition } from '@/lib/domain/basket-protocol/accounting/position-value';
import { RedeemHoldingInput } from '@/lib/domain/basket-protocol/redeem/allocation';
import { readBalancesAtBlock } from '@/lib/server/wallet-balances';
import { ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Accounting V2 / A4 — the I/O side of holdings-based position value
// (accounting/position-value.ts is the pure side).
//
// Reads, for one user: every tracked holding across all of their strategies
// (the attribution denominator), the wallet's balance of each of those assets
// at ONE block, and — for display only — a verified price per asset. Balances
// that cannot be read are null (fail-closed: never a guessed zero, never a
// guessed "still there"); the sell path refuses to quote until they can be read.
// -----------------------------------------------------------------------------

/** Balances are read on the chain BAG executes on; anything else is reported unreadable. */
const OBSERVED_CHAIN = 'robinhood';

interface HoldingRow {
  bagId: string;
  chain: string;
  address: string;
  decimals: number;
  quantityRaw: string;
}

export interface ObservedHoldings {
  blockNumber: string | null;
  /** Every non-zero tracked holding of the user, all strategies. */
  rows: HoldingRow[];
  /** asset key → tracked across all strategies. */
  trackedAll: Map<string, bigint>;
  /** asset key → wallet balance at `blockNumber`, null when unreadable. */
  observed: Map<string, bigint | null>;
}

export const assetKey = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

async function listUserHoldings(admin: SupabaseClient, userId: string): Promise<HoldingRow[]> {
  const { data, error } = await admin.from('bag_investor_holdings').select('bag_id, chain, address, decimals, quantity_raw').eq('user_id', userId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { bag_id: string; chain: string; address: string; decimals: number; quantity_raw: string }[])
    .filter((r) => /^\d+$/.test(r.quantity_raw) && BigInt(r.quantity_raw) > BigInt(0))
    .map((r) => ({ bagId: r.bag_id, chain: r.chain, address: r.address, decimals: r.decimals, quantityRaw: r.quantity_raw }));
}

export async function observeUserHoldings(admin: SupabaseClient, client: PublicClient, user: { userId: string; walletAddress: string }): Promise<ObservedHoldings> {
  const rows = await listUserHoldings(admin, user.userId);
  const trackedAll = new Map<string, bigint>();
  const assets = new Map<string, { chain: string; address: string; decimals: number }>();
  for (const r of rows) {
    const k = assetKey(r.chain, r.address);
    trackedAll.set(k, (trackedAll.get(k) ?? BigInt(0)) + BigInt(r.quantityRaw));
    assets.set(k, { chain: r.chain, address: r.address, decimals: r.decimals });
  }

  const observed = new Map<string, bigint | null>([...assets.keys()].map((k) => [k, null]));
  const readable = [...assets.entries()].filter(([, a]) => a.chain === OBSERVED_CHAIN && /^0x[0-9a-fA-F]{40}$/.test(a.address));
  let blockNumber: string | null = null;
  if (readable.length > 0) {
    try {
      const block = await client.getBlockNumber();
      const balances = await readBalancesAtBlock(client, user.walletAddress, readable.map(([, a]) => a), block);
      readable.forEach(([k], i) => observed.set(k, balances[i]));
      blockNumber = block.toString();
    } catch {
      // No block, no balances: every asset stays unreadable.
    }
  }
  return { blockNumber, rows, trackedAll, observed };
}

/** What a redemption of `bagId` may sell, per asset; null when any held asset's balance could not be read. */
export function sellableHoldingsForBag(observed: ObservedHoldings, bagId: string): RedeemHoldingInput[] | null {
  const out: RedeemHoldingInput[] = [];
  for (const r of observed.rows.filter((x) => x.bagId === bagId)) {
    const k = assetKey(r.chain, r.address);
    const balance = observed.observed.get(k) ?? null;
    if (balance === null) return null;
    const tracked = BigInt(r.quantityRaw);
    out.push({
      chain: r.chain as ChainId,
      address: r.address,
      decimals: r.decimals,
      quantityRaw: r.quantityRaw,
      // D3.1 (accounting/position-value.ts): a sale may take all this strategy tracks that the wallet holds.
      sellableRaw: (balance < tracked ? balance : tracked).toString(),
    });
  }
  return out;
}

/** Display prices, one lookup per asset; a refused price is null, never a fallback. */
async function pricesFor(priceProvider: PriceProvider, rows: HoldingRow[]): Promise<Map<string, string | null>> {
  const unique = new Map(rows.map((r) => [assetKey(r.chain, r.address), r]));
  const entries = await Promise.all(
    [...unique.entries()].map(async ([k, r]) => {
      try {
        const p = await priceProvider.getPrice({ chain: r.chain as ChainId, address: r.address });
        return [k, /^\d+(\.\d+)?$/.test(p.price) ? p.price : null] as const;
      } catch {
        return [k, null] as const;
      }
    })
  );
  return new Map(entries);
}

export interface StrategyPositionValue extends PositionValue {
  bagId: string;
  blockNumber: string | null;
}

/** Holdings-based value of each of the user's strategies (bag id → value). */
export async function valueUserPositions(
  admin: SupabaseClient,
  client: PublicClient,
  priceProvider: PriceProvider,
  user: { userId: string; walletAddress: string },
  symbolFor: (chain: string, address: string) => string | undefined = () => undefined
): Promise<Map<string, StrategyPositionValue>> {
  const observed = await observeUserHoldings(admin, client, user);
  const prices = await pricesFor(priceProvider, observed.rows);
  const byBag = new Map<string, PositionAssetInput[]>();
  for (const r of observed.rows) {
    const k = assetKey(r.chain, r.address);
    const balance = observed.observed.get(k) ?? null;
    const list = byBag.get(r.bagId) ?? [];
    list.push({
      chain: r.chain,
      address: r.address,
      decimals: r.decimals,
      symbol: symbolFor(r.chain, r.address),
      trackedRaw: r.quantityRaw,
      trackedAllStrategiesRaw: (observed.trackedAll.get(k) ?? BigInt(r.quantityRaw)).toString(),
      observedRaw: balance === null ? null : balance.toString(),
      price: prices.get(k) ?? null,
    });
    byBag.set(r.bagId, list);
  }
  return new Map([...byBag.entries()].map(([bagId, inputs]) => [bagId, { bagId, blockNumber: observed.blockNumber, ...valuePosition(inputs) }]));
}
