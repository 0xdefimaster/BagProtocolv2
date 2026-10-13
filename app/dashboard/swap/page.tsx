'use client';

import { useWallet } from '@/lib/wallet-context';
import { WalletAssetsPanel } from '@/components/portfolio/WalletAssetsPanel';

// -----------------------------------------------------------------------------
// Swap — sell one or several tokens in the connected wallet, on Robinhood
// Chain, Ethereum, Arbitrum or Base, for that chain's stablecoin in ONE
// transaction (the same panel as Portfolio's Wallet section,
// components/portfolio/WalletAssetsPanel.tsx). Tokens stay in the user's own
// wallet until the user signs; slippage and price-impact limits are the panel's.
// -----------------------------------------------------------------------------

const STEPS = [
  { n: '01', t: 'Select tokens', b: 'Pick one or several tokens in your wallet.' },
  { n: '02', t: 'One signature', b: 'They are all sold in a single transaction.' },
  { n: '03', t: 'Stablecoin in your wallet', b: 'USDG on Robinhood Chain, USDC on Ethereum, Arbitrum and Base. No deposit, no pool.' },
];

export default function SwapPage() {
  const { isConnected, isConnecting, isSigningIn, authError, connect, signIn, authUser } = useWallet();

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <h1 style={{ marginTop: 16 }}>Swap</h1>
        <p className="lead">Sell several tokens for a stablecoin in one transaction, straight from your wallet — on Robinhood Chain, Ethereum, Arbitrum and Base.</p>
      </div>

      <ol className="swap-steps" style={{ marginTop: 28 }}>
        {STEPS.map((s) => (
          <li key={s.n} className="dash-stat">
            <span className="l mono">{s.n}</span>
            <div className="swap-step-t">{s.t}</div>
            <p className="swap-step-b">{s.b}</p>
          </li>
        ))}
      </ol>

      {authUser ? (
        <WalletAssetsPanel walletAddress={authUser.walletAddress} />
      ) : (
        <div className="create-card" style={{ marginTop: 32, maxWidth: 480 }}>
          <button className="btn btn-primary" onClick={isConnected ? signIn : connect} disabled={isConnecting || isSigningIn}>
            {isConnecting
              ? 'Connecting…'
              : isSigningIn
                ? 'Confirm the signature in your wallet…'
                : isConnected
                  ? 'Sign in with wallet'
                  : 'Connect wallet'}
          </button>
          {authError && <p style={{ color: '#E0847A', fontSize: 13, marginTop: 12 }}>{authError}</p>}
          <p style={{ color: 'var(--ink-soft)', fontSize: 12.5, marginTop: 12 }}>
            Signing in is free — it&apos;s a message signature, not a transaction, and never costs gas.
          </p>
        </div>
      )}
    </main>
  );
}
