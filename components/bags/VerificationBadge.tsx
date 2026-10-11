'use client';

import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { Bag } from '@/types';

/** A check older than this is shown as stale: the 5-minute reconciliation should have refreshed it. */
export const VERIFICATION_STALE_MS = 15 * 60 * 1000;

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

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
      <ShieldCheck size={12} /> {stale ? 'Last verified' : 'Verified on-chain'} {ago(verification.checkedAt, now)}
    </span>
  );
}
