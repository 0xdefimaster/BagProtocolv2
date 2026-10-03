import { ActivityItem, formatRelativeTime } from '@/lib/activity-store';
import { GitFork, TrendingUp, Users, Sparkles, RefreshCw } from 'lucide-react';

interface ActivityFeedProps {
  items: ActivityItem[];
  emptyMessage?: string;
}

function iconFor(action: string) {
  if (action.startsWith('Forked')) return <GitFork />;
  if (action.startsWith('Invested')) return <TrendingUp />;
  if (action.startsWith('Started following') || action.startsWith('You followed')) return <Users />;
  if (action.startsWith('Published') || action.startsWith('You published')) return <Sparkles />;
  return <RefreshCw />;
}

export function ActivityFeed({ items, emptyMessage }: ActivityFeedProps) {
  if (items.length === 0) {
    return <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>{emptyMessage || 'No activity yet.'}</p>;
  }

  return (
    <div className="activity-feed">
      {items.map((item) => (
        <div className="activity-row" key={item.id}>
          <span className="activity-dot">{iconFor(item.action)}</span>
          <div className="activity-text">{item.action}</div>
          <div className="activity-time">{formatRelativeTime(item.timestamp)}</div>
        </div>
      ))}
    </div>
  );
}
