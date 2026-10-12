// -----------------------------------------------------------------------------
// Status — a dated changelog of what shipped, and what comes next.
//
// SHIPPED entries are merged pull requests of this repository, dated by their
// merge day (UTC), each linked to its PR so anyone can check it. They are
// implemented and tested (local chain + real PostgreSQL); "live on Robinhood
// Chain" is said only where it is true. Nothing is deployed on Ethereum, Base or
// Arbitrum. Tags are literal:
//   AVAILABLE NOW merged and in the app
//   IN PROGRESS   being built or enabled now; not available to users yet
//   COMING NEXT   not built
// -----------------------------------------------------------------------------

const REPO = 'https://github.com/0xdefimaster/BagProtocolv2';

interface Shipped {
  t: string;
  b: string;
  prs: number[];
}

interface Day {
  date: string; // ISO day, UTC
  title: string;
  summary: string;
  items: Shipped[];
}

const SHIPPED: Day[] = [
  {
    date: '2026-10-12',
    title: 'One-click rebalance and accounting you can trust',
    summary: 'Positions can be brought back to their strategy in one signature; returns now follow prices only.',
    items: [
      {
        t: 'One-click rebalance',
        b: 'A position that drifted from its strategy is rebalanced with one wallet-signed LI.FI Composer transaction. No creator fee; BAG books exactly what the on-chain receipt shows.',
        prs: [71],
      },
      {
        t: 'Returns from a price index',
        b: '7D, 30D and YTD returns follow only the prices of what a Bag holds. Purchases, sales and tokens leaving a wallet no longer read as gains or losses.',
        prs: [70],
      },
      {
        t: 'Purchases and fee-paying sales unblocked',
        b: 'A Bag whose holders all exited, or whose tokens left the wallets, can be bought again; fee-paying sales no longer need every holding priced.',
        prs: [69, 70],
      },
      {
        t: 'Wallet menu',
        b: 'Full address, Switch account and a Disconnect that really disconnects, so the wallet asks which account to use.',
        prs: [66, 68, 69],
      },
      {
        t: 'Lighter background work',
        b: 'Wallet checks, pending settlements and NAV snapshots run hourly, and a wallet is checked when it connects.',
        prs: [69],
      },
      {
        t: 'Explore and wallet fixes',
        b: 'Categories, risk level, watchlist and sorting on Explore; Rabby network setup and approval progress; positions refresh right after a sale.',
        prs: [64, 65],
      },
    ],
  },
  {
    date: '2026-10-11',
    title: 'Public proof and real numbers',
    summary: 'Every figure is checked on-chain and linked to its transaction.',
    items: [
      {
        t: 'Proof page',
        b: 'Value held checked against every holder’s wallet, execution success rate and creator payouts, each linked to its on-chain transaction.',
        prs: [61, 62, 63],
      },
      {
        t: 'Rebalance preview and live quote',
        b: 'Each investor sees their drift against the current strategy version and a live Composer quote for fixing it.',
        prs: [54, 55],
      },
      {
        t: 'Registry checked in the browser',
        b: 'Every registered strategy version is re-verified in the viewer’s browser with the open SDK.',
        prs: [53],
      },
      {
        t: 'Real leaderboard',
        b: 'Bags ranked by verified value held, returns, holders and forks; demo stats and unused features removed.',
        prs: [57, 59],
      },
    ],
  },
  {
    date: '2026-10-10',
    title: 'Pay with ETH, developer SDK',
    summary: 'Buy a whole Bag with native ETH in one transaction; build on bag.json with the SDK.',
    items: [
      {
        t: 'Native ETH payments',
        b: 'Pay for a Bag with ETH on Robinhood Chain in one Composer transaction, with balance, MAX and insufficient-balance checks.',
        prs: [42, 45, 46],
      },
      {
        t: 'StrategyRegistry live',
        b: 'StrategyRegistry is deployed on Robinhood Chain and its first live commitment is recorded.',
        prs: [49, 50],
      },
      {
        t: 'SDK',
        b: 'Quote, simulate and compile unsigned basket purchases (incl. native ETH) from a bag.json, as a distributable build.',
        prs: [35, 51],
      },
    ],
  },
  {
    date: '2026-10-06',
    title: 'First live settled sale',
    summary: 'A real sale settled through RedeemSettlement and reconciled from chain event to ledger.',
    items: [
      {
        t: 'Settled sale, reconciled',
        b: 'The first live sale through RedeemSettlement, with its on-chain result shown: gross, fee, net and realized P&L.',
        prs: [31, 32],
      },
      {
        t: 'bag.json artifact layer',
        b: 'Standalone parse, validate, normalize and hash of bag.json v1, with registry verification.',
        prs: [33, 34],
      },
    ],
  },
  {
    date: '2026-10-05',
    title: 'On-chain settlement',
    summary: 'Creator fees computed by a contract from what a sale actually returns.',
    items: [
      {
        t: 'RedeemSettlement',
        b: 'The creator’s performance fee is computed in the contract from the actual proceeds and paid in the same transaction. Deployed on Robinhood Chain.',
        prs: [22, 23, 24, 25, 26, 28, 29],
      },
      {
        t: 'Composer to BAG contract, proven live',
        b: 'A LI.FI Composer flow calling a BAG contract was run live on Robinhood Chain before settlement was built on it.',
        prs: [18, 21],
      },
      {
        t: 'Fee economics',
        b: 'Performance fee defined on actual proceeds above cost, with a high-water mark.',
        prs: [13, 14],
      },
    ],
  },
  {
    date: '2026-10-04',
    title: 'Ledger accounting and on-chain registry',
    summary: 'Positions valued from what wallets really hold; strategies committed on-chain.',
    items: [
      {
        t: 'Accounting V2',
        b: 'Average cost and realized P&L from verified proceeds; position value from actual holdings; sell by fraction with a pre-sign check.',
        prs: [7, 8, 9],
      },
      {
        t: 'StrategyRegistry',
        b: 'Creators commit each strategy version from their own wallet; forks keep their provenance.',
        prs: [10, 11],
      },
      {
        t: 'MCP server',
        b: 'A read-only BAG MCP server, with a lineage security fix.',
        prs: [6],
      },
    ],
  },
  {
    date: '2026-10-03',
    title: 'BAG Protocol V2',
    summary: 'V2 starts from live Bag creation on Robinhood Chain and adds the strategy standard.',
    items: [
      {
        t: 'Strategy standard',
        b: 'bag.json v1 and a unified Strategy API; version timeline, diffs, Passport, Policy and validate_bag.',
        prs: [1, 2, 5],
      },
      {
        t: 'Execution receipts',
        b: 'Every execution gets a receipt and a history, verified against the chain.',
        prs: [3, 4],
      },
    ],
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
    t: 'Fee-paying sale validation',
    b: 'Run a live gain-bearing sale and verify that the non-zero performance fee reaches the creator exactly once.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Live compiler and best execution',
    b: 'Enable parallel provider candidates, add independent providers, normalize gas and fee data, and optimize the basket as a whole.',
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

const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default function Roadmap() {
  return (
    <section id="roadmap" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Status</span>
        <h2>Shipped, day by day. What comes next.</h2>
        <p>
          Every shipped item is a merged pull request, dated and linked. BagFactory, StrategyRegistry and
          RedeemSettlement are live on Robinhood Chain; no Bag Protocol contract is deployed on Ethereum, Base or
          Arbitrum yet.
        </p>
      </div>
      <div className="status-grid roadmap-grid" data-reveal>
        <div className="status-col">
          <h3 className="status-title">Shipped</h3>
          <ol className="timeline">
            {SHIPPED.map((day, i) => (
              <li className="tl-day" key={day.date}>
                <details open={i === 0}>
                  <summary>
                    <span className="tl-dot" aria-hidden="true" />
                    <span className="tl-head">
                      <span className="tl-meta">
                        <time dateTime={day.date} className="tl-date">
                          {fmtDay(day.date)}
                        </time>
                        <span className="tag tag-now">AVAILABLE NOW</span>
                      </span>
                      <span className="si-t">{day.title}</span>
                      <span className="si-b">{day.summary}</span>
                    </span>
                  </summary>
                  <ul className="tl-items">
                    {day.items.map((item) => (
                      <li key={item.t} className="tl-item">
                        <span className="tl-item-t">{item.t}</span>
                        <span className="si-b">{item.b}</span>
                        <span className="tl-prs">
                          {item.prs.map((n) => (
                            <a key={n} href={`${REPO}/pull/${n}`} target="_blank" rel="noopener noreferrer">
                              #{n}
                            </a>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ol>
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
