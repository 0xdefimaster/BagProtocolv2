interface ReputationProps {
  /** 0-100. Undefined = no score has been earned yet — never replaced by a made-up number. */
  score?: number;
  size?: 'sm' | 'lg';
}

export function Reputation({ score, size = 'sm' }: ReputationProps) {
  if (score === undefined) {
    return (
      <div className="reputation-row">
        <span className="reputation-score">New creator</span>
      </div>
    );
  }
  const starCount = Math.round((score / 100) * 5);
  const stars = '★'.repeat(starCount) + '☆'.repeat(5 - starCount);

  return (
    <div className="reputation-row">
      <span className="reputation-stars" style={size === 'lg' ? { fontSize: 20 } : undefined}>
        {stars}
      </span>
      <span className="reputation-score">{score} Reputation</span>
    </div>
  );
}
