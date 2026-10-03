import type { SupabaseClient } from '@supabase/supabase-js';
import { erc20Abi, formatUnits, parseUnits, type PublicClient } from 'viem';
import { CanonicalAsset } from '@/types/basket-protocol';
import { ComposerFallbackNotice, MAX_ACCEPTABLE_PRICE_IMPACT_BPS, PRICE_IMPACT_ACCEPT_BUFFER_BPS } from '@/types/purchase-intent';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import { listAssets } from '@/lib/server/asset-repo';
import { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';
import { buildComposerSweep, sweepNodeId } from '@/lib/blockchain/lifi-composer-adapter';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS, parseComposerFallback } from '@/lib/blockchain/lifi-purchase-quote';

// -----------------------------------------------------------------------------
// The connected wallet's own tokens on Robinhood Chain, and selling any of
// them to USDG in one transaction (a "dust sweeper").
//
// Balances come straight from the chain: `balanceOf` on every VERIFIED
// registry asset (the same list Create/Invest use), through the app's own
// RPC client. Multicall3 is used only if its canonical contract is actually
// deployed here (checked with eth_getCode), otherwise one call per token.
// USD values use the display price provider (lib/server/price-provider.ts);
// a token without a price shows `usdValue: null`, never a guess.
//
// Selling never touches Bag accounting: it is a plain swap of the wallet's
// own tokens, compiled by LI.FI Composer and signed by the user.
// -----------------------------------------------------------------------------

/** Canonical Multicall3 address (same on every chain where it is deployed). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
/** Most tokens one sweep may sell — keeps the Composer program and its approvals reasonable. */
export const MAX_SWEEP_TOKENS = 12;
const BALANCE_CONCURRENCY = 16;

export interface WalletTokenBalance {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  assetType: string;
  logoUrl: string | null;
  balanceRaw: string;
  balance: string;
  /** Decimal string; null when no price is available right now. */
  priceUsd: string | null;
  usdValue: string | null;
  /** False for the settlement token itself (USDG): that is what everything is sold into. */
  sellable: boolean;
}

export interface WalletHoldings {
  walletAddress: string;
  chainId: number;
  nativeBalance: string;
  tokens: WalletTokenBalance[];
  outputToken: { address: string; symbol: string; decimals: number };
}

async function readBalances(client: PublicClient, owner: `0x${string}`, assets: CanonicalAsset[]): Promise<bigint[]> {
  const code = await client.getCode({ address: MULTICALL3_ADDRESS }).catch(() => undefined);
  if (code && code !== '0x') {
    const results = await client.multicall({
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      contracts: assets.map((a) => ({ address: a.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner] as const })),
    });
    return results.map((r) => (r.status === 'success' ? (r.result as bigint) : BigInt(0)));
  }
  const out: bigint[] = new Array(assets.length).fill(BigInt(0));
  for (let start = 0; start < assets.length; start += BALANCE_CONCURRENCY) {
    const chunk = assets.slice(start, start + BALANCE_CONCURRENCY);
    const values = await Promise.all(
      chunk.map((a) =>
        client.readContract({ address: a.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }).catch(() => BigInt(0))
      )
    );
    values.forEach((v, i) => (out[start + i] = v));
  }
  return out;
}

/** balance × price in exact integer math (18-decimal price), rounded down to cents. */
export function usdValueOf(balanceRaw: bigint, decimals: number, priceUsd: string): string {
  const [whole, fraction = ''] = priceUsd.split('.');
  const value = (balanceRaw * parseUnits(fraction ? `${whole}.${fraction.slice(0, 18)}` : whole, 18)) / BigInt(10) ** BigInt(decimals);
  const cents = value / BigInt(10) ** BigInt(16);
  return formatUnits(cents, 2);
}

