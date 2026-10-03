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
        LIVE ON BASE
      </span>
      <h1>Explore Bags</h1>
      <p className="lead">
        Discover, fork, and invest in programmable portfolios published as{' '}
        <span className="mono">bag.json</span>. Every Bag is portable across chains.
      </p>

      <div className="app-stats">
        <div className="app-stat">
          <div className="v">$2.4B</div>
          <div className="l">Total TVL</div>
        </div>
        <div className="app-stat">
          <div className="v">12K+</div>
          <div className="l">Active Bags</div>
        </div>
        <div className="app-stat">
          <div className="v">8</div>
          <div className="l">Chains Supported</div>
        </div>
      </div>
    </div>
  );
}
