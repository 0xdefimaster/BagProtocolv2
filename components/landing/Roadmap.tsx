// -----------------------------------------------------------------------------
// Status — tags are literal:
//   AVAILABLE NOW       implemented in the app and covered by its tests (local
//                       chain + real PostgreSQL). Contracts are NOT on mainnet yet.
//   DEPLOYMENT PENDING  code exists; needs contracts deployed + live configuration
//   COMING NEXT         not built
// -----------------------------------------------------------------------------

const NOW = [
  { t: 'Create, publish, version, fork', b: 'Bags with creator identity, numbered versions and parent/root lineage.' },
  { t: 'Explore and strategy pages', b: 'Allocation, creator, chain and diversification for every published Bag.' },
  { t: 'Allocation and execution', b: 'Routes through BAG Router or LI.FI, signed in your own wallet, verified on-chain before accounting.' },
  { t: 'Creator economics', b: '1.5% fork royalty to the root creator; performance fee on realized profit, locked once outside capital arrives.' },
  { t: 'Multi-chain data layer', b: 'LI.FI crypto data, Robinhood Stock Token data, and resilient RPC across four chains.' },
];

const NEXT = [
  { tag: 'DEPLOYMENT PENDING', t: 'BagFactory on mainnet', b: 'Contracts are written and tested; not yet deployed.' },
  { tag: 'DEPLOYMENT PENDING', t: 'BAG Router on Robinhood Chain', b: 'Router, token allowlists and plan signer configuration.' },
  { tag: 'DEPLOYMENT PENDING', t: 'Live price pools', b: 'Pool configuration for on-chain price fallbacks.' },
  { tag: 'COMING NEXT', t: 'Creator reputation and verification', b: 'Track records and verified creators.' },
  { tag: 'COMING NEXT', t: 'Performance history and analytics', b: 'Recorded NAV history, risk and volatility metrics.' },
  { tag: 'COMING NEXT', t: 'Public SDK', b: 'Read, render and build on Bags from third-party clients.' },
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
