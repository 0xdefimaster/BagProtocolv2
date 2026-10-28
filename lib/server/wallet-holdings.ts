import type { SupabaseClient } from '@supabase/supabase-js';
import { erc20Abi, formatUnits, parseUnits, type PublicClient } from 'viem';
import { CanonicalAsset } from '@/types/basket-protocol';
import { ComposerFallbackNotice, MAX_ACCEPTABLE_PRICE_IMPACT_BPS, PRICE_IMPACT_ACCEPT_BUFFER_BPS } from '@/types/purchase-intent';
import { BAG_CHAINS, type BagChain } from '@/lib/config/chains';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';
import { listAssets } from '@/lib/server/asset-repo';
import { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';
import {
  buildComposerPurchase,
  buildComposerSweep,
  composerLegEnforcedMinOutputRaw,
  composerLegSimulatedOutputRaw,
  composerPortAmounts,
  sweepNodeId,
} from '@/lib/blockchain/lifi-composer-adapter';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS, composerFallbackFrom } from '@/lib/blockchain/lifi-purchase-quote';

// -----------------------------------------------------------------------------
// The connected wallet's own tokens on each BAG chain (Robinhood Chain,
// Ethereum, Arbitrum, Base), and selling any of them on that chain for its
// stablecoin (BAG_CHAINS[chain].sweepOutputToken: USDG on Robinhood Chain,
// USDC elsewhere) in one transaction (a "dust sweeper"). One chain per sale.
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
  chain: BagChain;
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
  walletAddress: string,
  chain: BagChain = 'robinhood'
): Promise<WalletHoldings> {
  const owner = walletAddress as `0x${string}`;
  const cfg = BAG_CHAINS[chain];
  const assets = (await listAssets(admin, { chain, status: 'VERIFIED' })).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address));
  const [balances, native] = await Promise.all([readBalances(client, owner, assets), client.getBalance({ address: owner })]);

  const held = assets.map((asset, i) => ({ asset, raw: balances[i] })).filter((h) => h.raw > BigInt(0));
  const output = cfg.sweepOutputToken.address.toLowerCase();
  const tokens = await Promise.all(
    held.map(async ({ asset, raw }): Promise<WalletTokenBalance> => {
      const balance = formatUnits(raw, asset.decimals);
      let priceUsd: string | null = null;
      let usdValue: string | null = null;
      try {
        priceUsd = (await priceProvider.getPrice({ chain, address: asset.address })).price;
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
    chain,
    chainId: cfg.chainId,
    nativeBalance: formatUnits(native, cfg.nativeCurrency.decimals),
    tokens,
    outputToken: { ...cfg.sweepOutputToken },
  };
}

export type ChainHoldingsResult = WalletHoldings | { chain: BagChain; chainId: number; error: string };

/** Every chain's holdings, read in parallel; a chain that cannot be read reports its error instead of failing the rest. */
export async function getWalletHoldingsAllChains(
  admin: SupabaseClient,
  clientFor: (chain: BagChain) => PublicClient,
  priceProvider: PriceProvider,
  walletAddress: string,
  chains: readonly BagChain[]
): Promise<ChainHoldingsResult[]> {
  const settled = await Promise.allSettled(chains.map((chain) => getWalletHoldings(admin, clientFor(chain), priceProvider, walletAddress, chain)));
  return settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { chain: chains[i], chainId: BAG_CHAINS[chains[i]].chainId, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
  );
}

/** What a sweep sells into: the chain's stablecoin (default) or its native token (ETH on every BAG chain). */
export type SweepReceive = 'STABLE' | 'NATIVE';

/** The token a sweep on `chain` pays out, for `receive`. Native is reported at the zero-address sentinel. */
export function sweepOutputFor(chain: BagChain, receive: SweepReceive): { address: string; symbol: string; decimals: number; native: boolean } {
  const cfg = BAG_CHAINS[chain];
  return receive === 'NATIVE'
    ? { address: NATIVE_ASSET_ADDRESS, symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals, native: true }
    : { ...cfg.sweepOutputToken, native: false };
}

export interface SweepQuoteRequest {
  /** The chain the tokens are on and the sale happens on; Robinhood Chain when absent. */
  chain?: BagChain;
  /** STABLE (default): the chain's stablecoin. NATIVE: the chain's native token — then the stablecoin can be sold too. */
  receive?: SweepReceive;
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
      outputToken: { address: string; symbol: string; decimals: number; native: boolean };
      /** Sums of the per-swap simulated / on-chain-enforced minimum outputs; null if any leg lacks one. */
      expectedOutRaw: string | null;
      minOutRaw: string | null;
      priceImpactBps: number | null;
      /** Tokens left out because Composer found no route for them; the sale covers the rest. */
      skipped: { address: string; symbol: string; reason: string }[];
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
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch },
  chain: BagChain = 'robinhood'
): Promise<SweepQuoteResult> {
  const cfg = BAG_CHAINS[chain];
  const receive: SweepReceive = request.receive ?? 'STABLE';
  if (receive !== 'STABLE' && receive !== 'NATIVE') return { ok: false, status: 400, error: 'receive must be STABLE or NATIVE.' };
  const outToken = sweepOutputFor(chain, receive);
  if (!options.apiKey) return { ok: false, status: 503, error: 'Selling is not configured on this deployment (LIFI_API_KEY).' };
  if (!Array.isArray(request.tokens) || request.tokens.length === 0) return { ok: false, status: 400, error: 'Pick at least one token to sell.' };
  if (request.tokens.length > MAX_SWEEP_TOKENS) return { ok: false, status: 400, error: `At most ${MAX_SWEEP_TOKENS} tokens per sale.` };
  if (request.acceptedPriceImpactBps !== undefined && !(Number.isInteger(request.acceptedPriceImpactBps) && request.acceptedPriceImpactBps >= 0 && request.acceptedPriceImpactBps <= MAX_ACCEPTABLE_PRICE_IMPACT_BPS)) {
    return { ok: false, status: 400, error: `Price impact above ${MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% cannot be accepted.` };
  }

  // Only registry tokens, never the output token, each at most what the wallet holds right now.
  const registry = new Map(
    (await listAssets(admin, { chain, status: 'VERIFIED' })).map((a) => [a.address.toLowerCase(), a] as const)
  );
  // Selling into native ETH: the stablecoin is an ordinary input. Selling into the stablecoin: it is what you receive.
  const output = outToken.native ? null : outToken.address.toLowerCase();
  const seen = new Set<string>();
  const picked: { asset: CanonicalAsset; amountRaw: string }[] = [];
  for (const t of request.tokens) {
    const address = typeof t?.address === 'string' ? t.address.toLowerCase() : '';
    const asset = registry.get(address);
    if (!asset) return { ok: false, status: 400, error: `Unknown token ${String(t?.address)}.` };
    if (output !== null && address === output) return { ok: false, status: 400, error: `${asset.symbol} is what you receive; it cannot be sold here.` };
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
      chain,
      inputs: picked.map((p) => ({ address: p.asset.address, amountRaw: p.amountRaw, symbol: p.asset.symbol })),
      outputTokenAddress: cfg.sweepOutputToken.address,
      ...(outToken.native ? { nativeOutput: true } : {}),
      signerAddress: walletAddress,
      slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      ...(maxPriceImpactBps !== undefined ? { maxPriceImpactBps } : {}),
      skipUnroutable: true,
    });
  } catch (err) {
    const notice = composerFallbackFrom(err);
    if (notice.reason === 'PRICE_IMPACT') {
      return { ok: false, status: 422, error: 'The price impact of this sale is above the limit.', composerFallback: notice };
    }
    return { ok: false, status: 502, error: `No route to sell these tokens right now: ${notice.message}` };
  }

  // Output ports index the tokens actually sold (`compiled.kept`, original order).
  const keptAddresses = new Set(compiled.kept.map((k) => k.address.toLowerCase()));
  const sold = picked.filter((p) => keptAddresses.has(p.asset.address.toLowerCase()));
  const legs: SweepQuoteLeg[] = sold.map((p, i) => {
    const { expected, min } = composerPortAmounts(compiled.outputs, `${sweepNodeId(i)}.amountOut`);
    return {
      address: p.asset.address,
      symbol: p.asset.symbol,
      amountRaw: p.amountRaw,
      decimals: p.asset.decimals,
      expectedOutRaw: expected,
      minOutRaw: min,
    };
  });

  return {
    ok: true,
    transaction: {
      to: compiled.transactionRequest.to,
      data: compiled.transactionRequest.data,
      value: compiled.transactionRequest.value,
      chainId: compiled.transactionRequest.chainId ?? cfg.chainId,
    },
    approvals: compiled.approvals,
    legs,
    outputToken: { address: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals, native: outToken.native },
    expectedOutRaw: sumOrNull(legs.map((l) => l.expectedOutRaw)),
    minOutRaw: sumOrNull(legs.map((l) => l.minOutRaw)),
    priceImpactBps: compiled.priceImpact?.impactBps ?? null,
    skipped: (compiled.skipped ?? []).map((x) => ({ address: x.address, symbol: x.symbol, reason: x.reason })),
  };
}

