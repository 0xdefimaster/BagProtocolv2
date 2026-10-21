// -----------------------------------------------------------------------------
// Status — a dated changelog of what shipped, and what comes next.
//
// SHIPPED entries link to merged pull requests or commits on main. Dates are
// merge days for PRs and commit days for direct changes (UTC). Code availability,
// npm publication and live-chain validation are stated separately. Tags are literal:
//   AVAILABLE NOW implemented on main (a published release is named explicitly)
//   IN PROGRESS   being built or enabled now; not available to users yet
//   COMING NEXT   not built
// -----------------------------------------------------------------------------

const REPO = 'https://github.com/0xdefimaster/BagProtocolv2';

interface Shipped {
  t: string;
  b: string;
  prs: number[];
  commits?: string[];
}

interface Day {
  date: string; // ISO day, UTC
  title: string;
  summary: string;
  items: Shipped[];
}

const SHIPPED: Day[] = [
  {
    date: '2026-10-21',
    title: 'Stronger SDK execution checks and developer integration',
    summary: 'Purchase bounds, registry verification and transport safety are enforced before an unsigned transaction reaches a consumer.',
    items: [
      {
        t: 'Every swap leg must have an execution bound',
        b: 'The SDK rejects provider legs with a missing or different output token, a missing or non-positive minimum output, or missing or malformed price impact.',
        prs: [108, 109],
      },
      {
        t: 'Minimum investment enforced',
        b: 'Purchase planning checks the strategy minimum in exact payment-token units before requesting a quote. Positive ERC-20 minimums require token decimals; native ETH uses 18.',
        prs: [111],
      },
      {
        t: 'Registry verification checks its chain and deployment',
        b: 'The SDK rejects a wrong RPC chain, an address that differs from a known registry deployment, or an address without contract code before reading the commitment.',
        prs: [112],
      },
      {
        t: 'Safer document fetching and Composer endpoints',
        b: 'Streamed bag.json downloads are bounded by actual UTF-8 bytes, signed URLs are kept out of fetch errors, and Composer endpoints must use HTTPS without embedded credentials or URL parameters. Unsupported native-coin basket outputs are rejected.',
        prs: [109],
      },
      {
        t: 'SDK JSON Schema and downstream package checks',
        b: 'The SDK package exports its EVM-aligned bag.json schema for editor and tooling checks. CI also builds and installs the packed SDK in a clean consumer project; these main-branch changes do not announce a new npm release.',
        prs: [109, 113],
      },
    ],
  },
  {
    date: '2026-10-20',
    title: 'Public SDK package and clearer onboarding',
    summary: 'SDK 0.2.0 is recorded as published on npm under the MIT license; main prepares the next version.',
    items: [
      {
        t: 'SDK 0.2.0 published',
        b: 'The standalone @bagprotocol/sdk package is documented as published on npm. Its distribution includes an MIT license.',
        prs: [],
        commits: ['592891c83df7878815d4bf8c52b2c2e114524db4', '0a139b2ba6d20698a06e4e2e3360da220ffc0ee5'],
      },
      {
        t: 'Copy-paste Quick Start and explicit release status',
        b: 'Installation and local bag.json examples help developers start outside the BAG app. The repository distinguishes published 0.2.0 from prepared, unpublished 0.2.1.',
        prs: [],
        commits: ['c8456bace56db16c0a7d914c506a3a2fe9b90a4f', '9e4924cfc69bed010bc921111b048dd5f32aa202', '545dd77c073f8c5ac0df040a6fc0753097fc58ff'],
      },
    ],
  },
  {
    date: '2026-10-19',
    title: 'New app interface and shared Composer allocation',
    summary: 'Create, edit and trade flows are easier to follow, while BAG and its SDK now use the same basket-splitting planner.',
    items: [
      {
        t: 'Top navigation, search and screen density',
        b: 'App navigation moves into the top bar, with search across strategies, creators and assets. Mobile keeps a menu, and desktop density can be adjusted and remembered.',
        prs: [101],
      },
      {
        t: 'Create, edit, publish and rebalance in a guided flow',
        b: 'Create uses an assets, allocation and review layout. Weight sliders keep the total at 100%. Deployment and saved versions prompt registry publication, then a launch buy or the creator’s rebalance; each transaction still needs wallet confirmation.',
        prs: [101],
      },
      {
        t: 'Clearer Bag pages and current value held',
        b: 'Bag cards, detail pages and Swap were refreshed; zero holdings are hidden. Wallet checks after an app swap or sweep refresh affected Bags’ value after an outflow is confirmed.',
        prs: [101],
      },
      {
        t: 'Composer 0.11.3 and one partition planner',
        b: 'Purchase and rebalance allocation use core.partition instead of chained splits, with two levels for larger baskets. BAG and the SDK share deterministic bigint allocation and canonical leg ordering, including amounts kept in the input token. Covered by parity tests; not re-verified against the live Composer API.',
        prs: [104, 106],
      },
      {
        t: 'Balances and launch payments',
        b: 'Fork launch buys can use USDG or ETH with the wallet balance shown. Swap adds the stablecoin balance and MAX; tiny balances are labelled instead of looking empty. Rebalances moving less than $1 explain why they cannot proceed.',
        prs: [101, 103, 105],
      },
      {
        t: 'Production builds and complete test discovery in CI',
        b: 'CI now runs the Next.js production build and detects unit tests outside the configured folders or file patterns, so route and build failures are caught before release.',
        prs: [102],
      },
    ],
  },
  {
    date: '2026-10-18',
    title: 'Editable strategy versions and flexible payments',
    summary: 'Creators can update compositions, investors can choose verified payment tokens, and rebalances can route through USDG.',
    items: [
      {
        t: 'Edit assets and weights, recover a saved version',
        b: 'Creators of mutable deployed Bags can record a new composition version from their wallet. Pending proposals allow an on-chain update to be recovered after a lost browser state or failed database write. Names are unique; version updates keep the existing rules and performance fee.',
        prs: [99],
      },
      {
        t: 'Customize a fork before creating it',
        b: 'The fork editor lets a creator choose the new name, assets and weights before the draft exists, using the same composition editor as strategy updates.',
        prs: [99],
      },
      {
        t: 'Pay or receive in verified tokens',
        b: 'Bag purchases can use other registry-verified tokens with a valid USD price. Sales without a performance fee can receive a verified token or supported native ETH; fee-paying sales still settle in the settlement stablecoin.',
        prs: [98],
      },
      {
        t: 'USDG hub routes and explicit price-impact consent',
        b: 'Multi-leg rebalances sell through USDG before buying the targets. The default impact ceiling stays at 5%; an investor can explicitly accept up to 10%, while higher impact is refused. The new route and consent retry have not been verified live.',
        prs: [100],
      },
    ],
  },
  {
    date: '2026-10-17',
    title: 'Smart-account recovery, safer sales and clearer trade feedback',
    summary: 'Deployment recovery, sale reconciliation and trade errors are improved, alongside launch balances and asset-import tooling.',
    items: [
      {
        t: 'Smart-account deployment and registry support',
        b: 'MetaMask smart-account transactions can be verified using the target’s events and wallet identity. A deployment that succeeded without app confirmation can be found and recovered without another deployment fee; rejected attempts can be retried.',
        prs: [92],
      },
      {
        t: 'Composer integration and actionable trade errors',
        b: 'The integration follows Composer’s output and error responses, aborts requests after 15 seconds, and identifies failing token legs. Purchase review names every asset, and version mismatches produce a clear message. Composer was subsequently upgraded again on 19 October.',
        prs: [92, 93],
      },
      {
        t: 'Swap leaves unroutable tokens in the wallet',
        b: 'Multi-sell can omit inputs with no route and clearly lists what was not sold. The buy picker excludes assets already marked as having no route.',
        prs: [92],
      },
      {
        t: 'One-transaction free sales and on-chain recovery',
        b: 'Sales without a fee try one Composer transaction first. Missing per-asset submission reports are searched on-chain before closing a sale; abandoned or declined attempts are closed cleanly. Recovery is implemented but not verified live.',
        prs: [94],
      },
      {
        t: 'Recovered sales are counted once',
        b: 'A verified recovered sale can explain an earlier wallet outflow, restore the matching accounting entries and book the sale without subtracting the same tokens twice.',
        prs: [97],
      },
      {
        t: 'Launch-buy balances and MAX',
        b: 'Create shows the connected wallet’s USDG or ETH balance. MAX keeps an ETH gas reserve, and failed balance reads show a retry instead of a fabricated zero.',
        prs: [96],
      },
      {
        t: 'Reviewed stock imports and supported fee chains',
        b: 'Import tooling recognizes verified tokenized stocks from known issuers, supports search and owner-selected imports, and excludes leveraged or inverse products. Performance fees are restricted to Robinhood Chain until settlement works elsewhere.',
        prs: [92],
      },
      {
        t: 'Current documentation and live-check evidence',
        b: 'The README was rewritten around the current app, historical reports were archived, and status documentation records which smart-account flows were observed live and which checks remain open.',
        prs: [95],
      },
    ],
  },
  {
    date: '2026-10-16',
    title: 'MIT license added',
    summary: 'The repository now states its open-source license.',
    items: [
      {
        t: 'Repository license',
        b: 'An MIT license was added to the repository; the SDK package later included its own license file for distribution.',
        prs: [],
        commits: ['734afc7c8a2bcdc43d8aeabe742722fca4942490'],
      },
    ],
  },
  {
    date: '2026-10-13',
    title: 'Multi-buy, multi-sell and on-chain fork royalties',
    summary: 'Buy or sell many tokens in one transaction on four networks; forks pay their original creator on-chain.',
    items: [
      {
        t: 'Swap: multi-buy and multi-sell',
        b: 'One payment buys several tokens, or several wallet tokens sell for one, in a single transaction. Paying with ETH needs no approval: one signature. Works best with MetaMask.',
        prs: [75, 77, 78],
      },
      {
        t: 'Four networks',
        b: 'Swap reads your wallet on Robinhood Chain, Ethereum, Arbitrum and Base, and sells into USDG, USDC or ETH. ETH payments are accepted on all four.',
        prs: [76, 77],
      },
      {
        t: 'Fork royalty paid on-chain',
        b: 'A fork pays its root creator 20% of its performance fee in the same sale transaction, through the new RedeemSettlement on Robinhood Chain. The investor pays nothing extra. Not yet proven with a live fork sale.',
        prs: [73],
      },
    ],
  },
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
    tag: 'COMING NEXT',
    t: 'SDK receipt and delivered-output verification',
    b: 'Add a read-only SDK helper to check a submitted purchase’s receipt and observed token delivery, with explicit incomplete-evidence results. The BAG app already verifies receipts; this is the standalone SDK layer.',
  },
  {
    tag: 'IN PROGRESS',
    t: 'Bags on Ethereum, Arbitrum and Base',
    b: 'BagFactory is being deployed on the three networks so strategies can be created there too; performance fees stay on Robinhood Chain until settlement works elsewhere.',
  },
  {
    tag: 'COMING NEXT',
    t: 'Fork royalty, proven live',
    b: 'Run a gain-bearing sale of a fork with a fee and verify that 20% reaches the root creator and the rest the fork creator, in one transaction.',
  },
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
    b: 'Broader strategy discovery, a strategy marketplace, AI-to-bag.json workflows and authenticated agents.',
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
          Every update links to a merged pull request or a commit on main, dated in UTC. Published SDK releases and
          live-chain checks are identified separately. BagFactory, StrategyRegistry and RedeemSettlement are live on
          Robinhood Chain; no Bag Protocol contract is deployed on Ethereum, Base or Arbitrum yet.
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
                          {(item.commits ?? []).map((sha) => (
                            <a key={sha} href={`${REPO}/commit/${sha}`} target="_blank" rel="noopener noreferrer" aria-label={`View commit ${sha.slice(0, 7)}`}>
                              {sha.slice(0, 7)}
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
