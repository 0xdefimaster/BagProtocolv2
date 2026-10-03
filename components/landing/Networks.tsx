// Four EVM chains from lib/config/chains.ts. A Bag is deployed on one chain;
// the strategy model, format and tooling are the same on all of them.

const CHAINS = [
  { name: 'Ethereum', id: '1', color: '#627EEA', assets: 'Crypto', exec: 'LI.FI' },
  { name: 'Arbitrum', id: '42161', color: '#28A0F0', assets: 'Crypto', exec: 'LI.FI' },
  { name: 'Base', id: '8453', color: '#3B7BFF', assets: 'Crypto', exec: 'LI.FI' },
  { name: 'Robinhood Chain', id: '4663', color: '#3CD458', assets: 'Crypto + Stock Tokens', exec: 'BAG Router · LI.FI' },
];

export default function Networks() {
  return (
    <section className="wrap" id="networks">
      <div className="section-head" data-reveal>
        <span className="kicker">Multi-chain</span>
        <h2>One strategy layer. Four chains.</h2>
        <p>
          The same strategy model runs on every supported chain. Each Bag is deployed on the
          chain its creator chooses; Robinhood Chain adds tokenized stocks alongside crypto.
        </p>
      </div>
      <ul className="chain-grid" data-reveal>
        {CHAINS.map((c) => (
          <li className="chain-card" key={c.name}>
            <span className="chain-dot" style={{ background: c.color }} aria-hidden="true" />
            <h3>{c.name}</h3>
            <dl>
              <div>
                <dt className="mono">chain id</dt>
                <dd className="mono">{c.id}</dd>
              </div>
              <div>
                <dt className="mono">assets</dt>
                <dd>{c.assets}</dd>
              </div>
              <div>
                <dt className="mono">execution</dt>
                <dd>{c.exec}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