export async function getWalletHoldings(
  admin: SupabaseClient,
  client: PublicClient,
  priceProvider: PriceProvider,
  walletAddress: string
): Promise<WalletHoldings> {
  const owner = walletAddress as `0x${string}`;
  const assets = (await listAssets(admin, { chain: 'robinhood', status: 'VERIFIED' })).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address));
  const [balances, native] = await Promise.all([readBalances(client, owner, assets), client.getBalance({ address: owner })]);

  const held = assets.map((asset, i) => ({ asset, raw: balances[i] })).filter((h) => h.raw > BigInt(0));
  const output = ROBINHOOD_REWARD_TOKEN.address.toLowerCase();
  const tokens = await Promise.all(
    held.map(async ({ asset, raw }): Promise<WalletTokenBalance> => {
      const balance = formatUnits(raw, asset.decimals);
      let priceUsd: string | null = null;
      let usdValue: string | null = null;
      try {
        priceUsd = (await priceProvider.getPrice({ chain: 'robinhood', address: asset.address })).price;
        usdValue = usdValueOf(raw, asset.decimals, priceUsd);
      } catch {
        priceUsd = null;
        usdValue = null;
      }
      return {
        address: asset.address,
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        assetType: asset.assetType,
        logoUrl: asset.logoUrl ?? null,
        balanceRaw: raw.toString(),
        balance,
        priceUsd,
        usdValue,
        sellable: asset.address.toLowerCase() !== output,
      };
    })
  );
  tokens.sort((a, b) => Number(b.usdValue ?? -1) - Number(a.usdValue ?? -1));

  return {
    walletAddress,
    chainId: ROBINHOOD_CHAIN_ID,
    nativeBalance: formatUnits(native, 18),
    tokens,
    outputToken: { address: ROBINHOOD_REWARD_TOKEN.address, symbol: ROBINHOOD_REWARD_TOKEN.symbol, decimals: ROBINHOOD_REWARD_TOKEN.decimals },
  };
}

export interface SweepQuoteRequest {
  tokens: { address: string; amountRaw: string }[];
  acceptedPriceImpactBps?: number;
}

export interface SweepQuoteLeg {
  address: string;
  symbol: string;
  amountRaw: string;
  decimals: number;
  expectedOutRaw: string | null;
  minOutRaw: string | null;
}

export type SweepQuoteResult =
  | {
      ok: true;
      transaction: { to: string; data: string; value: string; chainId: number };
      approvals: { token: string; spender: string; amountRaw: string }[];
      legs: SweepQuoteLeg[];
      outputToken: { address: string; symbol: string; decimals: number };
      /** Sums of the per-swap simulated / on-chain-enforced minimum outputs; null if any leg lacks one. */
      expectedOutRaw: string | null;
      minOutRaw: string | null;
      priceImpactBps: number | null;
    }
  | { ok: false; status: number; error: string; composerFallback?: ComposerFallbackNotice };

function sumOrNull(values: (string | null)[]): string | null {
  if (values.some((v) => v === null)) return null;
  return values.reduce((sum, v) => sum + BigInt(v as string), BigInt(0)).toString();
}

