'use client';

import { useState } from 'react';
import { useWallet } from '@/lib/wallet-context';
import { WalletAssetsPanel } from '@/components/portfolio/WalletAssetsPanel';
import { BuyPanel } from '@/components/portfolio/BuyPanel';

// -----------------------------------------------------------------------------
// Swap — on Robinhood Chain, Ethereum, Arbitrum or Base, in ONE transaction:
//   Buy:  one or several tokens, paid with ETH (no approval, one signature) or
//         the chain's stablecoin (components/portfolio/BuyPanel.tsx).
//   Sell: one or several wallet tokens for the stablecoin or ETH (the same
//         panel as Portfolio's Wallet section, components/portfolio/WalletAssetsPanel.tsx).
// Tokens stay in the user's own wallet; the server compiles, the wallet signs.
// -----------------------------------------------------------------------------

const STEPS = {
  buy: [
    { n: '01', t: 'Pick tokens', b: 'One or several, on Robinhood Chain, Ethereum, Arbitrum or Base.' },
    { n: '02', t: 'Pay with ETH', b: 'No approval needed: one signature buys them all. Or pay with the stablecoin.' },
    { n: '03', t: 'In your wallet', b: 'The tokens land in the same wallet. No deposit, no pool.' },
  ],
  sell: [
    { n: '01', t: 'Select tokens', b: 'Pick one or several tokens in your wallet.' },
    { n: '02', t: 'One signature', b: 'They are all sold in a single transaction.' },
    { n: '03', t: 'Stablecoin or ETH', b: 'USDG on Robinhood Chain, USDC on Ethereum, Arbitrum and Base — or ETH on any of them. No deposit, no pool.' },
  ],
} as const;

export default function SwapPage() {
  const { isConnected, isConnecting, isSigningIn, authError, connect, signIn, authUser } = useWallet();
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <h1 style={{ marginTop: 16 }}>Swap</h1>
        <p className="lead">Buy or sell several tokens in one transaction, straight from your wallet — on Robinhood Chain, Ethereum, Arbitrum and Base.</p>
      </div>

      <div className="swap-mode" role="tablist" aria-label="Mode">
        {(['buy', 'sell'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'sweep-chain active' : 'sweep-chain'} onClick={() => setMode(m)}>
            {m === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      <ol className="swap-steps" style={{ marginTop: 20 }}>
        {STEPS[mode].map((s) => (
          <li key={s.n} className="dash-stat">
            <span className="l mono">{s.n}</span>
            <div className="swap-step-t">{s.t}</div>
            <p className="swap-step-b">{s.b}</p>
          </li>
        ))}
      </ol>

      {authUser ? (
        mode === 'buy' ? <BuyPanel walletAddress={authUser.walletAddress} /> : <WalletAssetsPanel walletAddress={authUser.walletAddress} />
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
