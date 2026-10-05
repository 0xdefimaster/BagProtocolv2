'use client';

import { useEffect, useState } from 'react';
import { formatRawAmount } from '@/lib/format';
import type { ExecutionHistoryResponse, ExecutionOutcome, ExecutionReceipt, ReceiptCheck, ReceiptFieldSource, ReceiptOutput } from '@/types/execution-receipt';
import type { ExecutionProviderKind } from '@/types/strategy-policy';

// -----------------------------------------------------------------------------
// Bag page → Executions: the viewer's own execution receipts
// (GET /api/bags/:id/executions). Unknown values are not shown; a quote is
// never shown as an outcome; each actual amount says where it came from.
// -----------------------------------------------------------------------------

const PROVIDER_LABEL: Record<ExecutionProviderKind, string> = {
  BAG_ROUTER: 'BAG Router',
  LIFI_COMPOSER: 'LI.FI Composer',
  LIFI_SEQUENTIAL: 'LI.FI (one transaction per asset)',
  UNKNOWN: 'Unknown provider',
};
const SOURCE_LABEL: Record<ReceiptFieldSource, string> = {
  ONCHAIN_DERIVED: 'read from the tx receipt',
  PROVIDER_REPORTED: 'reported by LI.FI',
  BAG_RECORDED: 'BAG record',
  EXECUTION_PLAN: 'execution plan',
  BAG_ATTESTED: 'quote',
};
const OUTCOME_LABEL: Record<ExecutionOutcome, string> = { SUCCEEDED: 'Succeeded', PARTIAL: 'Partially filled', FAILED: 'Failed', PENDING: 'Pending', UNKNOWN: 'Unknown' };
const CHECK_LABEL: Record<ReceiptCheck['check'], string> = {
  ACTUAL_AT_LEAST_MINIMUM: 'Received at least the minimum',
  TX_CLAIMED_BY_THIS_EXECUTION: 'Transaction bound to this execution',
  VERSION_BINDING: 'Matches the recorded Bag version',
};
const EXPLORER = 'https://robinhoodchain.blockscout.com/tx/';

const amount = (raw: string | null, decimals: number | null) => (raw === null ? null : decimals === null ? `${raw} (raw)` : formatRawAmount(raw, decimals, { maxFractionDigits: 6 }));
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const symbolOf = (a: { symbol: string | null; address: string }) => a.symbol ?? `${a.address.slice(0, 6)}…`;

function OutputRow({ o, coveredByTotal }: { o: ReceiptOutput; coveredByTotal: boolean }) {
  const symbol = symbolOf(o.asset);
  const sold = o.soldAsset ? amount(o.inputAmountRaw, o.soldAsset.decimals) : null;
  const actual = amount(o.actualRaw, o.asset.decimals);
  const bagMin = amount(o.bagMinimumRaw, o.asset.decimals);
  const providerMin = amount(o.providerEnforcedMinimumRaw, o.asset.decimals);
  const quoted = amount(o.quotedRaw, o.asset.decimals);
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="py-1.5 pr-3 font-medium text-white">
        {o.soldAsset ? (
          <>
            {symbolOf(o.soldAsset)} <span className="text-white/40">→</span> {symbol}
            {sold && <div className="font-mono text-xs font-normal text-white/50">Sold {sold}</div>}
          </>
        ) : (
          symbol
        )}
        {o.action === 'KEEP' && <span className="ml-1 text-xs text-white/40">(kept)</span>}
      </td>
      <td className="py-1.5 pr-3 font-mono text-xs text-white/70">
        {bagMin && <div title="BAG rejected the execution below this amount (checked by BAG's server).">Min (BAG): {bagMin}</div>}
        {providerMin && <div title="Enforced on-chain at LI.FI Composer's swap boundary; not a guarantee of what reached the wallet.">Min (on-chain, swap): {providerMin}</div>}
      </td>
      <td className="py-1.5 font-mono text-xs">
        {actual ? (
          <span className={o.minimumRespected === false ? 'text-red-400' : 'text-white'}>
            {actual} <span className="text-white/40">· {SOURCE_LABEL[o.actualSource!]}</span>
          </span>
        ) : quoted ? (
          <span className="text-white/50">Not completed · quote was {quoted}</span>
        ) : coveredByTotal && o.outcome === 'FILLED' ? (
          <span className="text-white/50" title="Every leg paid the same token in one transaction, so only the total is observable on-chain.">
            In the total below
          </span>
        ) : (
          <span className="text-white/40">Not recorded</span>
        )}
      </td>
    </tr>
  );
}

