'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/lib/wallet-context';
import { useDeployBag } from '@/hooks/use-deploy-bag';
import { useStrategyRegistration, type RegistrationOutcome } from '@/hooks/use-strategy-registration';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';

// -----------------------------------------------------------------------------
// Shown on a DRAFT bag's own page, owner-only (the page itself already
// enforces that — see app/dashboard/bag/[id]/page.tsx). Drives the ONLY
// production deployment path: prepare -> the creator's own wallet signs and
// sends `createBag` -> confirm. The Bag only becomes ACTIVE after the server
// independently verifies the transaction on-chain; nothing here marks it
// deployed itself.
//
// The protocol creation fee (BagFactory.creationFee, native ETH) is shown up
// front and sent as the createBag transaction's value — one signature. The creator can also opt into a launch
// buy: once the deployment is verified, `onDeployed` hands the amount back so
// the page opens the normal purchase flow prefilled (a separate, ordinary
// purchase — the deploy transaction itself never buys anything).
//
// One flow after the creator presses Deploy: deploy → register v1 in the on-chain StrategyRegistry (a second
// wallet confirmation, prompted right away) → the launch buy. Each step is still signed by the creator's wallet;
// a skipped or rejected registration does not stop the buy (the Passport tab offers it again).
// -----------------------------------------------------------------------------

interface DeployBagPanelProps {
  bagId: string;
  bagName: string;
  chain: string;
  /** Called once the deployment is verified; `launchBuyAmount` is set when the creator opted into a launch buy. */
  onDeployed?: (launchBuyAmount?: string) => void;
  /** Open the deploy wallet prompt as soon as the panel mounts (the Create page's one-click launch). */
  autoStart?: boolean;
  /** Launch-buy amount chosen elsewhere (the Create page); when set, the panel's own launch-buy input is hidden. */
  presetLaunchBuy?: string;
  /** Register v1 in the StrategyRegistry right after the deployment (default on). */
  registerAfterDeploy?: boolean;
}

type AfterDeployStep = 'registering' | RegistrationOutcome | null;

interface CreationFeeView {
  amountWei: string;
}

