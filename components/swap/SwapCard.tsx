'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, Search, X } from 'lucide-react';
import { parseUnits } from 'viem';
import { formatDecimalString, formatDecimalStringUsd, formatRawAmount } from '@/lib/format';
import { describeWalletError } from '@/lib/blockchain/wallet-error';
import { recheckWalletAfterTrade } from '@/lib/wallet-recheck';
import { executeWalletSweep, SweepProgress } from '@/lib/blockchain/wallet-sweep-client';
import { BAG_CHAINS, BAG_CHAINS_LIST, type BagChain } from '@/lib/config/chains';
import type { ChainHoldingsResult, WalletHoldings, WalletTokenBalance } from '@/lib/server/wallet-holdings';
import type { ComposerFallbackNotice } from '@/types/purchase-intent';
import { bpsToPercent, equalWeightsBps, setWeightKeepingTotal } from '@/lib/weight-input';
import { MAX_ACCEPTABLE_PRICE_IMPACT_BPS } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// The Swap page, laid out like Create: tokens on the left, the swap in the
// middle ("You pay" → "You receive"), the summary and the button on the right.
//   Multi-buy:  one payment (ETH — no approval, one signature — or the chain's
//               stablecoin) → several tokens, split by sliders that keep 100%
//               (POST /api/wallet/buy-quote).
//   Multi-sell: several wallet tokens, each 25/50/75% or all of it → the chain's
//               stablecoin or ETH (POST /api/wallet/sweep-quote).
// Either way ONE LI.FI Composer transaction on one chain, compiled by the
// server and signed only by the user's wallet; with a MetaMask smart account,
// any approvals and the swap are confirmed together (EIP-5792).
// -----------------------------------------------------------------------------

export type SwapMode = 'buy' | 'sell';
type Money = 'NATIVE' | 'STABLE';

interface RegistryAsset {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string | null;
  /** From the registry's liquidity pass; NO_ROUTE tokens are not offered for buying. */
  routeStatus?: 'ROUTABLE' | 'NO_ROUTE';
}

interface PlanBase {
  transaction: { to: string; data: string; value: string; chainId: number };
  approvals: { token: string; spender: string; amountRaw: string }[];
  priceImpactBps: number | null;
}
interface BuyQuote extends PlanBase {
  payToken: { symbol: string; decimals: number; native: boolean };
  amountRaw: string;
  legs: { address: string; symbol: string; decimals: number; weightBps: number; expectedOutRaw: string | null; minOutRaw: string | null }[];
}
interface SellQuote extends PlanBase {
  outputToken: { symbol: string; decimals: number };
  legs: { address: string; symbol: string; amountRaw: string; decimals: number; expectedOutRaw: string | null; minOutRaw: string | null }[];
  expectedOutRaw: string | null;
  minOutRaw: string | null;
  /** Tokens left out because no route was found for them; they stay in the wallet. */
  skipped?: { address: string; symbol: string; reason: string }[];
}
type Quote = { mode: 'buy'; q: BuyQuote } | { mode: 'sell'; q: SellQuote };

type Phase =
  | { kind: 'idle' }
  | { kind: 'quoting' }
  | { kind: 'quote'; quote: Quote }
  | { kind: 'impact'; notice: ComposerFallbackNotice }
  | { kind: 'executing'; step: SweepProgress; quote: Quote }
  | { kind: 'done'; txHash: string }
  | { kind: 'error'; message: string };

export const MAX_SWAP_TOKENS = 12;

const PROGRESS: Record<SweepProgress, string> = {
  approving: 'Approve the exact amount in your wallet…',
  batching: 'Confirm once in your wallet: approvals and swap together…',
  simulating: 'Checking the transaction…',
  signing: 'Confirm the swap in your wallet…',
  confirming: 'Confirming on-chain…',
};

/** Equal shares in bps summing to exactly 10000 (the remainder goes to the first tokens). */
export function equalShares(n: number): number[] {
  const base = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10000 - base * n ? 1 : 0));
}

