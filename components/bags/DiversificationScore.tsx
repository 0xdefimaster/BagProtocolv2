'use client';

import { BagPosition } from '@/types';
import { getCategoryBreakdown, getDiversificationScore, CATEGORY_COLORS } from '@/lib/categorize';

interface DiversificationScoreProps {
  composition: BagPosition[];
}

export function DiversificationScore({ composition }: DiversificationScoreProps) {
  const breakdown = getCategoryBreakdown(composition);
  const score = getDiversificationScore(composition);

  const size = 120;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  let offsetSoFar = 0;
  const segments = breakdown.map((b) => {
    const dash = (b.weight / 100) * circumference;
    const segment = { ...b, dashArray: `${dash} ${circumference - dash}`, dashOffset: -offsetSoFar };
    offsetSoFar += dash;
    return segment;
  });

  return (
    <div className="diversification-card">
      <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={stroke}
          />
          {segments.map((seg) => (
            <circle
              key={seg.category}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={CATEGORY_COLORS[seg.category]}
              strokeWidth={stroke}
              strokeDasharray={seg.dashArray}
              strokeDashoffset={seg.dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              strokeLinecap="butt"
            />
          ))}
        </svg>
        <div
          className="diversification-score-badge"
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
        >
          <span className="num">{score}</span>
          <span className="lbl">Score</span>
        </div>
      </div>

      <div className="diversification-legend">
        <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 4 }}>
          Diversification breakdown
        </div>
        {breakdown.map((b) => (
          <div className="diversification-legend-row" key={b.category}>
            <span className="swatch" style={{ background: CATEGORY_COLORS[b.category] }} />
            <span>{b.category}</span>
            <span className="pct">{b.weight}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
