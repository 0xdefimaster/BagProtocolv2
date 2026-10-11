'use client';

import Link from 'next/link';
import { ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { formatRawAmount, formatTimeAgo, formatReturn, formatUsdCompact } from '@/lib/format';
import type { VerificationState } from '@/lib/domain/proof/protocol-proof';
import type { ProtocolProof } from '@/lib/server/protocol-proof';

// The public proof page's body (app/dashboard/proof/page.tsx), from GET /api/proof.
// Every money figure is a raw on-chain amount formatted with bigint arithmetic.

const STATE_LABEL: Record<VerificationState, string> = {
  VERIFIED: 'Verified on-chain',
  STALE: 'Last verified over 15 min ago',
  PENDING_OUTFLOW: 'Outflow being confirmed',
  UNVERIFIED: 'Not yet verified',
};

const STATE_ORDER: VerificationState[] = ['VERIFIED', 'STALE', 'PENDING_OUTFLOW', 'UNVERIFIED'];

export function StateBadge({ state }: { state: VerificationState }) {
  const ok = state === 'VERIFIED';
  const cls = ok ? 'ok' : state === 'PENDING_OUTFLOW' ? 'warn' : 'muted';
  return (
    <span className={`verify-badge ${cls}`}>
      {ok ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />} {STATE_LABEL[state]}
    </span>
  );
}

const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export function TxLink({ tx }: { tx: { txHash: string; url: string | null } }) {
  if (!tx.url) return <span className="mono">{shortHash(tx.txHash)}</span>;
  return (
    <a href={tx.url} target="_blank" rel="noreferrer" className="mono proof-tx">
      {shortHash(tx.txHash)} <ExternalLink size={11} />
    </a>
  );
}

const amount = (raw: string, decimals: number, symbol: string | null | undefined) => `${formatRawAmount(raw, decimals, { maxFractionDigits: 2, padFraction: true })} ${symbol ?? 'tokens'}`;
const sumRaw = (...values: string[]) => values.reduce((s, v) => s + BigInt(v), BigInt(0)).toString();
const pct = (bps: number) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="leaderboard-card" style={{ marginTop: 20 }}>
      <div className="leaderboard-head">
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}

