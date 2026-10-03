// The open format. Checked against the code: the recipe schema is
// `BasketRecipe` (types/basket-protocol.ts), stored per version in
// `bag_versions`; deployed Bags anchor identity + composition hash on-chain
// (BagFactory / Bag) and record new versions via BagFactory.recordBagVersion.
// Not published to IPFS; no wallet parses the format natively.

const PROPS = [
  { t: 'Readable', b: 'Plain JSON: assets, weights, rules, fee.' },
  { t: 'Versionable', b: 'Every edit is a new numbered version with its own hash.' },
  { t: 'Shareable', b: 'The strategy is data — any client can render it.' },
  { t: 'Composable', b: 'Other apps and agents can read and build on it.' },
  { t: 'Forkable', b: 'A fork starts from the same recipe and is linked to its parent Bag.' },
];

const EXAMPLE_RECIPE = `{
  "name": "AI Infrastructure",
  "chain": "robinhood",
  "version": 3,
  "assets": [
    { "symbol": "NVDA", "weightBps": 4000 },
    { "symbol": "MSFT", "weightBps": 3500 },
    { "symbol": "AMD",  "weightBps": 2500 }
  ],
  "performanceFeeBps": 1000
}`;

/** Minimal JSON highlighter for the static example above. */
function highlight(json: string) {
  const out: React.ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|([{}[\],:])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(json))) {
    if (m.index > last) out.push(json.slice(last, m.index));
    if (m[1] && m[2]) out.push(<span className="tok-key" key={i++}>{m[1]}</span>, <span className="tok-punc" key={i++}>{m[2]}</span>);
    else if (m[1]) out.push(<span className="tok-str" key={i++}>{m[1]}</span>);
    else if (m[3]) out.push(<span className="tok-num" key={i++}>{m[3]}</span>);
    else out.push(<span className="tok-punc" key={i++}>{m[4]}</span>);
    last = re.lastIndex;
  }
  out.push(json.slice(last));
  return out;
}

export default function Spec() {
  return (
    <section id="spec" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Open format · bag.json</span>
        <h2>The strategy itself has a format.</h2>
        <p>
          To be shared, versioned and forked, a strategy needs a portable representation — not
          a screenshot. Every Bag is a small recipe; deployed Bags anchor its hash on-chain.
        </p>
      </div>
      <div className="spec-grid" data-reveal>
        <ul className="spec-props">
          {PROPS.map((p) => (
            <li key={p.t}>
              <h3>{p.t}</h3>
              <p>{p.b}</p>
            </li>
          ))}
        </ul>
        <figure className="code-card">
          <div className="code-bar" aria-hidden="true">
            <div className="code-tabs">
              <span className="code-tab active">bag.json</span>
            </div>
            <div className="code-dots">
              <span style={{ background: '#FF5F57' }}></span>
              <span style={{ background: '#FEBC2E' }}></span>
              <span style={{ background: '#28C840' }}></span>
            </div>
          </div>
          <pre className="code" tabIndex={0} aria-label="Example bag.json recipe">
            {highlight(EXAMPLE_RECIPE)}
          </pre>
          <figcaption className="code-caption">Example recipe (abridged). Weights are basis points.</figcaption>
        </figure>
      </div>
    </section>
  );
}
