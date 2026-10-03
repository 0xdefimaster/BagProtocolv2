import Link from 'next/link';
import ArrowIcon from '@/components/ui/ArrowIcon';

const INVESTOR = [
  'Choose a strategy — and see who made it',
  'Enter one amount',
  'Allocation computed from the published weights',
  'Execution routes quoted before you sign',
  'Executed from your own wallet',
  'The portfolio lands in your wallet, not a pooled vault',
];

const CREATOR = [
  'Create a strategy in minutes',
  'Publish it as a versioned Bag',
  'Build an audience around your work',
  'Attract capital without custody of anyone’s funds',
  'Get forked — and keep the lineage',
  'Earn fork royalties and a performance fee',
];

export default function Audiences() {
  return (
    <section id="audiences" className="wrap">
      <div className="section-head" data-reveal>
        <span className="kicker">Built for both sides</span>
        <h2>Two ways in. One strategy layer.</h2>
      </div>
      <div className="audience-grid" data-reveal>
        <div className="audience">
          <span className="rc-tag mono">For investors</span>
          <h3>Buy the strategy, not the pieces.</h3>
          <ul>
            {INVESTOR.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <Link className="btn btn-primary" href="/dashboard/explore">
            Explore Bags
            <ArrowIcon size={14} />
          </Link>
        </div>
        <div className="audience">
          <span className="rc-tag mono">For creators</span>
          <h3>Turn your strategy into a digital financial product.</h3>
          <ul>
            {CREATOR.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <Link className="btn btn-ghost" href="/dashboard/create">
            Create a Bag
          </Link>
        </div>
      </div>
    </section>
  );
}
