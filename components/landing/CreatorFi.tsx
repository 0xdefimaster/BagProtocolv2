// CreatorFi — the creator lifecycle and the economics behind "Earn".
// Numbers are protocol constants: FORK_ROYALTY_FEE_SHARE_BPS = 2000
// (lib/config/rewards.ts, = RedeemSettlement.FORK_ROYALTY_SHARE_BPS) and
// MAX_PERFORMANCE_FEE_BPS = 3000 (types/basket-protocol.ts). The fee is charged
// only on a seller's realized gain and is locked once outside capital arrives
// (migration 0033). RedeemSettlement pays it in the sale's transaction, and on a
// fork splits it: the root creator's share, the rest to the fork's creator. The
// investor pays nothing extra; a fork with a 0% fee pays no royalty.

const LIFECYCLE = [
  { k: 'Create', body: 'Pick assets and weights, write the thesis, set a performance fee.' },
  { k: 'Publish', body: 'The strategy becomes a Bag: identifiable, versioned, tied to its creator.' },
  { k: 'Discover', body: 'Investors find the strategy — and who made it — in Explore.' },
  { k: 'Invest', body: 'One action instead of rebuilding the portfolio position by position.' },
  { k: 'Fork', body: 'Another creator adapts it and publishes a new Bag. The lineage stays.' },
  { k: 'Earn', body: 'A fee on investors’ realized profit, and a share of what every fork of your Bag earns.' },
];

const GUARANTEES = [
  'Fee only on realized profit — never on losses',
  'Performance fee capped at 30%',
  'Fee locked once outside capital arrives',
  'Fork royalty comes out of the fork’s fee — investors pay nothing extra',
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
          <div className="rc-num">20%</div>
          <h3>of the performance fee every fork of your Bag earns</h3>
          <p>
            Paid to the root creator by the settlement contract, in the same transaction as the
            sale — forks of forks still point back to the original. It comes out of the fork
            creator&apos;s fee, so a fork with no fee pays no royalty.
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
