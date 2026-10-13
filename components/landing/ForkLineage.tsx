// Forking, drawn as a lineage: each fork is a new Bag with its own creator and
// version, pointing back to its parent; 20% of the performance fee any fork earns goes to the root.

const CHAIN = [
  { creator: 'Creator A', name: 'AI Infrastructure', meta: 'root · v3', assets: 'NVDA · MSFT · AMD' },
  { creator: 'Creator B', name: 'AI + Semiconductors', meta: 'forked from A · v1', assets: 'NVDA · AMD · TSM · ASML' },
  { creator: 'Creator C', name: 'AI + Semis + Crypto', meta: 'forked from B · v2', assets: 'NVDA · TSM · ETH · BTC' },
];

export default function ForkLineage() {
  return (
    <section id="forks" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Forkable finance</span>
        <h2>Strategies fork like open source.</h2>
        <p>
          Anyone can take a published Bag, change it, and publish their own. The original is
          untouched, and the new Bag keeps a visible link to where it came from.
        </p>
      </div>

      <figure className="lineage-fig" data-reveal>
        <ol className="lineage-chain">
          {CHAIN.map((node, i) => (
            <li key={node.name} className={i === 0 ? 'root' : ''}>
              {i > 0 && (
                <span className="fork-edge mono" aria-hidden="true">
                  fork
                </span>
              )}
              <div className="lineage-node">
                <span className="ln-creator mono">{node.creator}</span>
                <span className="ln-name">{node.name}</span>
                <span className="ln-assets">{node.assets}</span>
                <span className="ln-meta mono">{node.meta}</span>
              </div>
            </li>
          ))}
        </ol>
        <figcaption className="lineage-royalty">
          <span className="mono">20%</span> of the performance fee Creator B or Creator C earns on a sale is
          paid to Creator A, the root, in the same transaction. <span className="lineage-example">Illustrative example.</span>
        </figcaption>
      </figure>
    </section>
  );
}
