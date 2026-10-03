import { Asset, formatPrice, formatUSD } from '@/lib/create-assets-data';
import { AssetIcon } from './AssetIcon';

interface AllocationEditorProps {
  /** The same selectable pool passed to `AssetSelector` (static demo assets + any registry-backed ones the caller has loaded) — see `app/dashboard/create/page.tsx`. */
  assetPool: Asset[];
  assetIds: string[];
  allocations: Record<string, number>;
  investmentAmount: number;
  onAllocationChange: (assetId: string, value: number) => void;
  onAutoBalance: () => void;
  /** Assets the liquidity check found no swap route for — shown with a warning. */
  noRouteAssetIds?: Set<string>;
}

export function AllocationEditor({
  assetPool,
  assetIds,
  allocations,
  investmentAmount,
  onAllocationChange,
  onAutoBalance,
  noRouteAssetIds,
}: AllocationEditorProps) {
  const total = assetIds.reduce((sum, id) => sum + (allocations[id] || 0), 0);
  const isValid = total === 100;
  const assets = assetIds.map(id => assetPool.find(a => a.id === id)!).filter(Boolean);

  return (
    <div>
      <div className="alloc-total">
        <span className="section-label" style={{ marginBottom: 0 }}>Total Allocation</span>
        <span className={`v ${isValid ? 'ok' : 'bad'}`}>{total}%</span>
      </div>
      <div className="alloc-bar-track">
        <div className={`alloc-bar-fill ${isValid ? 'ok' : 'bad'}`} style={{ width: `${Math.min(total, 100)}%` }} />
      </div>

      <button className="btn btn-ghost auto-balance-btn" onClick={onAutoBalance}>
        Auto Balance (Equal Weight)
      </button>

      <div>
        {assets.map((asset) => {
          const pct = allocations[asset.id] || 0;
          const usd = (pct / 100) * investmentAmount;
          return (
            <div key={asset.id} className="alloc-row">
              <div className="alloc-row-head">
                <div className="alloc-row-id">
                  <AssetIcon asset={asset} />
                  <div className="asset-meta">
                    <div className="sym">{asset.symbol}</div>
                    <div className="nm">
                      {asset.name}{asset.price !== undefined ? ` · ${formatPrice(asset.price)}` : ''}
                    </div>
                    {noRouteAssetIds?.has(asset.id) && (
                      <div className="nm" style={{ color: '#E27D60' }}>No swap route right now — buyers can&apos;t get this asset</div>
                    )}
                  </div>
                </div>
                <div className="alloc-row-vals">
                  <span className="alloc-usd">{formatUSD(usd)}</span>
                  <span className="alloc-pct">{pct}%</span>
                </div>
              </div>
              <div className="alloc-slider-row">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={pct}
                  onChange={(e) => onAllocationChange(asset.id, parseInt(e.target.value, 10))}
                  className="alloc-slider"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={pct}
                  onChange={(e) => onAllocationChange(asset.id, parseInt(e.target.value || '0', 10))}
                  className="alloc-num"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="summary-row" style={{ marginTop: 12 }}>
        <span className="l">Crypto</span>
        <span className="v">{assets.filter(a => a.type === 'crypto').length}</span>
      </div>
      <div className="summary-row">
        <span className="l">Stocks</span>
        <span className="v">{assets.filter(a => a.type === 'stock').length}</span>
      </div>
    </div>
  );
}