function Receipt({ r }: { r: ExecutionReceipt }) {
  const executionTx = r.transactions.find((t) => t.role === 'EXECUTION' && t.verification === 'VERIFIED');
  const inputAmount = amount(r.input.amountRaw, r.input.decimals);
  const inputLabel = r.input.asset?.symbol ?? '';
  const total = r.totalReceived;
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-white">{r.kind === 'PURCHASE' ? 'Purchase' : 'Redeem'}</span>
        {r.strategyVersion !== null && <span className="text-sm text-white/60">v{r.strategyVersion}</span>}
        <span className="text-sm text-white/60">{PROVIDER_LABEL[r.provider]}</span>
        <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/60">{OUTCOME_LABEL[r.outcome]}</span>
        <span className="ml-auto text-xs text-white/40">{new Date(r.createdAt).toLocaleString()}</span>
      </div>
      {/* A redeem's shares are a legacy, non-authoritative unit (A4): what was sold is listed per row. */}
      {r.kind === 'PURCHASE' && (
        <div className="mt-2 text-sm text-white/70">
          Input: <span className="font-mono text-white">{inputAmount}</span> {inputLabel}
        </div>
      )}
      <table className="mt-2 w-full text-left">
        <tbody>
          {r.outputs.map((o) => (
            <OutputRow key={o.stepIndex} o={o} coveredByTotal={r.evidence.coveredByTotal > 0} />
          ))}
        </tbody>
      </table>
      {total && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 border-t border-white/10 pt-2 text-sm">
          <span className="text-white/70">Received</span>
          <span className="font-mono text-white">
            {amount(total.actualRaw, total.asset.decimals)} {symbolOf(total.asset)}
          </span>
          <span className="font-mono text-xs text-white/40">· {SOURCE_LABEL[total.actualSource]}</span>
          {total.providerEnforcedMinimumRaw && (
            <span className="font-mono text-xs text-white/50" title="Sum of the on-chain swap minimums; not a guarantee of what reached the wallet.">
              Min (on-chain, swaps): {amount(total.providerEnforcedMinimumRaw, total.asset.decimals)}
            </span>
          )}
        </div>
      )}
      <ul className="mt-3 space-y-0.5 text-xs">
        {r.policyEvaluation.checks
          .filter((c) => c.result !== 'UNKNOWN')
          .map((c) => (
            <li key={c.check} className={c.result === 'PASS' ? 'text-emerald-400' : 'text-red-400'}>
              {c.result === 'PASS' ? '✓' : '✗'} {CHECK_LABEL[c.check]}
            </li>
          ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-white/50">
        {executionTx ? (
          <a href={`${EXPLORER}${executionTx.txHash}`} target="_blank" rel="noreferrer" className="underline">
            Tx {shortHash(executionTx.txHash)}
          </a>
        ) : (
          <span>No verified transaction</span>
        )}
        {r.executionPlanHash && <span title={r.planHashCheckedOnchain ? 'Checked against the on-chain ExecutionCompleted event.' : 'From the compiled plan.'}>Plan {shortHash(r.executionPlanHash)}</span>}
        <span>Policy at execution time is not stored; checks above use recorded data.</span>
      </div>
    </li>
  );
}

export function ExecutionHistory({ bagId }: { bagId: string }) {
  const [executions, setExecutions] = useState<ExecutionReceipt[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  const fetchPage = (cursor: string | null) =>
    fetch(`/api/bags/${encodeURIComponent(bagId)}/executions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { credentials: 'same-origin' }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${res.status}).`), { status: res.status });
      return body as ExecutionHistoryResponse;
    });

  useEffect(() => {
    let cancelled = false;
    setExecutions(null);
    setNextCursor(null);
    setError(null);
    fetchPage(null)
      .then((d) => {
        if (cancelled) return;
        setExecutions(d.executions);
        setNextCursor(d.hasMore ? d.nextCursor : null);
      })
      .catch((err: Error & { status?: number }) => !cancelled && setError({ status: err.status ?? 0, message: err.message }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage only closes over bagId
  }, [bagId]);

  const loadMore = () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    fetchPage(nextCursor)
      .then((d) => {
        setExecutions((prev) => [...(prev ?? []), ...d.executions]);
        setNextCursor(d.hasMore ? d.nextCursor : null);
      })
      .catch((err: Error & { status?: number }) => setError({ status: err.status ?? 0, message: err.message }))
      .finally(() => setLoadingMore(false));
  };

  if (error?.status === 401) return <p className="text-sm text-white/50">Connect and sign in with your wallet to see your executions in this Bag.</p>;
  if (error && !executions) return <p className="text-sm text-red-400">Could not load executions: {error.message}</p>;
  if (!executions) return <p className="text-sm text-white/50">Loading executions…</p>;
  if (executions.length === 0) return <p className="text-sm text-white/50">You have no executions in this Bag yet.</p>;
  return (
    <div>
      <p className="mb-3 text-sm text-white/50">Your purchases and redemptions in this Bag. Only your own executions are shown.</p>
      <ol className="space-y-4">
        {executions.map((r) => (
          <Receipt key={`${r.kind}:${r.executionId}`} r={r} />
        ))}
      </ol>
      {error && <p className="mt-3 text-sm text-red-400">Could not load more: {error.message}</p>}
      {nextCursor && (
        <button type="button" onClick={loadMore} disabled={loadingMore} className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 hover:bg-white/10">
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
