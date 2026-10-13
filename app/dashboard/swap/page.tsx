'use client';

import { useWallet } from '@/lib/wallet-context';
import { SwapCard } from '@/components/swap/SwapCard';

// -----------------------------------------------------------------------------
// Swap — one card (components/swap/SwapCard.tsx) on Robinhood Chain, Ethereum,
// Arbitrum or Base: Multi-buy (one payment → several tokens; ETH needs no
// approval, one signature) or Multi-sell (several wallet tokens → the
// stablecoin or ETH), each in ONE transaction. Tokens stay in the user's own
// wallet; the server compiles, the wallet signs.
// -----------------------------------------------------------------------------

export default function SwapPage() {
  const { isConnected, isConnecting, isSigningIn, authError, connect, signIn, authUser } = useWallet();

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro" style={{ textAlign: 'center' }}>
        <h1 style={{ marginTop: 16 }}>Swap</h1>
        <p className="lead" style={{ marginInline: 'auto' }}>
          Buy several tokens with one payment, or sell several for one — in a single transaction, from your own wallet. Robinhood Chain, Ethereum,
          Arbitrum and Base.
        </p>
      </div>

      {authUser ? (
        <SwapCard walletAddress={authUser.walletAddress} />
      ) : (
        <div className="create-card" style={{ margin: '32px auto 0', maxWidth: 480 }}>
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
            Works best with MetaMask. Signing in is free — it&apos;s a message signature, not a transaction, and never costs gas.
          </p>
        </div>
      )}
    </main>
  );
}
