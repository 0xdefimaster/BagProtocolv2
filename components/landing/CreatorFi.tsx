// CreatorFi — the creator lifecycle and the economics behind "Earn".
// Numbers are protocol constants: FORK_ROYALTY_BPS = 150 (lib/config/rewards.ts),
// MAX_PERFORMANCE_FEE_BPS = 3000 (types/basket-protocol.ts). The royalty is not
// paid on the root creator's own deposits; the fee is charged only on a
// depositor's realized gain and is locked once outside capital arrives
// (migration 0033). Rewards are recorded in a ledger and settled on-chain.

const LIFECYCLE = [
  { k: 'Create', body: 'Pick assets and weights, write the thesis, set a performance fee.' },
  { k: 'Publish', body: 'The strategy becomes a Bag: identifiable, versioned, tied to its creator.' },
  { k: 'Discover', body: 'Investors find the strategy — and who made it — in Explore.' },
  { k: 'Invest', body: 'One action instead of rebuilding the portfolio position by position.' },
  { k: 'Fork', body: 'Another creator adapts it and publishes a new Bag. The lineage stays.' },
  { k: 'Earn', body: 'Royalties from forks and a fee on investors’ realized profit.' },
];

const GUARANTEES = [
  'Fee only on realized profit — never on losses',
  'Performance fee capped at 30%',
  'Fee locked once outside capital arrives',
  'No royalty on the creator’s own deposits',
];

export default function CreatorFi() {
  return (
    <section id="creatorfi" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">CreatorFi</span>
        <h2>From publishing ideas to building investable strategies.</h2>
        <p>
          On Bag, a creator&apos;s work is not a post that gets copied. It is a product that
          people invest in, that others build on, and that pays its author as it spreads.
        </p>
      </div>

      <ol className="lifecycle" data-reveal>
        {LIFECYCLE.map((s, i) => (
          <li key={s.k} className={s.k === 'Earn' ? 'hi' : ''}>
            <span className="lc-n mono">{String(i + 1).padStart(2, '0')}</span>
            <h3>{s.k}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="reward-cards" data-reveal>
        <div className="reward-card">
          <span className="rc-tag mono">Fork royalty</span>
          <div className="rc-num">1.5%</div>
          <h3>of every deposit into a fork of your Bag</h3>
          <p>
            Credited to the root creator at deposit time — forks of forks still point back to
            the original. Recorded in a reward ledger and settled on-chain.
          </p>
        </div>
        <div className="reward-card">
          <span className="rc-tag mono">Performance fee</span>
          <div className="rc-num">0–30%</div>
          <h3>of an investor&apos;s realized profit, set by you</h3>
          <p>
            Charged only when an investor redeems with a gain, on that gain. Your incentive is
            the same as theirs.
          </p>
        </div>
      </div>

      <ul className="reasons guarantees" data-reveal aria-label="Enforced by the protocol">
        {GUARANTEES.map((g) => (
          <li className="reason-chip" key={g}>
            <span className="check" aria-hidden="true">✓</span>
            {g}
          </li>
        ))}
      </ul>
    </section>
  );
}
