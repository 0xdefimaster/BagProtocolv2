// -----------------------------------------------------------------------------
// The ONE chain table of bag.json v1. Nothing else in the SDK lists chains.
//
// `definition.chain` and `assets[].chain` hold the slug, and the slug (not the
// chain id) is what `definitionHash` covers, so every reader must map it the
// same way. The enum is closed: adding a chain changes what v1 accepts, so it
// comes only with a controlled spec version, never as a silent addition.
// -----------------------------------------------------------------------------

/** bag.json v1 chain slug → EIP-155 chain id. Closed; frozen with v1. */
export const BAG_V1_CHAINS = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  robinhood: 4663,
} as const;

export type BagChain = keyof typeof BAG_V1_CHAINS;

export const BAG_V1_CHAIN_SLUGS = Object.freeze(Object.keys(BAG_V1_CHAINS) as BagChain[]);

export function isBagChain(value: unknown): value is BagChain {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BAG_V1_CHAINS, value);
}

/** EIP-155 chain id of a v1 chain slug. */
export function chainIdOf(chain: BagChain): number {
  return BAG_V1_CHAINS[chain];
}

/** Every v1 chain is EVM: addresses are 20-byte hex, case-insensitive, compared lowercase. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