export async function quoteWalletSweep(
  admin: SupabaseClient,
  client: PublicClient,
  walletAddress: string,
  request: SweepQuoteRequest,
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch }
): Promise<SweepQuoteResult> {
  if (!options.apiKey) return { ok: false, status: 503, error: 'Selling is not configured on this deployment (LIFI_API_KEY).' };
  if (!Array.isArray(request.tokens) || request.tokens.length === 0) return { ok: false, status: 400, error: 'Pick at least one token to sell.' };
  if (request.tokens.length > MAX_SWEEP_TOKENS) return { ok: false, status: 400, error: `At most ${MAX_SWEEP_TOKENS} tokens per sale.` };
  if (request.acceptedPriceImpactBps !== undefined && !(Number.isInteger(request.acceptedPriceImpactBps) && request.acceptedPriceImpactBps >= 0 && request.acceptedPriceImpactBps <= MAX_ACCEPTABLE_PRICE_IMPACT_BPS)) {
    return { ok: false, status: 400, error: `Price impact above ${MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% cannot be accepted.` };
  }

  // Only registry tokens, never the output token, each at most what the wallet holds right now.
  const registry = new Map(
    (await listAssets(admin, { chain: 'robinhood', status: 'VERIFIED' })).map((a) => [a.address.toLowerCase(), a] as const)
  );
  const output = ROBINHOOD_REWARD_TOKEN.address.toLowerCase();
  const seen = new Set<string>();
  const picked: { asset: CanonicalAsset; amountRaw: string }[] = [];
  for (const t of request.tokens) {
    const address = typeof t?.address === 'string' ? t.address.toLowerCase() : '';
    const asset = registry.get(address);
    if (!asset) return { ok: false, status: 400, error: `Unknown token ${String(t?.address)}.` };
    if (address === output) return { ok: false, status: 400, error: `${asset.symbol} is what you receive; it cannot be sold here.` };
    if (seen.has(address)) return { ok: false, status: 400, error: `${asset.symbol} is listed twice.` };
    if (typeof t.amountRaw !== 'string' || !/^\d+$/.test(t.amountRaw) || BigInt(t.amountRaw) <= BigInt(0)) {
      return { ok: false, status: 400, error: `${asset.symbol}: invalid amount.` };
    }
    seen.add(address);
    picked.push({ asset, amountRaw: t.amountRaw });
  }
  const balances = await Promise.all(
    picked.map((p) =>
      client.readContract({ address: p.asset.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress as `0x${string}`] })
    )
  );
  for (let i = 0; i < picked.length; i++) {
    if (BigInt(picked[i].amountRaw) > balances[i]) return { ok: false, status: 400, error: `Not enough ${picked[i].asset.symbol} in your wallet.` };
  }

  const maxPriceImpactBps =
    request.acceptedPriceImpactBps !== undefined
      ? Math.min(request.acceptedPriceImpactBps + PRICE_IMPACT_ACCEPT_BUFFER_BPS, MAX_ACCEPTABLE_PRICE_IMPACT_BPS)
      : undefined;

  let compiled;
  try {
    compiled = await buildComposerSweep({
      chain: 'robinhood',
      inputs: picked.map((p) => ({ address: p.asset.address, amountRaw: p.amountRaw, symbol: p.asset.symbol })),
      outputTokenAddress: ROBINHOOD_REWARD_TOKEN.address,
      signerAddress: walletAddress,
      slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      ...(maxPriceImpactBps !== undefined ? { maxPriceImpactBps } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notice = parseComposerFallback(message);
    if (notice.reason === 'PRICE_IMPACT') {
      return { ok: false, status: 422, error: 'The price impact of this sale is above the limit.', composerFallback: notice };
    }
    return { ok: false, status: 502, error: `No route to sell these tokens right now: ${message}` };
  }

  const legs: SweepQuoteLeg[] = picked.map((p, i) => {
    const produced = compiled.producedResources[`${sweepNodeId(i)}.amountOut`];
    const out = produced?.simulated?.amountOut;
    const min = produced?.simulated?.amountOutMin;
    return {
      address: p.asset.address,
      symbol: p.asset.symbol,
      amountRaw: p.amountRaw,
      decimals: p.asset.decimals,
      expectedOutRaw: out !== undefined && out !== null ? String(out) : null,
      minOutRaw: min !== undefined && min !== null ? String(min) : null,
    };
  });

  return {
    ok: true,
    transaction: {
      to: compiled.transactionRequest.to,
      data: compiled.transactionRequest.data,
      value: compiled.transactionRequest.value,
      chainId: compiled.transactionRequest.chainId ?? ROBINHOOD_CHAIN_ID,
    },
    approvals: compiled.approvals,
    legs,
    outputToken: { address: ROBINHOOD_REWARD_TOKEN.address, symbol: ROBINHOOD_REWARD_TOKEN.symbol, decimals: ROBINHOOD_REWARD_TOKEN.decimals },
    expectedOutRaw: sumOrNull(legs.map((l) => l.expectedOutRaw)),
    minOutRaw: sumOrNull(legs.map((l) => l.minOutRaw)),
    priceImpactBps: compiled.priceImpact?.impactBps ?? null,
  };
}
