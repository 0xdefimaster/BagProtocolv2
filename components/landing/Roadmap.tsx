// -----------------------------------------------------------------------------
// Status — tags are literal:
//   AVAILABLE NOW       implemented in the app and covered by its tests (local
//                       chain + real PostgreSQL). Contracts are NOT on mainnet yet.
//   IN PROGRESS         being built or enabled now; not available to users yet
//   COMING NEXT         not built
// -----------------------------------------------------------------------------

const NOW = [
  {
    t: 'Live Bag creation on Robinhood Chain',
    b: 'User-signed BagFactory deployment with receipt verification and on-chain composition binding.',
  },
  {
    t: 'Strategy standard and lineage',
    b: 'bag.json v1, deterministic validation and hashing, version history, strategy diffs, Passport, Policy and fork lineage.',
  },
  {
    t: 'Basket execution with LI.FI',
    b: 'Multi-asset purchases and fraction-based redemptions through LI.FI Composer in a single transaction where supported.',
  },
  {
    t: 'Verified execution and receipts',
    b: 'Provider-independent execution plans, minimum-output checks, wallet and transaction binding, on-chain receipt verification and execution history.',
  },
  {
    t: 'Live Robinhood asset and price layer',
    b: 'Robinhood Stock Token registry and pricing, LI.FI crypto pricing, RPC failover and execution-aware valuation safeguards.',
  },
  {
    t: 'On-chain strategy registry and SDK',
    b: 'StrategyRegistry is live on Robinhood Chain: creators commit each version from their own wallet, anyone can verify a bag.json with the open SDK, and the app re-checks every registered version in the viewer’s browser.',
  },
  {
    t: 'On-chain redemption settlement',
    b: 'RedeemSettlement is live on Robinhood Chain; the first real fee-path sale has been reconciled from chain event to database ledger.',
  },
];

const NEXT = [
  {
    tag: 'IN PROGRESS',
    t: 'BAG Router production enablement',
    b: 'Resolve the plan-signer trust boundary, deploy the router, configure allowlists and enable the native execution path.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Live compiler and best execution',
    b: 'Enable parallel provider candidates, add independent providers, normalize gas and fee data, and optimize the basket as a whole.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Fee-paying redemption validation',
    b: 'Run a live gain-bearing redemption and verify that the non-zero performance fee reaches the creator exactly once.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Portfolio management',
    b: 'Drift detection, target-vs-current allocation, delta-based rebalance planning, one-click rebalance and verified post-state.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Execution intelligence',
    b: 'Measure quote vs. actual output, price impact, latency, failures and provider reliability to improve future routing.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Strategy intelligence',
    b: 'Liquidity and route analysis, concentration and risk checks, execution-cost warnings and Strategy Doctor recommendations.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Automation and recurring strategies',
    b: 'Scheduled purchases, drift-aware DCA, threshold rebalances and conditional execution when required routes become available.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Open strategy network, AI and agents',
    b: 'Portable strategy discovery, published bag.json URLs, a strategy marketplace, AI-to-bag.json workflows and authenticated agents.',
  },
];

export default function Roadmap() {
  return (
    <section id="roadmap" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Status</span>
        <h2>What works today. What comes next.</h2>
        <p>
          Available now means implemented in the app and tested against a local chain and a real
          database. No Bag Protocol contract is deployed to mainnet yet.
        </p>
      </div>
      <div className="status-grid" data-reveal>
        <div className="status-col">
          <h3 className="status-title">Available now</h3>
          <ul>
            {NOW.map((i) => (
              <li className="status-item" key={i.t}>
                <span className="tag tag-now">AVAILABLE NOW</span>
                <span className="si-t">{i.t}</span>
                <span className="si-b">{i.b}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="status-col">
          <h3 className="status-title">Coming next</h3>
          <ul>
            {NEXT.map((i) => (
              <li className="status-item" key={i.t}>
                <span className={`tag ${i.tag === 'COMING NEXT' ? 'tag-next' : 'tag-deploy'}`}>{i.tag}</span>
                <span className="si-t">{i.t}</span>
                <span className="si-b">{i.b}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
