import { Asset, filterAssetsByQuery, formatPrice } from '@/lib/create-assets-data';
import { Search, X } from 'lucide-react';
import { useState } from 'react';
import { AssetIcon } from './AssetIcon';

interface AssetSelectorProps {
  /** The VERIFIED registry-backed pool for the currently selected network — see `app/dashboard/create/page.tsx`. Production-hardening P0-2: never padded with the static demo catalog anymore, so an empty array here means "the registry genuinely has nothing for this chain/type", not "still loading". */
  assets: Asset[];
  selectedIds: string[];
  onSelect: (assetId: string) => void;
  onDeselect: (assetId: string) => void;
  /** True while the caller's registry fetch is still in flight — shows a subtle inline note, and is also what tells this component NOT to show the "no verified assets" empty state prematurely, before the first fetch has even resolved. */
  loadingRegistryAssets?: boolean;
}

export function AssetSelector({ assets, selectedIds, onSelect, onDeselect, loadingRegistryAssets }: AssetSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'crypto' | 'stock'>('all');
  // Assets the background liquidity check found no swap route for are hidden
  // by default — a Bag built on them can't be bought. Still one click away.
  const [showNoRoute, setShowNoRoute] = useState(false);

  const results = searchQuery ? filterAssetsByQuery(assets, searchQuery) : assets;
  const typed = filterType === 'all' ? results : results.filter(a => a.type === filterType);
  const noRouteCount = typed.filter((a) => a.routeStatus === 'NO_ROUTE' && !selectedIds.includes(a.id)).length;
  const filtered = showNoRoute ? typed : typed.filter((a) => a.routeStatus !== 'NO_ROUTE' || selectedIds.includes(a.id));

  const selectedSet = new Set(selectedIds);
  const selectedAssets = assets.filter(a => selectedSet.has(a.id));
  const availableAssets = filtered.filter(a => !selectedSet.has(a.id));

  // Distinguishes "the registry has nothing for this network at all" from
  // "your search/filter just didn't match anything" — these need different
  // messages so a creator doesn't read an empty registry as a broken search
  // box, or a bad search as "this network has no assets".
  const registryIsEmpty = !loadingRegistryAssets && assets.length === 0;
  const emptyMessage = registryIsEmpty
    ? 'No verified assets are currently available on this network.'
    : 'No assets found';

  return (
    <div>
      <div className="search-input-wrap">
        <Search size={17} />
        <input
          type="text"
          className="search-input"
          placeholder="Search by symbol or name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="chip-row">
        {(['all', 'crypto', 'stock'] as const).map((type) => (
          <button
            key={type}
            className={`chip ${filterType === type ? 'active' : ''}`}
            onClick={() => setFilterType(type)}
          >
            {type === 'all' ? 'All Assets' : type === 'crypto' ? 'Crypto' : 'Stocks'}
          </button>
        ))}
      </div>

      {(noRouteCount > 0 || showNoRoute) && (
        <button
          type="button"
          onClick={() => setShowNoRoute((v) => !v)}
          style={{ marginTop: 10, fontSize: 12.5, color: 'var(--mute)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {showNoRoute ? 'Hide assets without liquidity' : `Show ${noRouteCount} asset${noRouteCount === 1 ? '' : 's'} without liquidity`}
        </button>
      )}

      {loadingRegistryAssets && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--mute)' }}>Loading live stock tokens…</div>
      )}

      {selectedAssets.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <span className="section-label">Selected ({selectedAssets.length})</span>
          <div className="asset-grid selected">
            {selectedAssets.map((asset) => (
              <div key={asset.id} className="asset-pick picked">
                <AssetIcon asset={asset} />
                <div className="asset-meta">
                  <div className="sym">{asset.symbol}</div>
                  <div className="nm">{asset.name}</div>
                </div>
                <button className="asset-remove" onClick={() => onDeselect(asset.id)} aria-label={`Remove ${asset.symbol}`}>
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 26 }}>
        <span className="section-label">
          Available Assets {availableAssets.length > 0 && `(${availableAssets.length})`}
        </span>
        <div className="asset-grid" style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
          {availableAssets.length > 0 ? (
            availableAssets.map((asset) => (
              <button key={asset.id} className="asset-pick" onClick={() => onSelect(asset.id)}>
                <AssetIcon asset={asset} />
                <div className="asset-meta">
                  <div className="sym">{asset.symbol}</div>
                  <div className="nm">{asset.name}</div>
                  {asset.routeStatus === 'NO_ROUTE' && <div className="nm" style={{ color: '#E27D60' }}>No liquidity right now</div>}
                </div>
                {asset.price !== undefined && (
                  <div className="asset-price">
                    <div className="p">{formatPrice(asset.price)}</div>
                    {asset.change24h !== undefined && (
                      <div className={`c ${asset.change24h >= 0 ? 'pos' : 'neg'}`}>
                        {asset.change24h > 0 ? '+' : ''}{asset.change24h}%
                      </div>
                    )}
                  </div>
                )}
              </button>
            ))
          ) : (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '32px 0', color: 'var(--mute)' }}>
              {emptyMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}