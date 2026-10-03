'use client';

import { useEffect } from 'react';
import { Loader2, Wallet, X } from 'lucide-react';
import type { WalletOption } from '@/lib/wallet/eth-provider';

interface WalletPickerProps {
  open: boolean;
  wallets: WalletOption[];
  connecting: boolean;
  error: string | null;
  onPick: (wallet: WalletOption) => void;
  onClose: () => void;
}

const INSTALL_LINKS = [
  { name: 'MetaMask', href: 'https://metamask.io/download' },
  { name: 'Rabby', href: 'https://rabby.io' },
  { name: 'Coinbase Wallet', href: 'https://www.coinbase.com/wallet/downloads' },
];

/**
 * "Connect Wallet" opens this instead of prompting a wallet straight away: it
 * lists the wallets installed in the browser and only the one the user clicks
 * is asked to connect.
 */
export function WalletPicker({ open, wallets, connecting, error, onPick, onClose }: WalletPickerProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="wallet-picker-backdrop" onClick={onClose}>
      <div className="wallet-picker" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-picker-head">
          <span>Connect a wallet</span>
          <button type="button" onClick={onClose} aria-label="Close" className="wallet-picker-close">
            <X size={16} />
          </button>
        </div>

        {wallets.length > 0 ? (
          <ul className="wallet-picker-list">
            {wallets.map((w) => (
              <li key={w.id}>
                <button type="button" disabled={connecting} onClick={() => onPick(w)} className="wallet-picker-item">
                  {w.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element -- data: URI from the wallet's own announcement
                    <img src={w.icon} alt="" width={28} height={28} />
                  ) : (
                    <span className="wallet-picker-icon-fallback">
                      <Wallet size={16} />
                    </span>
                  )}
                  <span>{w.name}</span>
                  {connecting && <Loader2 size={14} className="animate-spin" style={{ marginLeft: 'auto' }} />}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="wallet-picker-empty">
            <p>No wallet found in this browser. Install one, then refresh:</p>
            <ul>
              {INSTALL_LINKS.map((l) => (
                <li key={l.name}>
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.name} →
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="wallet-picker-error">{error}</p>}
        <p className="wallet-picker-note">Connecting only shares your address. Nothing is signed or sent until you confirm it in your wallet.</p>
      </div>
    </div>
  );
}