/** Wei -> "0.00015 ETH", exact, trailing zeros trimmed. */
function formatFee(fee: CreationFeeView): string {
  const wei = BigInt(fee.amountWei);
  const base = BigInt(10) ** BigInt(18);
  const frac = (wei % base).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wei / base}${frac ? `.${frac}` : ''} ETH`;
}

export function DeployBagPanel({ bagId, bagName, chain, onDeployed, autoStart, presetLaunchBuy, registerAfterDeploy = true }: DeployBagPanelProps) {
  const { isConnected, walletAddress, connect } = useWallet();
  const { state, deploy, resumePending, cancel } = useDeployBag(bagId);
  const registration = useStrategyRegistration(bagId);
  const [afterDeploy, setAfterDeploy] = useState<AfterDeployStep>(null);
  const resumedRef = useRef(false);
  const [fee, setFee] = useState<CreationFeeView | null>(null);
  const [launchBuy, setLaunchBuy] = useState(presetLaunchBuy !== undefined && Number(presetLaunchBuy) > 0);
  const [launchBuyAmount, setLaunchBuyAmount] = useState(presetLaunchBuy ?? '100');
  const launchBuyControlled = presetLaunchBuy !== undefined;
  const launchBuyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deploy/creation-fee?chain=${encodeURIComponent(chain)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof body.amountWei === 'string') setFee({ amountWei: body.amountWei });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chain]);

  // Arrived from the Create page (`?deploy=1[&buy=100]`): publishing IS
  // deploying, so open the wallet prompt right away instead of making the
  // creator press Deploy again. Armed only once, and the query is removed so
  // a refresh never re-prompts.
  const [autoDeployArmed, setAutoDeployArmed] = useState(false);

  // On mount, silently pick back up a transaction that was sent but never
  // confirmed (e.g. the person refreshed or navigated away mid-flow) —
  // without prompting another signature. Only when there is nothing to
  // resume does a `?deploy=1` arm the automatic deploy.
  useEffect(() => {
    if (!resumedRef.current) {
      resumedRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const wantsDeploy = autoStart === true || params.get('deploy') === '1';
      const buy = params.get('buy');
      if (wantsDeploy) {
        if (buy && /^\d+(\.\d+)?$/.test(buy) && Number(buy) > 0) {
          setLaunchBuy(true);
          setLaunchBuyAmount(buy);
        }
        params.delete('deploy');
        params.delete('buy');
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
      }
      void resumePending().then((resumed) => {
        if (!resumed && wantsDeploy) setAutoDeployArmed(true);
      });
    }
    return () => cancel();
    // autoStart is read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumePending, cancel]);

  // Fired once per deployment — callers may pass an inline callback that
  // changes every render, which must not re-trigger it. The registration runs
  // first: `onDeployed` refreshes the page, which unmounts this (DRAFT-only) panel.
  const deployedNotifiedRef = useRef(false);
  const onDeployedRef = useRef(onDeployed);
  useEffect(() => {
    onDeployedRef.current = onDeployed;
  }, [onDeployed]);
  useEffect(() => {
    if (state.phase !== 'completed' || deployedNotifiedRef.current) return;
    deployedNotifiedRef.current = true;
    const launch = launchBuyRef.current;
    if (!registerAfterDeploy || !walletAddress) {
      onDeployedRef.current?.(launch);
      return;
    }
    setAfterDeploy('registering');
    void registration.register(walletAddress).then((outcome) => {
      setAfterDeploy(outcome);
      onDeployedRef.current?.(launch);
    });
    // Once per deployment; the wallet and registration hook are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const startDeploy = () => {
    launchBuyRef.current = launchBuy ? launchBuyAmount.trim() : undefined;
    void deploy(walletAddress);
  };

  useEffect(() => {
    if (!autoDeployArmed || !isConnected || !walletAddress || state.phase !== 'idle') return;
    setAutoDeployArmed(false);
    startDeploy();
    // startDeploy reads the latest launch-buy state; it only needs to fire once when armed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDeployArmed, isConnected, walletAddress, state.phase]);

  if (state.phase === 'completed') {
    return (
      <div className="deploy-panel deploy-panel-done">
        <CheckCircle2 size={18} color="var(--accent, #7fbf7f)" />
        <div>
          <p style={{ fontWeight: 600 }}>Deployed on-chain</p>
          <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
            &ldquo;{bagName}&rdquo; is live. Contract {state.deployment?.contractAddress}
          </p>
          {afterDeploy && (
            <p data-testid="deploy-registration-step" style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 4 }}>
              {afterDeploy === 'registering'
                ? registration.phase === 'awaiting_signature'
                  ? 'Next: confirm the on-chain registry entry in your wallet (verifiable by anyone)…'
                  : 'Registering v1 in the on-chain strategy registry…'
                : afterDeploy === 'completed'
                  ? 'Registered on-chain: anyone can verify this strategy.'
                  : 'Not registered on-chain yet; you can do it any time from the Passport & verification tab.'}
            </p>
          )}
        </div>
      </div>
    );
  }

  const busy = state.phase === 'preparing' || state.phase === 'awaiting_signature' || state.phase === 'confirming';
  const feeIsSet = fee !== null && fee.amountWei !== '0';
  const launchAmountValid = !launchBuy || (/^\d+(\.\d+)?$/.test(launchBuyAmount.trim()) && Number(launchBuyAmount) > 0);


  const statusLine = () => {
    switch (state.phase) {
      case 'preparing':
        return 'Preparing transaction…';
      case 'awaiting_signature':
        return 'Confirm the transaction in your wallet…';
      case 'confirming':
        return state.pending ? 'Waiting for the transaction to be mined…' : 'Verifying on-chain…';
      default:
        return null;
    }
  };

  return (
    <div className="deploy-panel">
      <p style={{ fontWeight: 600, marginBottom: 4 }}>This bag isn&apos;t live yet</p>
      <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: 12 }}>
        Deploy &ldquo;{bagName}&rdquo; on-chain from your own wallet to make it visible and investable.
      </p>

      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
        Protocol creation fee:{' '}
        <strong style={{ color: 'var(--ink)' }}>{fee === null ? '…' : feeIsSet ? formatFee(fee) : 'none'}</strong>
        {feeIsSet && ' — included in the deploy transaction and sent to the protocol treasury. One signature.'}
      </p>

      {!launchBuyControlled && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: launchBuy ? 8 : 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={launchBuy} disabled={busy} onChange={(e) => setLaunchBuy(e.target.checked)} />
            Be the first buyer — buy into this bag right after it&apos;s deployed
          </label>
          {launchBuy && (
            <div className="invest-input-row" style={{ marginBottom: 12, maxWidth: 220 }}>
              <span className="dollar">$</span>
              <input
                type="number"
                min={0}
                value={launchBuyAmount}
                disabled={busy}
                onChange={(e) => setLaunchBuyAmount(e.target.value)}
              />
            </div>
          )}
        </>
      )}

      {state.error && (
        <div className="deploy-panel-error" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
          <AlertTriangle size={15} color="#E0847A" style={{ flexShrink: 0, marginTop: 2 }} />
          <p style={{ color: '#E0847A', fontSize: 13 }}>{state.error}</p>
        </div>
      )}

      {statusLine() && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
          <Loader2 size={14} className="spin" /> {statusLine()}
        </p>
      )}

      {!isConnected ? (
        <button className="btn btn-primary" onClick={connect}>
          Connect wallet to deploy
        </button>
      ) : (
        <button className="btn btn-primary" disabled={busy || !launchAmountValid} onClick={startDeploy}>
          {busy ? 'Deploying…' : state.phase === 'failed' ? 'Try again' : launchBuy ? 'Deploy & buy' : 'Deploy on-chain'}
        </button>
      )}
    </div>
  );
}
