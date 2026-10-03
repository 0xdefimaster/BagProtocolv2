'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bag, BagPerformance, NavSnapshotPoint } from '@/types';
import { TIME_RANGES, TimeRange, generatePerformanceSeries } from '@/lib/performance-series';
import { RECORDED_RANGES, RecordedRange, recordedSeries } from '@/lib/performance-recorded';

interface PerformanceTimelineProps {
  bag: Bag;
}

// Live Bags (they carry `performanceRecorded`) are drawn from RECORDED NAV
// snapshots (bag_nav_snapshots) — real values only, nothing interpolated.
// Demo/mock Bags without recorded history but with reported 7D/30D/YTD
// figures keep the illustrative curve (generatePerformanceSeries draws a
// deterministic shape between those figures), labelled as such.
export function PerformanceTimeline({ bag }: PerformanceTimelineProps) {
  if (bag.performanceRecorded) return <RecordedPerformanceTimeline bag={bag} />;
  const hasReportedReturns = bag.performance7d !== 0 || bag.performance30d !== 0 || bag.performanceYtd !== 0;
  if (!hasReportedReturns) {
    return (
      <div className="perf-timeline">
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }} role="status">
          No performance history is recorded for this Bag yet.
        </p>
      </div>
    );
  }
  return <IllustrativePerformanceTimeline bag={bag} />;
}

