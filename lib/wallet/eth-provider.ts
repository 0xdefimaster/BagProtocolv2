// -----------------------------------------------------------------------------
// The browser wallet the user chose, shared by everything that signs.
//
// Wallets announce themselves through EIP-6963 (MetaMask, Rabby, Coinbase
// Wallet, OKX, Phantom, ... each with its own name and icon), so the user can
// pick one instead of whichever extension happened to win `window.ethereum`.
// `getEthereumProvider()` returns the chosen wallet, falling back to
// `window.ethereum` for older wallets that don't announce themselves.
// WalletConnect is added to the list when it is configured.
// -----------------------------------------------------------------------------

import { withChainFeeHints } from './chain-fees';
import { getWalletConnectOption } from './walletconnect';

/** Minimal EIP-1193 provider — what every injected wallet exposes. */
export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  /** Ends the wallet's session, for wallets that keep one (WalletConnect). */
  disconnect?: () => Promise<void>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/** One wallet the user can connect. `id` is stable across reloads (EIP-6963 rdns, or 'injected'). */
export interface WalletOption {
  id: string;
  name: string;
  /** Data URI from the wallet's own announcement, when it gives one. */
  icon: string | null;
  provider: Eip1193Provider;
}

interface Eip6963AnnounceDetail {
  info: { uuid: string; name: string; icon?: string; rdns?: string };
  provider: Eip1193Provider;
}

let activeProvider: Eip1193Provider | null = null;

/**
 * The wallet every signing path should talk to: the one the user picked, else `window.ethereum`. Wrapped so a
 * transaction on a chain the wallet has no fee data for carries the chain's real fees (lib/wallet/chain-fees.ts).
 */
export function getEthereumProvider(): Eip1193Provider | undefined {
  const provider = activeProvider ?? (typeof window !== 'undefined' ? window.ethereum : undefined);
  return provider ? withChainFeeHints(provider) : undefined;
}

export function setActiveEthereumProvider(provider: Eip1193Provider | null): void {
  activeProvider = provider;
}

/**
 * Collects the wallets installed in this browser and reports the list each time
 * a new one announces itself. Falls back to a single `window.ethereum` entry
 * when no wallet supports EIP-6963. Returns an unsubscribe function.
 */
export function discoverWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const announced = new Map<string, WalletOption>();

  const publish = () => {
    const list = Array.from(announced.values());
    if (list.length === 0 && window.ethereum) {
      list.push({ id: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: null, provider: window.ethereum });
    }
    const walletConnect = getWalletConnectOption();
    if (walletConnect) list.push(walletConnect);
    onChange(list);
  };

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963AnnounceDetail>).detail;
    if (!detail?.info || !detail.provider) return;
    const id = detail.info.rdns || detail.info.uuid;
    if (announced.has(id)) return;
    const icon = typeof detail.info.icon === 'string' && detail.info.icon.startsWith('data:image/') ? detail.info.icon : null;
    announced.set(id, { id, name: detail.info.name, icon, provider: detail.provider });
    publish();
  };

  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  publish();
  return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
}
