// How a purchase works, in five verbs, plus the path the money takes.
// Execution: BAG Router (Bag's own router, Robinhood Chain) or LI.FI; the user
// signs every transaction; the server verifies receipts before any accounting.

const STEPS = [
  { k: 'Choose', body: 'Pick a Bag.' },
  { k: 'Allocate', body: 'Enter an amount. It is split by the Bag’s published weights.' },
  { k: 'Route', body: 'Execution routes are found and quoted, with a guaranteed minimum output.' },
  { k: 'Execute', body: 'You sign in your own wallet. Trades execute on the Bag’s chain.' },
  { k: 'Reconcile', body: 'What actually arrived is verified on-chain before it counts.' },
];

const PATH = [
  { label: 'You', value: 'amount' },
  { label: 'Strategy', value: 'the Bag' },
  { label: 'Allocation', value: 'per-asset amounts' },
  { label: 'Execution', value: 'BAG Router · LI.FI', hi: true },
  { label: 'Result', value: 'portfolio in your wallet' },
];

export default function HowItWorks() {
  return (
    <section className="wrap" id="how-it-works">
      <div className="section-head" data-reveal>
        <span className="kicker">How Bag works</span>
        <h2>Strategy in. Portfolio out.</h2>
        <p>
          The only decisions are which Bag and how much. Everything between is handled — and
          checked against the chain, not just estimated.
        </p>
      </div>

      <ol className="steps5" data-reveal>
        {STEPS.map((s, i) => (
          <li key={s.k}>
            <span className="s5-n mono">{String(i + 1).padStart(2, '0')}</span>
            <h3>{s.k}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="exec-diagram" data-reveal role="img" aria-label="You, then the strategy, then the allocation, then execution through BAG Router or LI.FI, then the portfolio in your wallet">
        {PATH.map((n, i) => (
          <div className="exec-seg" key={n.label}>
            <div className={`exec-node${n.hi ? ' hi' : ''}`}>
              <div className="en-label">{n.label}</div>
              <div className="en-value">{n.value}</div>
            </div>
            {i < PATH.length - 1 && <span className="exec-arrow" aria-hidden="true">→</span>}
          </div>
        ))}
      </div>
      <p className="path-caption">
        Non-custodial: Bag never pools deposits and never signs for you. A quote is not an
        execution — accounting follows confirmed receipts only.
      </p>
    </section>
  );
}
