// "Strategy becomes an object": what a Bag carries, and how one propagates.
// Fields listed are the ones the protocol actually stores per Bag version
// (types/basket-protocol.ts BasketRecipe, bag_versions, parent/root lineage).

const ANATOMY = [
  { k: 'strategy', v: 'name, thesis, rules' },
  { k: 'allocation', v: 'assets + weights (basis points)' },
  { k: 'creator', v: 'the wallet that published it' },
  { k: 'identity', v: 'Bag id + composition hash' },
  { k: 'version', v: 'every edit is a new numbered version' },
  { k: 'lineage', v: 'parent Bag · root Bag' },
  { k: 'economics', v: 'performance fee · fork royalty' },
  { k: 'execution', v: 'chain + routes (BAG Router / LI.FI)' },
];

const PROPAGATION = ['Strategy', 'Bag', 'Publish', 'Discover', 'Invest', 'Fork', 'New Bag'];

export default function Primitive() {
  return (
    <section id="primitive" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">The new primitive</span>
        <h2>Strategy becomes an object.</h2>
        <p>
          A token is one asset. A Bag is the recipe for holding many — with its author,
          version and history attached. That is what separates it from a portfolio dashboard:
          the strategy exists independently of any screen that shows it.
        </p>
      </div>

      <div className="primitive-grid" data-reveal>
        <figure className="anatomy">
          <figcaption className="anatomy-head mono">
            <span>bag · ai-infrastructure</span>
            <span className="hpc-example-badge">EXAMPLE</span>
          </figcaption>
          <dl>
            {ANATOMY.map((a) => (
              <div className="anatomy-row" key={a.k}>
                <dt className="mono">{a.k}</dt>
                <dd>{a.v}</dd>
              </div>
            ))}
          </dl>
        </figure>

        <div className="propagation">
          <h3>How a strategy propagates</h3>
          <ol className="prop-flow">
            {PROPAGATION.map((s, i) => (
              <li key={s} className={i === PROPAGATION.length - 1 ? 'loop' : ''}>
                {s}
              </li>
            ))}
          </ol>
          <p>
            A fork is a new Bag with its own creator and version — and a permanent pointer to
            the Bag it came from. Every new Bag can be forked again.
          </p>
        </div>
      </div>
    </section>
  );
}