// -----------------------------------------------------------------------------
// Buying: one or several registry tokens on one chain, paid with ETH (no
// approval, one signature) or the chain's stablecoin, in ONE Composer
// transaction (the same flow a Bag purchase uses). The bought tokens land in
// the same wallet. Not tied to any Bag and never touches Bag accounting.
// -----------------------------------------------------------------------------

export interface BuyQuoteRequest {
  chain?: BagChain;
  /** NATIVE (ETH, default): no approval. STABLE: the chain's stablecoin, one exact approval. */
  pay?: SweepReceive;
  /** Total spend in the pay token's smallest unit. */
  amountRaw: string;
  /** What to buy and each one's share of the spend; shares sum to 10000 bps. */
  buys: { address: string; weightBps: number }[];
  acceptedPriceImpactBps?: number;
}

export type BuyQuoteResult =
  | {
      ok: true;
      transaction: { to: string; data: string; value: string; chainId: number };
      approvals: { token: string; spender: string; amountRaw: string }[];
      payToken: { address: string; symbol: string; decimals: number; native: boolean };
      amountRaw: string;
      legs: { address: string; symbol: string; decimals: number; weightBps: number; expectedOutRaw: string | null; minOutRaw: string | null }[];
      priceImpactBps: number | null;
    }
  | { ok: false; status: number; error: string; composerFallback?: ComposerFallbackNotice };

