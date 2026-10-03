// Directly under the hero: the protocol layer in four lines, so the product
// promise ("one strategy → one portfolio") is never read as the whole story.

const THESIS = [
  { n: '01', who: 'Creators', what: 'publish investable strategies' },
  { n: '02', who: 'Investors', what: 'discover them and invest in one action' },
  { n: '03', who: 'Anyone', what: 'can fork a strategy and build on it' },
  { n: '04', who: 'Root creators', what: 'earn from the network their strategy starts' },
];

export default function Thesis() {
  return (
    <section className="thesis wrap" aria-label="What Bag connects">
      <ol className="thesis-row" data-reveal>
        {THESIS.map((t) => (
          <li key={t.n}>
            <span className="thesis-n mono">{t.n}</span>
            <span>
              <b>{t.who}</b> {t.what}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
