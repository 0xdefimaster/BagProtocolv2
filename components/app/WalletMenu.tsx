'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LogOut, RefreshCw } from 'lucide-react';
import { useWallet, shortenAddress } from '@/lib/wallet-context';

/**
 * The connected-wallet pill and its menu: the full address, "Switch account" and "Disconnect".
 * A wallet does not tell a site when the user selects an account the site is not connected to, so the
 * menu says how to switch instead of the site guessing.
 */
export function WalletMenu() {
  const { walletAddress, disconnect, switchAccount } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the address is still shown in full.
    }
  };

  return (
    <div className="wallet-menu" ref={rootRef}>
      <button type="button" className="wallet-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--emerald)' }} />
        {shortenAddress(walletAddress)}
      </button>
      {open && (
        <div className="wallet-menu-panel" role="menu">
          <div className="wallet-menu-label">Connected account</div>
          <button type="button" className="wallet-menu-address mono" onClick={copy} title="Copy address">
            <span>{walletAddress}</span>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button
            type="button"
            role="menuitem"
            className="wallet-menu-item"
            onClick={() => {
              setOpen(false);
              void switchAccount();
            }}
          >
            <RefreshCw size={14} /> Switch account
          </button>
          <button
            type="button"
            role="menuitem"
            className="wallet-menu-item"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
          >
            <LogOut size={14} /> Disconnect
          </button>
          <p className="wallet-menu-hint">
            Picked another account in your wallet and this site still shows the old one? Wallets only share accounts you
            connected: use Switch account, or Disconnect and connect again, and the wallet asks which account to use.
          </p>
        </div>
      )}
    </div>
  );
}
