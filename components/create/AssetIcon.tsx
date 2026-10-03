import { useState } from 'react';
import { Asset } from '@/lib/create-assets-data';

/**
 * The token's own logo (registry `logoUrl`, published by Robinhood / LI.FI)
 * when there is one; otherwise — or if the image fails to load — the first
 * letters of its symbol, never a generic emoji that looks the same for
 * every token.
 */
export function AssetIcon({ asset }: { asset: Pick<Asset, 'symbol' | 'logoUrl'> }) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(asset.logoUrl) && !failed;

  return (
    <div className="asset-icon" aria-hidden="true">
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote logos from several CDNs; next/image would need each host allow-listed
        <img src={asset.logoUrl} alt="" width={34} height={34} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span className="asset-monogram">{asset.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase()}</span>
      )}
    </div>
  );
}
