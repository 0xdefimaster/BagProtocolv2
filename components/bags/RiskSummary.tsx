'use client';

import { assessRisk } from '@/lib/domain/discovery/bag-discovery';
import type { BagPosition } from '@/types';

/** The Bag page's risk line: level, the facts behind it, and what it is not. Nothing for an empty composition. */
export function RiskSummary({ composition }: { composition: BagPosition[] }) {
  const risk = assessRisk(composition);
  if (!risk) return null;
  return (
    <div className="risk-summary">
      <span className={`bag-risk-chip risk-${risk.level.toLowerCase()}`}>{risk.level} risk</span>
      <span className="risk-reasons">{risk.reasons.join(' · ')}</span>
      <span className="risk-note">Rule-based estimate from the composition, not investment advice.</span>
    </div>
  );
}
