'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertTriangle, Wallet } from 'lucide-react';
import { formatDecimalStringUsd, formatRawAmount, parseDecimalToRaw } from '@/lib/format';
import { useWallet } from '@/lib/wallet-context';
import { useRedeemExecution } from '@/hooks/use-redeem-execution';

// -----------------------------------------------------------------------------
// Phase 21 — Redeem Preview + real, wallet-signed redemption. Exit-side
// counterpart to PurchasePreviewModal.tsx — same non-negotiables: UI
// computes nothing itself (every number comes from the server response —
// see app/api/bags/[id]/redeem-preview/route.ts and lib/server/
// redeem-execution.ts for where the actual math lives), and every raw-unit
// display goes through lib/format.ts's helpers, never `Number(...)`.
//
// One structural difference from the deposit modal: this preview is
// inherently about THIS depositor's own position (see redeem/
// allocation.ts's module doc — there is no pooled vault a generic "redeem
// preview" could be computed against), so both the GET (load position) and
// POST (quote a specific amount) calls require the session's own cookie
// and return 401 rather than a hypothetical result for someone not signed
// in — reflected here by gating the whole form behind "signed in AND has a
// position", not just behind "signed in" the way the deposit side only
// needs a connected wallet to preview (anyone can preview a hypothetical
// deposit; only an actual depositor can preview redeeming their own
// position).
// -----------------------------------------------------------------------------

interface OutputAssetOption {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

interface PositionView {
  sharesRaw: string;
  shareDecimals: number;
  costBasisQuote: string;
}

interface RedeemAllocationView {
  symbol: string;
  sellQuantityRaw: string;
  decimals: number;
  isOutputAsset: boolean;
}

interface RedeemPreviewResponse {
  outputSymbol: string;
  redeemQuote: { sharesRaw: string; shareDecimals: number; sharePrice: string; grossValue: string };
  allocation: RedeemAllocationView[];
}

interface RedeemPreviewModalProps {
  bagId: string;
  bagName: string;
  onClose: () => void;
}

export function RedeemPreviewModal({ bagId, bagName, onClose }: RedeemPreviewModalProps) {
  const [position, setPosition] = useState<PositionView | null>(null);
  const [outputAssets, setOutputAssets] = useState<OutputAssetOption[] | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [loadingPosition, setLoadingPosition] = useState(true);
  const [positionError, setPositionError] = useState<string | null>(null);

  const [sharesInput, setSharesInput] = useState('');
  const [isMax, setIsMax] = useState(false);

  const [preview, setPreview] = useState<RedeemPreviewResponse | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const wallet = useWallet();
  const execution = useRedeemExecution();
  const isExecuting = execution.state.phase !== 'idle' && execution.state.phase !== 'failed';

  useEffect(() => {
    let cancelled = false;
    setLoadingPosition(true);
    setPositionError(null);
    fetch(`/api/bags/${bagId}/redeem-preview`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`);
        return res.json() as Promise<{ position: PositionView; outputAssets: OutputAssetOption[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setPosition(data.position);
        setOutputAssets(data.outputAssets);
        setSelectedAssetId(data.outputAssets[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setPositionError(err instanceof Error ? err.message : 'Unable to load your position.');
      })
      .finally(() => {
        if (!cancelled) setLoadingPosition(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bagId]);

  const sharesToRedeemRaw = useMemo(() => {
    if (!position) return null;
    if (isMax) return position.sharesRaw;
    return parseDecimalToRaw(sharesInput, position.shareDecimals);
  }, [position, isMax, sharesInput]);

  // Recompute the preview whenever the redeem amount/output asset changes.
  useEffect(() => {
    if (!selectedAssetId || !sharesToRedeemRaw || sharesToRedeemRaw === '0') {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setCalculating(true);
    setPreviewError(null);

    const timer = setTimeout(() => {
      fetch(`/api/bags/${bagId}/redeem-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sharesToRedeemRaw, outputAssetId: selectedAssetId }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          if (!res.ok) throw new Error(body?.error ?? 'Unable to calculate redemption.');
          return body.preview as RedeemPreviewResponse;
        })
        .then((data) => {
          if (cancelled) return;
          setPreview(data);
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : 'Unable to calculate redemption.');
        })
        .finally(() => {
          if (!cancelled) setCalculating(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bagId, selectedAssetId, sharesToRedeemRaw]);

  const hasNoPosition = position !== null && position.sharesRaw === '0';
  const maxSharesDisplay = position ? formatRawAmount(position.sharesRaw, position.shareDecimals, { maxFractionDigits: 6 }) : null;

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        style={{
          background: 'var(--surface, #0D0D0D)',
          border: '1px solid var(--line, rgba(217,185,139,0.16))',
          borderRadius: 16,
          padding: 24,
          width: '100%',
          maxWidth: 460,
          color: 'var(--ink, #F6F3EC)',
          fontFamily: 'var(--font-inter), sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Redeem {bagName}</h3>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-soft, #B4AEA2)' }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)', marginBottom: 18 }}>
          {isExecuting || execution.state.phase === 'completed'
            ? 'This redemption sells your own holdings via a real, on-chain LI.FI route signed by your wallet.'
            : 'Redeeming sells the underlying assets your deposits actually hold, then sends the proceeds to your wallet.'}
        </p>

        {loadingPosition && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-soft, #B4AEA2)', fontSize: 12.5, marginBottom: 14 }}>
            <Loader2 size={14} className="spin" /> Loading your position…
          </div>
        )}

