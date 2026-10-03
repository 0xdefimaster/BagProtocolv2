'use client';

import { useEffect, useState } from 'react';
import { formatRawAmount } from '@/lib/format';
import type { ExecutionHistoryResponse, ExecutionReceipt, ReceiptCheck, ReceiptFieldSource, ReceiptOutput } from '@/types/execution-receipt';
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
const CHECK_LABEL: Record<ReceiptCheck['check'], string> = {
  ACTUAL_AT_LEAST_MINIMUM: 'Received at least the minimum',
  TX_CLAIMED_BY_THIS_EXECUTION: 'Transaction bound to this execution',
  VERSION_BINDING: 'Matches the recorded Bag version',
};
const EXPLORER = 'https://robinhoodchain.blockscout.com/tx/';

const amount = (raw: string | null, decimals: number | null) => (raw === null ? null : decimals === null ? `${raw} (raw)` : formatRawAmount(raw, decimals, { maxFractionDigits: 6 }));
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

function OutputRow({ o }: { o: ReceiptOutput }) {
  const symbol = o.asset.symbol ?? `${o.asset.address.slice(0, 6)}…`;
  const actual = amount(o.actualRaw, o.asset.decimals);
  const bagMin = amount(o.bagMinimumRaw, o.asset.decimals);
  const providerMin = amount(o.providerEnforcedMinimumRaw, o.asset.decimals);
  const quoted = amount(o.quotedRaw, o.asset.decimals);
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="py-1.5 pr-3 font-medium text-white">
        {symbol}
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
  const inputLabel = r.input.unit === 'BAG_SHARES' ? 'Bag shares' : (r.input.asset?.symbol ?? '');
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-white">{r.kind === 'PURCHASE' ? 'Purchase' : 'Redeem'}</span>
        {r.strategyVersion !== null && <span className="text-sm text-white/60">v{r.strategyVersion}</span>}
        <span className="text-sm text-white/60">{PROVIDER_LABEL[r.provider]}</span>
        <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/60">{r.status}</span>
        <span className="ml-auto text-xs text-white/40">{new Date(r.createdAt).toLocaleString()}</span>
      </div>
      <div className="mt-2 text-sm text-white/70">
        Input: <span className="font-mono text-white">{inputAmount}</span> {inputLabel}
      </div>
      <table className="mt-2 w-full text-left">
        <tbody>
          {r.outputs.map((o) => (
            <OutputRow key={o.stepIndex} o={o} />
          ))}
        </tbody>
      </table>
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
  const [data, setData] = useState<ExecutionHistoryResponse | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/bags/${encodeURIComponent(bagId)}/executions`, { credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${res.status}).`), { status: res.status });
        return body as ExecutionHistoryResponse;
      })
      .then((d) => !cancelled && setData(d))
      .catch((err: Error & { status?: number }) => !cancelled && setError({ status: err.status ?? 0, message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [bagId]);

  if (error?.status === 401) return <p className="text-sm text-white/50">Connect and sign in with your wallet to see your executions in this Bag.</p>;
  if (error) return <p className="text-sm text-red-400">Could not load executions: {error.message}</p>;
  if (!data) return <p className="text-sm text-white/50">Loading executions…</p>;
  if (data.executions.length === 0) return <p className="text-sm text-white/50">You have no executions in this Bag yet.</p>;
  return (
    <div>
      <p className="mb-3 text-sm text-white/50">Your purchases and redemptions in this Bag. Only your own executions are shown.</p>
      <ol className="space-y-4">
        {data.executions.map((r) => (
          <Receipt key={`${r.kind}:${r.executionId}`} r={r} />
        ))}
      </ol>
    </div>
  );
}