const isHoldings = (r: ChainHoldingsResult): r is WalletHoldings => !('error' in r);
const DECIMAL_RE = /^\d+(\.\d+)?$/;

function TokenIcon({ symbol, logoUrl }: { symbol: string; logoUrl?: string | null }) {
  return logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- registry logo URL
    <img src={logoUrl} alt="" width={22} height={22} className="token-icon" />
  ) : (
    <span className="token-icon token-icon-fallback" aria-hidden="true">
      {symbol.slice(0, 1)}
    </span>
  );
}

export function SwapCard({ walletAddress, initialMode = 'buy' }: { walletAddress: string; initialMode?: SwapMode }) {
  const [mode, setMode] = useState<SwapMode>(initialMode);
  const [chain, setChain] = useState<BagChain>('robinhood');
  const [money, setMoney] = useState<Money>('NATIVE'); // buy: what you pay; sell: what you receive
  const [amount, setAmount] = useState('');
  const [buyList, setBuyList] = useState<string[]>([]);
  const [sellList, setSellList] = useState<string[]>([]);
  const [assets, setAssets] = useState<RegistryAsset[] | null>(null);
  const [holdings, setHoldings] = useState<ChainHoldingsResult[] | null>(null);
  const [buyWeights, setBuyWeights] = useState<number[]>([]);
  // Share of each picked holding to sell, in percent (25, 50, 75 or 100).
  const [sellPct, setSellPct] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const recheckCancel = useRef<(() => void) | null>(null);
  useEffect(() => () => recheckCancel.current?.(), []);
  const [acceptImpact, setAcceptImpact] = useState(false);

  const cfg = BAG_CHAINS[chain];
  const nativeSym = cfg.nativeCurrency.symbol;
  const stableSym = cfg.sweepOutputToken.symbol;
  const moneySym = money === 'NATIVE' ? nativeSym : stableSym;
  const moneyDecimals = money === 'NATIVE' ? cfg.nativeCurrency.decimals : cfg.sweepOutputToken.decimals;
  const stable = cfg.sweepOutputToken.address.toLowerCase();
  const busy = phase.kind === 'quoting' || phase.kind === 'executing';

  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    fetch(`/api/assets?chain=${chain}`)
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((b) => !cancelled && setAssets((b.assets ?? []) as RegistryAsset[]))
      .catch(() => !cancelled && setAssets([]));
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const loadHoldings = useCallback(() => {
    fetch('/api/wallet/holdings?chain=all', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { chains: [] }))
      .then((b) => setHoldings((b.chains ?? []) as ChainHoldingsResult[]))
      .catch(() => setHoldings([]));
  }, []);
  useEffect(() => loadHoldings(), [loadHoldings, walletAddress]);

  const chainHoldings = holdings?.find((h) => h.chain === chain);
  const walletTokens = useMemo<WalletTokenBalance[]>(() => (chainHoldings && isHoldings(chainHoldings) ? chainHoldings.tokens : []), [chainHoldings]);
  const nativeBalance = chainHoldings && isHoldings(chainHoldings) ? chainHoldings.nativeBalance : null;

  // What can go in each list: buy = registry tokens (not the stablecoin when paying with it); sell = held tokens
  // (not the stablecoin when receiving it).
  const buyable = useMemo(
    () =>
      (assets ?? []).filter(
        (a) => /^0x[0-9a-fA-F]{40}$/.test(a.address) && a.routeStatus !== 'NO_ROUTE' && !(money === 'STABLE' && a.address.toLowerCase() === stable)
      ),
    [assets, money, stable]
  );
  const sellable = useMemo(() => walletTokens.filter((t) => t.sellable || money === 'NATIVE'), [walletTokens, money]);
  const assetBy = new Map(buyable.map((a) => [a.address, a] as const));
  const heldBy = new Map(sellable.map((t) => [t.address, t] as const));
  const list = mode === 'buy' ? buyList : sellList;
  const setList = mode === 'buy' ? setBuyList : setSellList;

  const resetQuote = () => setPhase({ kind: 'idle' });
  const switchMode = (m: SwapMode) => {
    setMode(m);
    setMoney(m === 'buy' ? 'NATIVE' : 'STABLE');
    resetQuote();
  };
  const switchChain = (c: BagChain) => {
    setChain(c);
    setBuyList([]);
    setBuyWeights([]);
    setSellList([]);
    setSellPct({});
    resetQuote();
  };
  const switchMoney = (m: Money) => {
    setMoney(m);
    // The stablecoin cannot be on both sides.
    if (m === 'STABLE') {
      if (buyList.some((a) => a.toLowerCase() === stable)) {
        const next = buyList.filter((a) => a.toLowerCase() !== stable);
        setBuyList(next);
        setBuyWeights(equalWeightsBps(next.length));
      }
      setSellList((l) => l.filter((a) => a.toLowerCase() !== stable));
    }
    resetQuote();
  };
  const toggle = (address: string) => {
    const next = list.includes(address) ? list.filter((a) => a !== address) : list.length < MAX_SWAP_TOKENS ? [...list, address] : list;
    setList(next);
    if (mode === 'buy') setBuyWeights(equalWeightsBps(next.length));
    resetQuote();
  };
  const setBuyWeight = (i: number, bps: number) => {
    setBuyWeights((w) => setWeightKeepingTotal(w, i, bps));
    resetQuote();
  };
  const setSellShare = (address: string, pct: number) => {
    setSellPct((m) => ({ ...m, [address]: pct }));
    resetQuote();
  };
  const shareOf = (address: string) => sellPct[address] ?? 100;
  /** The raw amount of a holding to sell at its chosen share (bigint; never more than the balance). */
  const sellAmountRaw = (address: string): string => {
    const bal = heldBy.get(address)?.balanceRaw ?? '0';
    return ((BigInt(bal) * BigInt(shareOf(address))) / BigInt(100)).toString();
  };

  const amountRaw = (() => {
    if (!DECIMAL_RE.test(amount.trim())) return null;
    try {
      const raw = parseUnits(amount.trim(), moneyDecimals);
      return raw > BigInt(0) ? raw.toString() : null;
    } catch {
      return null;
    }
  })();
  // Display only: the USD estimate of what is being sold.
  const sellUsd = sellList.reduce((sum, a) => sum + (Number(heldBy.get(a)?.usdValue ?? 0) * shareOf(a)) / 100, 0);
  const weights = buyWeights.length === buyList.length ? buyWeights : equalWeightsBps(buyList.length);
  const blocker =
    list.length === 0
      ? mode === 'buy'
        ? 'Pick tokens to buy'
        : 'Pick tokens to sell'
      : mode === 'buy' && amountRaw === null
        ? `Enter an amount in ${moneySym}`
        : mode === 'buy' && weights.some((w) => w <= 0)
          ? 'Each token needs a share above 0%'
          : mode === 'sell' && sellList.some((a) => BigInt(sellAmountRaw(a)) <= BigInt(0))
            ? 'Nothing to sell for one of the tokens'
            : null;
  const ready = blocker === null;

  const requestQuote = useCallback(
    async (acceptedPriceImpactBps?: number) => {
      setAcceptImpact(false);
      setPhase({ kind: 'quoting' });
      const extra = acceptedPriceImpactBps !== undefined ? { acceptedPriceImpactBps } : {};
      const [url, body] =
        mode === 'buy'
          ? [
              '/api/wallet/buy-quote',
              { chain, pay: money, amountRaw, buys: buyList.map((address, i) => ({ address, weightBps: weights[i] })), ...extra },
            ]
          : [
              '/api/wallet/sweep-quote',
              { chain, receive: money, tokens: sellList.map((address) => ({ address, amountRaw: sellAmountRaw(address) })), ...extra },
            ];
      try {
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => null);
        if (res.status === 422 && json?.composerFallback) {
          setPhase({ kind: 'impact', notice: json.composerFallback as ComposerFallbackNotice });
          return;
        }
        if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status}).`);
        setPhase({ kind: 'quote', quote: mode === 'buy' ? { mode, q: json as BuyQuote } : { mode, q: json as SellQuote } });
      } catch (err) {
        setPhase({ kind: 'error', message: (err as Error).message });
      }
    },
    // heldBy is derived from holdings each render; its balances are what the list shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, chain, money, amountRaw, buyList, sellList, holdings, weights, sellPct]
  );

  const confirm = useCallback(
    async (quote: Quote) => {
      setPhase({ kind: 'executing', step: 'simulating', quote });
      try {
        const hash = await executeWalletSweep(walletAddress, quote.q, (step) => setPhase({ kind: 'executing', step, quote }));
        setPhase({ kind: 'done', txHash: hash });
        // Tokens a Bag tracks may have left the wallet: let positions and Bag TVL follow.
        recheckCancel.current?.();
        recheckCancel.current = recheckWalletAfterTrade();
        setBuyList([]);
        setBuyWeights([]);
        setSellList([]);
        setSellPct({});
        setAmount('');
        loadHoldings();
      } catch (err) {
        const { message, rejected } = describeWalletError(err);
        setPhase({ kind: 'error', message: rejected ? 'You rejected the request in your wallet.' : message });
      }
    },
    [walletAddress, loadHoldings]
  );

  const quote = phase.kind === 'quote' || phase.kind === 'executing' ? phase.quote : null;
  const buyOut = (address: string) => {
    if (quote?.mode !== 'buy') return null;
    const l = quote.q.legs.find((x) => x.address.toLowerCase() === address.toLowerCase());
    return l?.expectedOutRaw ? formatRawAmount(l.expectedOutRaw, l.decimals, { maxFractionDigits: 6 }) : null;
  };
  const sellOut = quote?.mode === 'sell' && quote.q.expectedOutRaw ? formatRawAmount(quote.q.expectedOutRaw, quote.q.outputToken.decimals, { maxFractionDigits: 6 }) : null;

  const q = query.trim().toLowerCase();
  const pickerItems =
    mode === 'buy'
      ? buyable.filter((a) => !q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)).slice(0, 80)
      : sellable.filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));

  // ------------------------------------------------------------------ pieces
  const moneyPill = (
    <div className="swap-money" role="radiogroup" aria-label={mode === 'buy' ? 'Pay with' : 'Receive'}>
      {(['NATIVE', 'STABLE'] as const).map((m) => (
        <button key={m} role="radio" aria-checked={money === m} className={money === m ? 'token-pill active' : 'token-pill'} disabled={busy} onClick={() => switchMoney(m)}>
          {m === 'NATIVE' ? nativeSym : stableSym}
        </button>
      ))}
    </div>
  );

  const tokenRows =
    list.length === 0 ? (
      <p className="swap-empty">{mode === 'buy' ? 'Pick up to 12 tokens on the left.' : 'Pick the tokens to sell on the left — up to 12.'}</p>
    ) : (
      <ul className="swap-rows">
        {list.map((address, i) => {
          const a = mode === 'buy' ? assetBy.get(address) : heldBy.get(address);
          if (!a) return null;
          const held = mode === 'sell' ? (a as WalletTokenBalance) : null;
          const out = mode === 'buy' ? buyOut(address) : null;
          const share = shareOf(address);
          return (
            <li key={address} className="swap-row swap-row-col">
              <div className="swap-row-top">
                <TokenIcon symbol={a.symbol} logoUrl={a.logoUrl} />
                <div className="swap-row-main">
                  <span className="swap-row-sym">{a.symbol}</span>
                  <span className="swap-row-sub">
                    {held
                      ? `${formatRawAmount(sellAmountRaw(address), held.decimals, { maxFractionDigits: 6 })} of ${formatDecimalString(held.balance, { maxFractionDigits: 6 })}${held.usdValue === null ? '' : ` · ≈ ${formatDecimalStringUsd(((Number(held.usdValue) * share) / 100).toFixed(2))}`}`
                      : `${bpsToPercent(weights[i] ?? 0)}% of the spend`}
                  </span>
                </div>
                {out && <span className="swap-row-out mono">≈ {out}</span>}
                <button className="swap-row-remove" aria-label={`Remove ${a.symbol}`} disabled={busy} onClick={() => toggle(address)}>
                  <X size={14} />
                </button>
              </div>
              {held ? (
                <div className="swap-shares" role="group" aria-label={`Share of ${a.symbol} to sell`}>
                  {[25, 50, 75, 100].map((p) => (
                    <button key={p} type="button" aria-pressed={share === p} className={share === p ? 'active' : ''} disabled={busy} onClick={() => setSellShare(address, p)}>
                      {p === 100 ? 'All' : `${p}%`}
                    </button>
                  ))}
                </div>
              ) : (
                list.length > 1 && (
                  <input
                    type="range"
                    className="swap-weight"
                    min={0}
                    max={10000}
                    step={100}
                    value={weights[i] ?? 0}
                    aria-label={`${a.symbol} share of the spend`}
                    disabled={busy}
                    onChange={(e) => setBuyWeight(i, Number(e.target.value))}
                  />
                )
              )}
            </li>
          );
        })}
      </ul>
    );

  const summary: { k: string; v: string; cls?: string }[] = [
    { k: 'Network', v: cfg.name },
    { k: mode === 'buy' ? 'Buying' : 'Selling', v: list.length === 0 ? '—' : `${list.length} token${list.length === 1 ? '' : 's'}` },
    mode === 'buy'
      ? { k: 'You pay', v: amountRaw === null ? '—' : `${formatDecimalString(amount.trim(), { maxFractionDigits: 6 })} ${moneySym}` }
      : { k: 'Value sold (est.)', v: sellList.length === 0 ? '—' : `≈ ${formatDecimalStringUsd(sellUsd.toFixed(2))}` },
    mode === 'sell'
      ? { k: 'You receive (est.)', v: sellOut ? `${sellOut} ${moneySym}` : 'After the quote' }
      : { k: 'Split', v: buyList.length === 0 ? '—' : buyList.map((a, i) => `${assetBy.get(a)?.symbol ?? '?'} ${bpsToPercent(weights[i] ?? 0)}%`).join(' · ') },
    {
      k: 'Minimum (on-chain)',
      v:
        quote?.mode === 'sell' && quote.q.minOutRaw
          ? `${formatRawAmount(quote.q.minOutRaw, quote.q.outputToken.decimals, { maxFractionDigits: 6 })} ${quote.q.outputToken.symbol}`
          : quote?.mode === 'buy'
            ? 'Per token; below it nothing is swapped'
            : 'After the quote',
      cls: quote ? 'ok' : '',
    },
    { k: 'Price impact', v: quote && quote.q.priceImpactBps !== null ? `${(quote.q.priceImpactBps / 100).toFixed(2)}%` : '—' },
    {
      k: 'Wallet steps',
      v: quote
        ? quote.q.approvals.length === 0
          ? 'One signature'
          : `${quote.q.approvals.length} exact approval${quote.q.approvals.length === 1 ? '' : 's'} + swap`
        : '—',
    },
  ];

  return (
    <div className="swap3">
      <div className="swap3-head">
        <div className="swap-modes" role="tablist" aria-label="Mode">
          {(['buy', 'sell'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'swap-mode-tab active' : 'swap-mode-tab'} disabled={busy} onClick={() => switchMode(m)}>
              {m === 'buy' ? 'Multi-buy' : 'Multi-sell'}
            </button>
          ))}
        </div>
        <label className="swap-chain">
          <span className="sr-only">Network</span>
          <select aria-label="Network" value={chain} disabled={busy} onChange={(e) => switchChain(e.target.value as BagChain)}>
            {BAG_CHAINS_LIST.map((c) => (
              <option key={c} value={c}>
                {BAG_CHAINS[c].name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="create3-grid swap3-grid">
        {/* Tokens */}
        <section className="create3-card" aria-label={mode === 'buy' ? 'Tokens to buy' : 'Your tokens'}>
          <div className="create3-card-head">
            <h2>{mode === 'buy' ? 'Tokens' : 'Your wallet'}</h2>
            <span className="create3-count">
              {list.length} / {MAX_SWAP_TOKENS}
            </span>
          </div>
          <div className="swap-search">
            <Search size={14} aria-hidden="true" />
            <input placeholder="Search name or symbol" aria-label="Search tokens" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {mode === 'buy' && assets === null ? (
            <p className="swap-empty">Loading tokens…</p>
          ) : mode === 'sell' && holdings === null ? (
            <p className="swap-empty">Reading your wallet…</p>
          ) : pickerItems.length === 0 ? (
            <p className="swap-empty">{mode === 'buy' ? `No tokens are listed on ${cfg.name} yet.` : `No sellable tokens in your wallet on ${cfg.name}.`}</p>
          ) : (
            <ul className="swap-picker-list swap3-list">
              {pickerItems.map((t) => {
                const on = list.includes(t.address);
                const held = mode === 'sell' ? (t as WalletTokenBalance) : null;
                return (
                  <li key={t.address}>
                    <button
                      className={on ? 'swap-pick active' : 'swap-pick'}
                      aria-pressed={on}
                      aria-label={`${on ? 'Unpick' : 'Pick'} ${t.symbol}`}
                      disabled={busy || (!on && list.length >= MAX_SWAP_TOKENS)}
                      onClick={() => toggle(t.address)}
                    >
                      <TokenIcon symbol={t.symbol} logoUrl={t.logoUrl} />
                      <span className="swap-row-main">
                        <span className="swap-row-sym">{t.symbol}</span>
                        <span className="swap-row-sub">{t.name}</span>
                      </span>
                      {held && <span className="mono swap-row-out">{held.usdValue === null ? formatDecimalString(held.balance, { maxFractionDigits: 4 }) : formatDecimalStringUsd(held.usdValue)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* The swap */}
        <section className="create3-card create3-card-hot" aria-label="Your swap">
          <div className="create3-card-head">
            <h2>Your swap</h2>
            <span className={ready ? 'create3-ready ok' : 'create3-ready'}>{ready ? 'READY' : 'DRAFT'}</span>
          </div>
          <div className="swap-box">
            <div className="swap-box-label">
              <span>You pay</span>
              {mode === 'buy' && nativeBalance !== null && money === 'NATIVE' && (
                <span className="mono">Balance {formatDecimalString(nativeBalance, { maxFractionDigits: 5 })} {nativeSym}</span>
              )}
            </div>
            {mode === 'buy' ? (
              <div className="swap-amount-row">
                <input
                  className="swap-amount mono"
                  inputMode="decimal"
                  placeholder="0.0"
                  aria-label={`Amount in ${moneySym}`}
                  value={amount}
                  disabled={busy}
                  onChange={(e) => {
                    setAmount(e.target.value.replace(',', '.'));
                    resetQuote();
                  }}
                />
                {moneyPill}
              </div>
            ) : (
              <>
                {tokenRows}
                {sellList.length > 0 && <div className="swap-box-foot mono">≈ {formatDecimalStringUsd(sellUsd.toFixed(2))}</div>}
              </>
            )}
          </div>

          <div className="swap-arrow" aria-hidden="true">
            <ArrowDown size={16} />
          </div>

          <div className="swap-box">
            <div className="swap-box-label">
              <span>You receive</span>
              {mode === 'buy' && buyList.length > 1 && (
                <button type="button" className="link-button" disabled={busy} onClick={() => setBuyWeights(equalWeightsBps(buyList.length))}>
                  Split equally
                </button>
              )}
            </div>
            {mode === 'buy' ? (
              tokenRows
            ) : (
              <div className="swap-amount-row">
                <span className="swap-amount mono" aria-live="polite">
                  {sellOut ?? '—'}
                </span>
                {moneyPill}
              </div>
            )}
          </div>
        </section>

        {/* Summary */}
        <section className="create3-card swap3-summary" aria-label="Summary">
          <div className="create3-card-head">
            <h2>Summary</h2>
            <span className="create3-ready">ONE TRANSACTION</span>
          </div>
          <dl className="swap3-kv">
            {summary.map((row) => (
              <div key={row.k}>
                <dt>{row.k}</dt>
                <dd className={row.cls}>{row.v}</dd>
              </div>
            ))}
          </dl>

          {phase.kind === 'quote' && phase.quote.mode === 'sell' && (phase.quote.q.skipped?.length ?? 0) > 0 && (
            <div role="status" className="swap-skipped">
              Not sold (no route right now, stays in your wallet): {phase.quote.q.skipped!.map((x) => x.symbol).join(', ')}
            </div>
          )}
          {quote && (
            <p className="swap-hint" style={{ margin: 0 }}>
              {quote.q.approvals.length === 0
                ? 'No approval needed: one signature.'
                : `${quote.q.approvals.length} exact-amount approval${quote.q.approvals.length === 1 ? '' : 's'} + the swap — one confirmation in MetaMask, one per step in other wallets.`}
            </p>
          )}

          {phase.kind === 'quote' ? (
            <div className="swap-actions">
              <button className="btn btn-primary swap-cta" onClick={() => confirm(phase.quote)}>
                Confirm swap
              </button>
              <button className="btn btn-ghost" onClick={resetQuote}>
                Cancel
              </button>
            </div>
          ) : phase.kind === 'executing' ? (
            <button className="btn btn-primary swap-cta" disabled>
              <Loader2 size={14} className="animate-spin" /> {PROGRESS[phase.step]}
            </button>
          ) : (
            <button className="btn btn-primary swap-cta" disabled={busy || !ready} onClick={() => requestQuote()}>
              {phase.kind === 'quoting' ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Finding the best route…
                </>
              ) : blocker !== null ? (
                blocker
              ) : mode === 'buy' ? (
                `Buy ${buyList.length} token${buyList.length === 1 ? '' : 's'} with ${moneySym}`
              ) : (
                `Sell ${sellList.length} token${sellList.length === 1 ? '' : 's'} for ${moneySym}`
              )}
            </button>
          )}

          {phase.kind === 'impact' && (
            <div className="swap-note">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>High price impact</div>
              <p style={{ margin: '0 0 8px' }}>{phase.notice.message}</p>
              {phase.notice.priceImpactBps !== null && phase.notice.priceImpactBps <= MAX_ACCEPTABLE_PRICE_IMPACT_BPS ? (
                <>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="checkbox" checked={acceptImpact} onChange={(e) => setAcceptImpact(e.target.checked)} />I accept a {(phase.notice.priceImpactBps / 100).toFixed(2)}% price impact
                  </label>
                  <div className="swap-actions">
                    <button className="btn btn-primary" disabled={!acceptImpact} onClick={() => requestQuote(phase.notice.priceImpactBps ?? undefined)}>
                      Continue anyway
                    </button>
                    <button className="btn btn-ghost" onClick={resetQuote}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p style={{ margin: 0, color: '#E0847A' }}>Above {MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% — try a smaller amount.</p>
              )}
            </div>
          )}
          {phase.kind === 'done' && (
            <p className="swap-note" style={{ color: 'var(--emerald)' }}>
              Done — everything is in your wallet.{' '}
              <a href={`${cfg.explorerUrl}/tx/${phase.txHash}`} target="_blank" rel="noreferrer">
                View transaction →
              </a>
            </p>
          )}
          {phase.kind === 'error' && (
            <p className="swap-note" style={{ color: '#E0847A' }}>
              {phase.message}{' '}
              <button onClick={resetQuote} className="link-button">
                Dismiss
              </button>
            </p>
          )}
          {chain === 'ethereum' && <p className="swap-hint">Network fees on Ethereum can be higher than small amounts are worth — check the fee in your wallet.</p>}
          <div className="swap-metamask">
            <b>Works best with MetaMask.</b> Buying with ETH is one signature. Paying or selling with tokens needs exact-amount approvals: with a MetaMask smart
            account they are confirmed together with the swap, in one step. Other wallets (e.g. Rabby) confirm each step separately.
          </div>
        </section>
      </div>
    </div>
  );
}