        {positionError && (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(226,125,96,0.4)',
              background: 'rgba(226,125,96,0.08)',
              color: '#E27D60',
              fontSize: 12.5,
              marginBottom: 14,
            }}
          >
            {positionError}
          </div>
        )}

        {hasNoPosition && !positionError && (
          <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line-soft, rgba(255,255,255,0.08))', fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)', marginBottom: 14 }}>
            You have no position in this Bag to redeem.
          </div>
        )}

        {position && !hasNoPosition && (
          <>
            {/* Shares to redeem */}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-soft, #B4AEA2)' }}>
                Shares to Redeem
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--ink-soft, #B4AEA2)' }}>You hold {maxSharesDisplay}</span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
                borderRadius: 10,
                padding: '10px 14px',
                marginBottom: 14,
                opacity: isExecuting ? 0.6 : 1,
              }}
            >
              <input
                type="text"
                inputMode="decimal"
                value={isMax ? maxSharesDisplay ?? '' : sharesInput}
                disabled={isExecuting}
                onChange={(e) => {
                  setIsMax(false);
                  setSharesInput(e.target.value.replace(/[^0-9.]/g, ''));
                }}
                placeholder="0"
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--ink, #F6F3EC)',
                  fontSize: 20,
                  fontWeight: 600,
                  minWidth: 0,
                }}
              />
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsMax(true);
                }}
                disabled={isExecuting}
                style={{
                  background: 'var(--gold-tint, rgba(217,185,139,0.1))',
                  border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
                  borderRadius: 8,
                  padding: '6px 10px',
                  color: 'var(--gold-lt, #F0DFC0)',
                  fontWeight: 600,
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                Max
              </button>
            </div>

            {/* Redeem into */}
            <div style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-soft, #B4AEA2)' }}>
              Redeem Into
            </div>
            <div style={{ marginBottom: 14 }}>
              {outputAssets && outputAssets.length > 0 ? (
                <select
                  value={selectedAssetId ?? ''}
                  disabled={isExecuting}
                  onChange={(e) => setSelectedAssetId(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--gold-tint, rgba(217,185,139,0.1))',
                    border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
                    borderRadius: 8,
                    padding: '8px 10px',
                    color: 'var(--gold-lt, #F0DFC0)',
                    fontWeight: 600,
                    fontSize: 13.5,
                  }}
                >
                  {outputAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.symbol} — {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>No verified output assets</span>
              )}
            </div>

            {previewError && (
              <div
                role="alert"
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(226,125,96,0.4)',
                  background: 'rgba(226,125,96,0.08)',
                  color: '#E27D60',
                  fontSize: 12.5,
                  marginBottom: 14,
                }}
              >
                {previewError}
              </div>
            )}

            {calculating && !preview && !previewError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-soft, #B4AEA2)', fontSize: 12.5, marginBottom: 14 }}>
                <Loader2 size={14} className="spin" /> Calculating…
              </div>
            )}

            {preview && !previewError && (
              <>
                <div style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-soft, #B4AEA2)' }}>
                  What Gets Sold
                </div>
                <div style={{ marginBottom: 14 }}>
                  {preview.allocation.map((a) => (
                    <div
                      key={a.symbol}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 0',
                        fontSize: 13,
                        borderBottom: '1px solid var(--line-soft, rgba(255,255,255,0.06))',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{a.symbol}</span>
                      <span>{formatRawAmount(a.sellQuantityRaw, a.decimals, { maxFractionDigits: 6 })}</span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          letterSpacing: 0.3,
                          padding: '2px 8px',
                          borderRadius: 999,
                          color: a.isOutputAsset ? 'var(--gold-lt, #F0DFC0)' : 'var(--ink-soft, #B4AEA2)',
                          border: `1px solid ${a.isOutputAsset ? 'var(--gold, #D9B98B)' : 'var(--line-soft, rgba(255,255,255,0.1))'}`,
                        }}
                      >
                        {a.isOutputAsset ? 'KEEP' : 'SWAP'}
                      </span>
                    </div>
                  ))}
                  {preview.allocation.length === 0 && (
                    <div style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)', padding: '6px 0' }}>
                      This amount is too small to sell any of your holdings.
                    </div>
                  )}
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: 4,
                    paddingTop: 10,
                    borderTop: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
                  }}
                >
                  <span style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>Estimated Payout</span>
                  <span style={{ fontSize: 18, fontWeight: 700 }}>{formatDecimalStringUsd(preview.redeemQuote.grossValue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>
                  <span>Price per share</span>
                  <span>{formatDecimalStringUsd(preview.redeemQuote.sharePrice)}</span>
                </div>
              </>
            )}
          </>
        )}

        {execution.state.phase !== 'idle' && (
          <RedeemExecutionPanel state={execution.state} outputSymbol={preview?.outputSymbol ?? ''} />
        )}

        {execution.state.phase === 'completed' ? (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            style={primaryButtonStyle}
          >
            Done
          </button>
        ) : hasNoPosition ? null : !wallet.hasProvider ? (
          <button disabled title="Install MetaMask, Coinbase Wallet, or Rabby to redeem" style={disabledButtonStyle}>
            No wallet detected
          </button>
        ) : !wallet.isConnected ? (
          <button onClick={() => wallet.connect()} disabled={wallet.isConnecting} style={primaryButtonStyle}>
            {wallet.isConnecting ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Loader2 size={14} className="spin" /> Connecting…
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Wallet size={15} /> Connect Wallet
              </span>
            )}
          </button>
        ) : !wallet.authUser ? (
          <button onClick={() => wallet.signIn()} disabled={wallet.isSigningIn} style={primaryButtonStyle}>
            {wallet.isSigningIn ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Loader2 size={14} className="spin" /> Confirm in wallet…
              </span>
            ) : (
              'Sign in to continue'
            )}
          </button>
        ) : (
          position &&
          !hasNoPosition && (
            <button
              onClick={() => {
                if (!selectedAssetId || !sharesToRedeemRaw) return;
                void execution.start(bagId, sharesToRedeemRaw, selectedAssetId, wallet.walletAddress);
              }}
              disabled={!preview || !!previewError || calculating || isExecuting || !selectedAssetId || !sharesToRedeemRaw}
              style={{
                ...primaryButtonStyle,
                opacity: !preview || !!previewError || calculating || isExecuting || !selectedAssetId || !sharesToRedeemRaw ? 0.5 : 1,
                cursor: !preview || !!previewError || calculating || isExecuting || !selectedAssetId || !sharesToRedeemRaw ? 'not-allowed' : 'pointer',
              }}
            >
              {isExecuting ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                  <Loader2 size={14} className="spin" /> Redemption in progress…
                </span>
              ) : execution.state.phase === 'failed' ? (
                'Try again'
              ) : (
                'Redeem'
              )}
            </button>
          )
        )}

        {wallet.error && <div style={{ marginTop: 10, fontSize: 12, color: '#E27D60' }}>{wallet.error}</div>}
        {wallet.authError && <div style={{ marginTop: 10, fontSize: 12, color: '#E27D60' }}>{wallet.authError}</div>}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px',
  borderRadius: 10,
  border: 'none',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  background: 'linear-gradient(155deg, var(--gold-lt, #F0DFC0), var(--gold, #D9B98B) 55%, var(--gold-dk, #9C7B49))',
  color: '#0A0805',
};

const disabledButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px',
  borderRadius: 10,
  border: 'none',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'not-allowed',
  opacity: 0.5,
  background: 'linear-gradient(155deg, var(--gold-lt, #F0DFC0), var(--gold, #D9B98B) 55%, var(--gold-dk, #9C7B49))',
  color: '#0A0805',
};

const FAILURE_MESSAGES: Partial<Record<string, string>> = {
  USER_REJECTED: 'You rejected the request in your wallet.',
  INSUFFICIENT_BALANCE: 'Insufficient balance to complete this redemption.',
  INSUFFICIENT_ALLOWANCE: 'Token approval failed or was insufficient.',
  SLIPPAGE_EXCEEDED: 'Price moved beyond the allowed slippage.',
  ROUTE_EXPIRED: 'This quote expired. Start a new redemption.',
  TRANSACTION_REVERTED: 'The transaction reverted on-chain.',
  EXECUTION_TIMEOUT: 'The transaction took too long to confirm.',
  UNSUPPORTED_ROUTE: 'This route is not currently supported.',
  PROVIDER_ERROR: 'The routing provider is temporarily unavailable.',
  VERIFICATION_FAILED: 'Received asset did not match what was quoted — nothing was removed from your position.',
  UNKNOWN_ERROR: 'Something went wrong completing this redemption.',
};

