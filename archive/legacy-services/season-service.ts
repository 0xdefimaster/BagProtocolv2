import { Season } from '@/types/domain';
import { GENESIS_SEASON } from '@/lib/config/season';

const SEASONS: Season[] = [GENESIS_SEASON];

export function getActiveSeason(): Season {
  return SEASONS.find((s) => s.status === 'ACTIVE') ?? GENESIS_SEASON;
}

export function getSeasonById(id: string): Season | undefined {
  return SEASONS.find((s) => s.id === id);
}

export function listSeasons(): Season[] {
  return SEASONS;
}
