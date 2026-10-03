import { Bag, CreatorProfile } from '@/types';

export interface CreatorStats {
  address: string;
  name: string;
  avatar: string;
  avatarUrl?: string;
  handle?: string;
  verified?: boolean;
  /** Undefined until a real score exists (no placeholder). */
  creatorScore?: number;
  bagsPublished: number;
  totalTVL: number;
  totalFollowers: number;
  totalForks: number;
  successfulBags: number;
  avgPerformanceYtd: number;
}

/**
 * Every bag whose creator.address matches the given address, deduped by id
 * and pulled from every bag source we know about (curated + locally
 * published/forked bags).
 */
export function getBagsByCreator(address: string, ...bagLists: Bag[][]): Bag[] {
  const seen = new Map<string, Bag>();
  for (const list of bagLists) {
    for (const bag of list) {
      if (bag.creator.address === address && !seen.has(bag.id)) {
        seen.set(bag.id, bag);
      }
    }
  }
  return Array.from(seen.values());
}

export function getCreatorStats(address: string, bags: Bag[], fallback?: CreatorProfile): CreatorStats {
  const source = bags[0]?.creator ?? fallback;

  const totalTVL = bags.reduce((sum, b) => sum + b.tvl, 0);
  const totalFollowers = bags.reduce((sum, b) => sum + b.followers, 0) || source?.followers || 0;
  const totalForks = bags.reduce((sum, b) => sum + b.forks, 0) || source?.forks || 0;
  const successfulBags = bags.filter((b) => b.performanceYtd > 0).length;
  const avgPerformanceYtd = bags.length
    ? bags.reduce((sum, b) => sum + b.performanceYtd, 0) / bags.length
    : 0;

  return {
    address,
    name: source?.name ?? 'Unknown Creator',
    avatar: source?.avatar ?? '👤',
    avatarUrl: source?.avatarUrl,
    handle: source?.handle,
    verified: source?.verified,
    creatorScore: source?.creatorScore,
    bagsPublished: bags.length,
    totalTVL,
    totalFollowers,
    totalForks,
    successfulBags,
    avgPerformanceYtd,
  };
}
