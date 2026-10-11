'use client';

interface HeroProps {
  isConnected: boolean;
}

export function Hero({ isConnected }: HeroProps) {
  if (isConnected) {
    return null; // Dashboard takes over
  }

  return (
    <div className="app-intro">
      <span className="eyebrow">
        <span className="dot" />
        LIVE ON ROBINHOOD CHAIN
      </span>
      <h1>Explore Bags</h1>
      <p className="lead">
        Discover, fork, and invest in programmable portfolios published as{' '}
        <span className="mono">bag.json</span>. Every Bag is portable across chains.
      </p>
    </div>
  );
}
