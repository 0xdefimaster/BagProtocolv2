import { BoxTypeConfig, BoxTypeId } from '@/types/domain';

export const BOX_CONFIG: Record<BoxTypeId, BoxTypeConfig> = {
  COMMON: { id: 'COMMON', name: 'Common Box', cost: 100 },
  RARE: { id: 'RARE', name: 'Rare Box', cost: 500 },
  EPIC: { id: 'EPIC', name: 'Epic Box', cost: 2000 },
};

export const BOX_ORDER: BoxTypeId[] = ['COMMON', 'RARE', 'EPIC'];
