'use client';

import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { Bag } from '@/types';
import { formatTimeAgo } from '@/lib/format';
import { VERIFICATION_STALE_MS } from '@/lib/domain/proof/protocol-proof';

export { VERIFICATION_STALE_MS };

/** How current a Bag's figures are against the chain. Renders nothing for Bags without the information (demo Bags). */
export function VerificationBadge({ verification, now = Date.now() }: { verification: Bag['verification']; now?: number }) {
  if (!verification) return null;
  if (verification.pendingOutflows > 0) {
    return (
      <span className="verify-badge warn" title="A holder's wallet holds less than BAG tracks; the outflow is being confirmed on-chain.">
        <ShieldAlert size={12} /> Outflow being confirmed
      </span>
    );
  }
  if (!verification.checkedAt) {
    return (
      <span className="verify-badge muted" title="Not every holder's wallet has been checked on-chain yet.">
        <ShieldAlert size={12} /> Not yet verified on-chain
      </span>
    );
  }
  const stale = now - Date.parse(verification.checkedAt) > VERIFICATION_STALE_MS;
  return (
    <span className={`verify-badge ${stale ? 'muted' : 'ok'}`} title="Every holder's wallet was checked against BAG's records on Robinhood Chain.">
      <ShieldCheck size={12} /> {stale ? 'Last verified' : 'Verified on-chain'} {formatTimeAgo(verification.checkedAt, now)}
    </span>
  );
}
