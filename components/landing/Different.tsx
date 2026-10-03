const PILLARS = [
  { t: 'Strategy as an object', b: 'A Bag is structured and identifiable: allocation, creator, version and lineage in one place.' },
  { t: 'Forkable', b: 'Any published strategy can be adapted and republished, with a permanent link to its parent.' },
  { t: 'Creator economics', b: 'Root creators earn on forks; creators set a fee on realized profit. Enforced by the protocol.' },
  { t: 'One-action execution', b: 'An amount becomes a full portfolio without rebuilding each position by hand.' },
  { t: 'Portable format', b: 'Strategies are data in an open format, not screens locked inside one interface.' },
  { t: 'Multi-chain', b: 'One model across Ethereum, Arbitrum, Base and Robinhood Chain.' },
];

export default function Different() {
  return (
    <section id="different" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Why Bag is different</span>
        <h2>Not a portfolio app. A strategy layer.</h2>
        <p>A portfolio app shows you what you hold. Bag defines strategies other people can hold, change and build on.</p>
      </div>
      <ul className="pillars" data-reveal>
        {PILLARS.map((p, i) => (
          <li key={p.t}>
            <span className="pl-n mono">{String(i + 1).padStart(2, '0')}</span>
            <h3>{p.t}</h3>
            <p>{p.b}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