function RedeemExecutionPanel({
  state,
  outputSymbol,
}: {
  state: ReturnType<typeof useRedeemExecution>['state'];
  outputSymbol: string;
}) {
  const swapSteps = state.intent?.steps.filter((s) => s.action === 'SWAP') ?? [];
  const activeSwapIndex = swapSteps.findIndex((s) => s.stepIndex === state.activeStepIndex);

  let label: string;
  if (state.phase === 'creating') label = 'Preparing your redemption…';
  else if (state.phase === 'preparing') label = 'Wallet confirmation required…';
  else if (state.phase === 'awaiting_signature') {
    const step = swapSteps[activeSwapIndex] ?? swapSteps[0];
    const position = swapSteps.length > 1 && activeSwapIndex >= 0 ? ` (${activeSwapIndex + 1}/${swapSteps.length})` : '';
    label = step ? `Confirm sale of ${step.targetSymbol} in your wallet${position}` : 'Confirm in your wallet…';
  } else if (state.phase === 'confirming') label = 'Confirming on-chain…';
  else if (state.phase === 'completed') label = `Redemption complete${outputSymbol ? ` — sent as ${outputSymbol}` : ''}`;
  else if (state.phase === 'failed') label = FAILURE_MESSAGES[state.failureCode ?? ''] ?? state.error ?? 'Redemption failed.';
  else label = '';

  const isError = state.phase === 'failed';
  const isDone = state.phase === 'completed';

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 10,
        marginBottom: 14,
        fontSize: 12.5,
        border: `1px solid ${isError ? 'rgba(226,125,96,0.4)' : isDone ? 'rgba(122,200,140,0.4)' : 'var(--line-soft, rgba(255,255,255,0.08))'}`,
        background: isError ? 'rgba(226,125,96,0.08)' : isDone ? 'rgba(122,200,140,0.08)' : 'var(--gold-tint, rgba(217,185,139,0.06))',
        color: isError ? '#E27D60' : isDone ? '#7AC88C' : 'var(--ink, #F6F3EC)',
      }}
    >
      {isError ? <AlertTriangle size={14} /> : isDone ? <CheckCircle2 size={14} /> : <Loader2 size={14} className="spin" />}
      <span>{label}</span>
    </div>
  );
}
