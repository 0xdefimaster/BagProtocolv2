import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';

/** The chain's pinned settlement stablecoin (lib/config): the only asset discovery counts as a stablecoin. */
export function isSettlementStablecoin(chain: string, address: string): boolean {
  return chain === 'robinhood' && address.toLowerCase() === ROBINHOOD_REWARD_TOKEN.address.toLowerCase();
}