export async function quoteWalletBuy(
  admin: SupabaseClient,
  client: PublicClient,
  walletAddress: string,
  request: BuyQuoteRequest,
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch },
  chain: BagChain = 'robinhood'
): Promise<BuyQuoteResult> {
  const pay: SweepReceive = request.pay ?? 'NATIVE';
  if (pay !== 'STABLE' && pay !== 'NATIVE') return { ok: false, status: 400, error: 'pay must be NATIVE or STABLE.' };
  const payToken = sweepOutputFor(chain, pay);
  if (!options.apiKey) return { ok: false, status: 503, error: 'Buying is not configured on this deployment (LIFI_API_KEY).' };
  if (typeof request.amountRaw !== 'string' || !/^\d+$/.test(request.amountRaw) || BigInt(request.amountRaw) <= BigInt(0)) {
    return { ok: false, status: 400, error: 'Enter an amount to spend.' };
  }
  if (!Array.isArray(request.buys) || request.buys.length === 0) return { ok: false, status: 400, error: 'Pick at least one token to buy.' };
  if (request.buys.length > MAX_SWEEP_TOKENS) return { ok: false, status: 400, error: `At most ${MAX_SWEEP_TOKENS} tokens per purchase.` };
  if (request.acceptedPriceImpactBps !== undefined && !(Number.isInteger(request.acceptedPriceImpactBps) && request.acceptedPriceImpactBps >= 0 && request.acceptedPriceImpactBps <= MAX_ACCEPTABLE_PRICE_IMPACT_BPS)) {
    return { ok: false, status: 400, error: `Price impact above ${MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% cannot be accepted.` };
  }

  const registry = new Map((await listAssets(admin, { chain, status: 'VERIFIED' })).map((a) => [a.address.toLowerCase(), a] as const));
  const seen = new Set<string>();
  let total = 0;
  const legs: { asset: CanonicalAsset; weightBps: number }[] = [];
  for (const b of request.buys) {
    const address = typeof b?.address === 'string' ? b.address.toLowerCase() : '';
    const asset = registry.get(address);
    if (!asset) return { ok: false, status: 400, error: `Unknown token ${String(b?.address)}.` };
    if (!payToken.native && address === payToken.address.toLowerCase()) return { ok: false, status: 400, error: `${asset.symbol} is what you pay with.` };
    if (seen.has(address)) return { ok: false, status: 400, error: `${asset.symbol} is listed twice.` };
    if (!Number.isInteger(b.weightBps) || b.weightBps <= 0) return { ok: false, status: 400, error: `${asset.symbol}: invalid share.` };
    seen.add(address);
    total += b.weightBps;
    legs.push({ asset, weightBps: b.weightBps });
  }
  if (total !== 10000) return { ok: false, status: 400, error: 'The shares must add up to 100%.' };
  const noRoute = legs.filter((l) => l.asset.routeStatus === 'NO_ROUTE').map((l) => l.asset.symbol);
  if (noRoute.length > 0) {
    return { ok: false, status: 400, error: `No swap route on ${BAG_CHAINS[chain].name} for ${noRoute.join(', ')} right now. Remove ${noRoute.length > 1 ? 'them' : 'it'} and try again.` };
  }

  // The wallet must hold what it spends (for ETH, the network fee comes on top; the wallet's simulation catches a shortfall).
  const owner = walletAddress as `0x${string}`;
  const held = payToken.native
    ? await client.getBalance({ address: owner })
    : ((await client.readContract({ address: payToken.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })) as bigint);
  if (BigInt(request.amountRaw) > held) return { ok: false, status: 400, error: `Not enough ${payToken.symbol} in your wallet.` };

  const maxPriceImpactBps =
    request.acceptedPriceImpactBps !== undefined ? Math.min(request.acceptedPriceImpactBps + PRICE_IMPACT_ACCEPT_BUFFER_BPS, MAX_ACCEPTABLE_PRICE_IMPACT_BPS) : undefined;

  let compiled;
  try {
    compiled = await buildComposerPurchase({
      chain,
      inputTokenAddress: payToken.address,
      inputAmountRaw: request.amountRaw,
      legs: legs.map((l) => ({ address: l.asset.address, weightBps: l.weightBps, symbol: l.asset.symbol })),
      signerAddress: walletAddress,
      slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      ...(maxPriceImpactBps !== undefined ? { maxPriceImpactBps } : {}),
    });
  } catch (err) {
    const notice = composerFallbackFrom(err);
    if (notice.reason === 'PRICE_IMPACT') return { ok: false, status: 422, error: 'The price impact of this purchase is above the limit.', composerFallback: notice };
    return { ok: false, status: 502, error: `No route to buy these tokens right now: ${notice.message}` };
  }

  return {
    ok: true,
    transaction: {
      to: compiled.transactionRequest.to,
      data: compiled.transactionRequest.data,
      value: compiled.transactionRequest.value,
      chainId: compiled.transactionRequest.chainId ?? BAG_CHAINS[chain].chainId,
    },
    approvals: compiled.approvals,
    payToken,
    amountRaw: request.amountRaw,
    legs: legs.map((l, i) => ({
      address: l.asset.address,
      symbol: l.asset.symbol,
      decimals: l.asset.decimals,
      weightBps: l.weightBps,
      expectedOutRaw: composerLegSimulatedOutputRaw(compiled.outputs, i),
      minOutRaw: composerLegEnforcedMinOutputRaw(compiled.outputs, i),
    })),
    priceImpactBps: compiled.priceImpact?.impactBps ?? null,
  };
}