export function ProofView({ proof }: { proof: ProtocolProof }) {
  const { tvl, executions, money } = proof;
  const verifiedShare = tvl.total > 0 ? Math.floor((tvl.byState.VERIFIED / tvl.total) * 100) : null;
  const finished = (c: typeof executions.purchases) => c.succeeded + c.partial + c.failed;
  const primary = money.find((m) => m.symbol) ?? money[0];

  return (
    <>
      <div className="dash-stats" style={{ marginTop: 28 }}>
        <div className="dash-stat">
          <span className="l">Verified TVL</span>
          <div className="v">${formatUsdCompact(tvl.byState.VERIFIED)}</div>
          <div className="d">
            {verifiedShare === null ? 'No TVL yet' : `${verifiedShare}% of $${formatUsdCompact(tvl.total)} checked against wallets in the last 15 min`}
          </div>
        </div>
        <div className="dash-stat">
          <span className="l">Execution success ({proof.windowDays}d)</span>
          <div className="v">{executions.successRateBps === null ? '—' : pct(executions.successRateBps)}</div>
          <div className="d">
            {finished(executions.purchases)} buys, {finished(executions.redeems)} sells finished
          </div>
        </div>
        <div className="dash-stat">
          <span className="l">Paid to creators</span>
          <div className="v">{primary ? amount(sumRaw(primary.performanceFeesPaidRaw, primary.vaultCreditsRaw.FORK_ROYALTY, primary.vaultCreditsRaw.PERFORMANCE_FEE), primary.decimals, primary.symbol) : '—'}</div>
          <div className="d">Fees paid and royalties credited to creators, all time</div>
        </div>
        <div className="dash-stat">
          <span className="l">Net realized on exits</span>
          <div className="v">{primary && primary.exits.count > 0 ? amount(primary.exits.netRealizedPnlRaw, primary.decimals, primary.symbol) : '—'}</div>
          <div className="d">{primary ? `${primary.exits.count} settled sells, after fees` : 'No settled sells yet'}</div>
        </div>
      </div>

      <Card title="TVL by on-chain verification">
        <div style={{ overflowX: 'auto' }}>
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>State</th>
                <th>TVL</th>
                <th>Bags</th>
              </tr>
            </thead>
            <tbody>
              {STATE_ORDER.map((s) => (
                <tr key={s}>
                  <td>
                    <StateBadge state={s} />
                  </td>
                  <td className="mono">${formatUsdCompact(tvl.byState[s])}</td>
                  <td className="mono">{tvl.bagsByState[s]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Bags">
        {proof.bags.length === 0 ? (
          <div className="positions-empty">No live Bag holds any value yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th>Bag</th>
                  <th>TVL</th>
                  <th>7D</th>
                  <th>30D</th>
                  <th>On-chain</th>
                </tr>
              </thead>
              <tbody>
                {proof.bags.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/dashboard/bag/${b.id}`} className="lb-trader">
                        {b.name}
                      </Link>
                    </td>
                    <td className="mono">${formatUsdCompact(b.tvl)}</td>
                    <td className={`mono lb-pnl ${(b.return7d ?? 0) >= 0 ? 'pos' : 'neg'}`}>{formatReturn(b.return7d)}</td>
                    <td className={`mono lb-pnl ${(b.return30d ?? 0) >= 0 ? 'pos' : 'neg'}`}>{formatReturn(b.return30d)}</td>
                    <td>
                      <StateBadge state={b.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Money flows">
        {money.length === 0 ? (
          <div className="positions-empty">No fee, royalty or settled sell has been recorded on-chain yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th>Figure</th>
                  {money.map((m) => (
                    <th key={m.token}>{m.symbol ?? shortHash(m.token)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Performance fees paid to creators (Settled)', (m) => m.performanceFeesPaidRaw],
                    ['Fork royalties credited (Credited)', (m) => m.vaultCreditsRaw.FORK_ROYALTY],
                    ['Performance fees credited to vault (Credited)', (m) => m.vaultCreditsRaw.PERFORMANCE_FEE],
                    ['Settled sells: gross proceeds', (m) => m.exits.grossProceedsRaw],
                    ['Settled sells: cost basis', (m) => m.exits.costBasisRaw],
                    ['Settled sells: performance fees', (m) => m.exits.feesRaw],
                    ['Settled sells: net realized', (m) => m.exits.netRealizedPnlRaw],
                  ] as [string, (m: ProtocolProof['money'][number]) => string][]
                ).map(([label, pick]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    {money.map((m) => (
                      <td key={m.token} className="mono">
                        {formatRawAmount(pick(m), m.decimals, { maxFractionDigits: 2, padFraction: true })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Latest transactions">
        {proof.recent.length === 0 ? (
          <div className="positions-empty">No transaction recorded yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Bag</th>
                  <th>Result</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {proof.recent.map((e) => (
                  <tr key={`${e.type}:${e.tx.txHash}:${e.bagId}`}>
                    <td className="mono">{formatTimeAgo(e.at)}</td>
                    <td>
                      {e.type === 'EXECUTION'
                        ? e.kind === 'PURCHASE'
                          ? 'Buy'
                          : 'Sell'
                        : e.type === 'FEE_PAID'
                          ? 'Performance fee paid'
                          : e.rewardType === 'FORK_ROYALTY'
                            ? 'Fork royalty credited'
                            : 'Performance fee credited'}
                    </td>
                    <td>
                      {e.bagName ? (
                        <Link href={`/dashboard/bag/${e.bagId}`} className="lb-trader">
                          {e.bagName}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--mute)' }}>Unlisted Bag</span>
                      )}
                    </td>
                    <td className="mono">{e.type === 'EXECUTION' ? e.outcome.toLowerCase() : amount(e.amountRaw, e.decimals, e.symbol)}</td>
                    <td>
                      <TxLink tx={e.tx} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {proof.truncated.length > 0 && (
        <p className="mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 12 }}>
          Totals for {proof.truncated.join(', ')} cover the most recent records only.
        </p>
      )}
    </>
  );
}