function IllustrativePerformanceTimeline({ bag }: PerformanceTimelineProps) {
  const [range, setRange] = useState<TimeRange>('30D');

  const series = useMemo(
    () =>
      generatePerformanceSeries(
        bag.id,
        range,
        bag.performance7d,
        bag.performance30d,
        bag.performanceYtd
      ),
    [bag.id, range, bag.performance7d, bag.performance30d, bag.performanceYtd]
  );

  const isPositive = series.changePct >= 0;
  const width = 640;
  const height = 200;
  const padding = 10;

  const values = series.points.map((p) => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;

  const coords = series.points.map((p, i) => {
    const x = padding + (i / (series.points.length - 1)) * (width - padding * 2);
    const y = height - padding - ((p.value - min) / span) * (height - padding * 2);
    return { x, y };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const zeroY = height - padding - ((0 - min) / span) * (height - padding * 2);
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${height - padding} L ${padding} ${height - padding} Z`;

  const lineColor = isPositive ? '#00D084' : '#E0847A';

  return (
    <div className="perf-timeline">
      <div className="perf-range-row">
        {TIME_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={range === r}
            className={`perf-range-btn ${range === r ? 'active' : ''}`}
            onClick={() => setRange(r)}
          >
            {r === 'ALL' ? 'All Time' : r}
          </button>
        ))}
      </div>

      <div className="perf-headline">
        <span className={`val ${isPositive ? 'pos' : 'neg'}`}>
          {isPositive ? '+' : ''}
          {series.changePct.toFixed(2)}%
        </span>
        <span className="sub">{range === 'ALL' ? 'since inception' : `past ${range.toLowerCase()}`}</span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${bag.id}-${range}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={padding} y1={zeroY} x2={width - padding} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
        <path d={areaPath} fill={`url(#grad-${bag.id}-${range})`} stroke="none" />
        <path d={linePath} fill="none" stroke={lineColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      <p style={{ color: 'var(--mute)', fontSize: 12, margin: '8px 0 12px' }}>
        Illustrative curve — interpolated between the reported 7D / 30D / YTD returns, not a recorded price history.
      </p>
      <div className="perf-stats-row">
        <div className="perf-stat">
          High
          <b>+{series.high.toFixed(2)}%</b>
        </div>
        <div className="perf-stat">
          Low
          <b>{series.low.toFixed(2)}%</b>
        </div>
        <div className="perf-stat">
          TVL
          <b>${bag.tvl.toLocaleString()}</b>
        </div>
      </div>
    </div>
  );
}

const fmtPct = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const fmtUsd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
const fmtWhen = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function RecordedPerformanceTimeline({ bag }: PerformanceTimelineProps) {
  const [data, setData] = useState<{ points: NavSnapshotPoint[]; performance: BagPerformance } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RecordedRange>('ALL');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bags/${bag.id}/performance`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
    // Refetch when the TVL changes (a purchase/redemption was just accounted).
  }, [bag.id, bag.tvl]);

  const series = useMemo(() => (data ? recordedSeries(data.points, range) : null), [data, range]);

  if (error) {
    return (
      <div className="perf-timeline">
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }} role="status">Performance history could not be loaded: {error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="perf-timeline">
        <p style={{ color: 'var(--mute)', fontSize: 13.5 }} role="status">Loading performance history…</p>
      </div>
    );
  }

  const width = 640;
  const height = 200;
  const pad = 10;
  let chart: React.ReactNode = null;
  if (series) {
    const t0 = series.points[0].t;
    const t1 = series.points[series.points.length - 1].t;
    const spanT = t1 - t0 || 1;
    const spanV = series.high - series.low || series.high * 0.01 || 1;
    const lo = series.low - spanV * 0.1;
    const hi = series.high + spanV * 0.1;
    const x = (t: number) => pad + ((t - t0) / spanT) * (width - pad * 2);
    const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
    const line = series.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const area = `${line} L ${x(t1).toFixed(1)} ${height - pad} L ${x(t0).toFixed(1)} ${height - pad} Z`;
    const baseY = y(series.points[0].value);
    const color = series.changePct >= 0 ? '#00D084' : '#E0847A';
    const gradId = `rec-grad-${bag.id}-${range}`;
    chart = (
      <>
        <div className="perf-headline">
          <span className={`val ${series.changePct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(series.changePct)}</span>
          <span className="sub">
            NAV per share {fmtUsd(series.points[0].value)} → {fmtUsd(series.points[series.points.length - 1].value)} · {fmtWhen(t0)} – {fmtWhen(t1)}
          </span>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" preserveAspectRatio="none" role="img" aria-label={`NAV per share, ${fmtPct(series.changePct)}`}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Dashed line = the value at the start of the window: above it is gain, below it is loss. */}
          <line x1={pad} y1={baseY} x2={width - pad} y2={baseY} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
          <path d={area} fill={`url(#${gradId})`} stroke="none" />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="perf-stats-row">
          <div className="perf-stat">
            High<b>{fmtUsd(series.high)}</b>
          </div>
          <div className="perf-stat">
            Low<b>{fmtUsd(series.low)}</b>
          </div>
          <div className="perf-stat">
            Change<b style={{ color: series.changeAbs >= 0 ? 'var(--emerald)' : '#E0847A' }}>{`${series.changeAbs >= 0 ? '+' : '-'}${fmtUsd(Math.abs(series.changeAbs))}`} per share</b>
          </div>
        </div>
      </>
    );
  }

  const perf = data.performance;
  const rows: [string, number | null][] = [
    ['7 days', perf['7D']],
    ['30 days', perf['30D']],
    ['Year to date', perf.YTD],
    ['Since first record', perf.sinceFirst],
  ];

  return (
    <div className="perf-timeline">
      <div className="perf-range-row">
        {RECORDED_RANGES.map((r) => (
          <button key={r} type="button" aria-pressed={range === r} className={`perf-range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
            {r === 'ALL' ? 'All Time' : r}
          </button>
        ))}
      </div>

      {chart ?? (
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, margin: '12px 0' }} role="status">
          {data.points.length < 2
            ? 'Performance history starts recording now — the chart appears once there are two snapshots.'
            : 'No recorded snapshots in this range yet.'}
        </p>
      )}

      <table className="perf-gain-table" style={{ width: '100%', marginTop: 18, borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ color: 'var(--mute)', textAlign: 'left' }}>
            <th style={{ padding: '6px 0', fontWeight: 500 }}>Period</th>
            <th style={{ padding: '6px 0', fontWeight: 500, textAlign: 'right' }}>Gain / loss (NAV per share)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, pct]) => (
            <tr key={label} style={{ borderTop: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '8px 0' }}>{label}</td>
              <td style={{ padding: '8px 0', textAlign: 'right', fontWeight: 600, color: pct === null ? 'var(--mute)' : pct >= 0 ? 'var(--emerald)' : '#E0847A' }}>
                {pct === null ? 'Not enough history' : fmtPct(pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: 'var(--mute)', fontSize: 12, marginTop: 10 }}>
        Recorded from this Bag&apos;s live NAV{perf.firstSnapshotAt ? ` since ${new Date(perf.firstSnapshotAt).toLocaleString()}` : ''} ({perf.snapshots} snapshot{perf.snapshots === 1 ? '' : 's'}). Deposits and redemptions change TVL but not NAV per share, so these figures show the holdings&apos; performance.
      </p>
    </div>
  );
}
