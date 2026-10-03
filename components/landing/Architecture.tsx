// Each provider is used for what it is authoritative for (docs/PRICE_AND_DATA_LAYER.md).
// Alchemy is infrastructure, not a market-data source.

const PROVIDERS = [
  {
    name: 'LI.FI',
    role: 'Routing & crypto data',
    items: ['Crypto token data and indicative prices', 'Route and execution quotes', 'Swaps and cross-chain execution'],
  },
  {
    name: 'Robinhood Stock Token API',
    role: 'Stock Token data',
    items: ['Canonical Stock Token contracts', 'Bid / ask pricing, per-token multiplier', 'Corporate actions, trading status'],
  },
  {
    name: 'Alchemy',
    role: 'Blockchain infrastructure',
    items: ['RPC, balances, contract reads', 'Transaction state and receipts', 'On-chain verification, with fallback RPCs'],
  },
];

export default function Architecture() {
  return (
    <section id="architecture" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Architecture</span>
        <h2>Each provider does one job.</h2>
        <p>
          Crypto data and routing, Stock Token data, and chain access each come from the source
          that is authoritative for it. A ticker never identifies an asset — the contract does.
        </p>
      </div>
      <ul className="arch-grid" data-reveal>
        {PROVIDERS.map((p) => (
          <li className="arch-card" key={p.name}>
            <span className="rc-tag mono">{p.role}</span>
            <h3>{p.name}</h3>
            <ul>
              {p.items.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="arch-foot" data-reveal>
        Your wallet signs every purchase — the server never signs for you or holds your funds. Prices shown
        are indicative; purchases use execution quotes.
      </p>
    </section>
  );
}
