'use client';

import { useMemo, useState } from 'react';
import { AssetDefinition } from '@/lib/config/market';
import { TradeSide } from '@/types/domain';

interface TradePanelProps {
  assets: AssetDefinition[];
  prices: Record<string, number>;
  ownedQuantity: (symbol: string) => number;
  onTrade: (
    symbol: string,
    side: TradeSide,
    quantity: number
  ) => { ok: boolean; error?: string; pointsAwarded?: number } | Promise<{ ok: boolean; error?: string; pointsAwarded?: number }>;
  initialSymbol?: string;
}

export function TradePanel({ assets, prices, ownedQuantity, onTrade, initialSymbol }: TradePanelProps) {
  const [symbol, setSymbol] = useState(initialSymbol ?? assets[0]?.symbol ?? '');
  const [side, setSide] = useState<TradeSide>('BUY');
  const [usdAmount, setUsdAmount] = useState(500);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const price = prices[symbol] ?? 0;
  const quantity = useMemo(() => (price > 0 ? usdAmount / price : 0), [usdAmount, price]);
  const owned = ownedQuantity(symbol);
  const maxSellUsd = owned * price;

  const handleSubmit = async () => {
    if (quantity <= 0 || isSubmitting) return;
    const finalQuantity = side === 'SELL' ? Math.min(quantity, owned) : quantity;
    setIsSubmitting(true);
    try {
      const result = await onTrade(symbol, side, finalQuantity);
      if (result.ok) {
        const pointsNote = result.pointsAwarded ? ` +${result.pointsAwarded} BAG Points earned.` : '';
        setFeedback({ ok: true, message: `${side === 'BUY' ? 'Bought' : 'Sold'} ${symbol}.${pointsNote}` });
      } else {
        setFeedback({ ok: false, message: result.error ?? 'Trade failed.' });
      }
    } finally {
      setIsSubmitting(false);
      setTimeout(() => setFeedback(null), 4000);
    }
  };

  return (
    <div>
      <div className="market-grid">
        {assets.map((a) => (
          <button
            key={a.symbol}
            className={`market-tile ${symbol === a.symbol ? 'active' : ''}`}
            onClick={() => setSymbol(a.symbol)}
          >
            <div className="sym">{a.symbol}</div>
            <div className="nm">{a.name}</div>
            <div className="px mono">${(prices[a.symbol] ?? a.basePrice).toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
          </button>
        ))}
      </div>

      <div className="trade-form">
        <div className="trade-side-toggle">
          <button className={`trade-side-btn buy ${side === 'BUY' ? 'active' : ''}`} onClick={() => setSide('BUY')}>
            BUY
          </button>
          <button className={`trade-side-btn sell ${side === 'SELL' ? 'active' : ''}`} onClick={() => setSide('SELL')}>
            SELL
          </button>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label>Amount (USD)</label>
          <input
            type="number"
            min={0}
            value={usdAmount}
            onChange={(e) => setUsdAmount(Math.max(0, Number(e.target.value) || 0))}
          />
        </div>

        <button className="btn btn-primary" onClick={handleSubmit} disabled={quantity <= 0 || isSubmitting}>
          {isSubmitting ? 'Submitting…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${symbol}`}
        </button>
      </div>

      <p className="mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 8 }}>
        ≈ {quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} {symbol} at ${price.toLocaleString()}
        {side === 'SELL' && ` · You own ${owned.toLocaleString(undefined, { maximumFractionDigits: 6 })} (${'$'}${maxSellUsd.toFixed(0)})`}
      </p>

      {feedback && <div className={`trade-feedback ${feedback.ok ? 'ok' : 'err'}`}>{feedback.message}</div>}
    </div>
  );
}
