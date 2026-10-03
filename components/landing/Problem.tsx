// Why Bag exists. Factual, not "finance is broken".

const TODAY = ['Idea', 'Post', 'Screenshot', 'Manual copying'];
const TODAY_COST = ['No defined allocation', 'Attribution lost on copy', 'Portfolio rebuilt by hand, asset by asset', 'No native way for the author to earn'];
const WITH_BAG = ['Defined allocation', 'Creator identity', 'Version', 'Invest', 'Fork', 'Royalties'];

export default function Problem() {
  return (
    <section id="why" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Why Bag exists</span>
        <h2>Investment ideas aren&apos;t enough. Strategies should be investable.</h2>
        <p>
          Strategies travel today as posts and screenshots. Everyone who acts on one rebuilds
          it by hand, the link to its author disappears, and the author has no native way to
          participate in what they started.
        </p>
      </div>

      <div className="lanes" data-reveal>
        <div className="lane lane-muted">
          <h3 className="lane-title mono">Today — an idea</h3>
          <ol className="lane-flow">
            {TODAY.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <ul className="lane-notes">
            {TODAY_COST.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="lane lane-gold">
          <h3 className="lane-title mono">With Bag — a strategy object</h3>
          <ol className="lane-flow">
            {WITH_BAG.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="lane-summary">
            The strategy itself becomes the thing people invest in, fork and credit — not a
            description of it.
          </p>
        </div>
      </div>
    </section>
  );
}
