// -----------------------------------------------------------------------------
// The ONE chain table of bag.json v1. Nothing else in the SDK lists chains.
//
// `definition.chain` and `assets[].chain` hold the slug, and the slug (not the
// chain id) is what `definitionHash` covers, so every reader must map it the
// same way. The enum is closed: adding a chain changes what v1 accepts, so it
// comes only with a controlled spec version, never as a silent addition.
// -----------------------------------------------------------------------------

/** bag.json v1's closed chain enum. Exported as a tuple for runtimes (e.g. Zod) to reuse without widening it. */
export const BAG_V1_CHAIN_SLUGS = Object.freeze(['ethereum', 'base', 'arbitrum', 'robinhood'] as const);

export type BagChain = (typeof BAG_V1_CHAIN_SLUGS)[number];

/** bag.json v1 chain slug → EIP-155 chain id. Closed; frozen with v1. */
export const BAG_V1_CHAINS = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  robinhood: 4663,
} as const satisfies Record<BagChain, number>;

export function isBagChain(value: unknown): value is BagChain {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BAG_V1_CHAINS, value);
}

/** EIP-155 chain id of a v1 chain slug. */
export function chainIdOf(chain: BagChain): number {
  return BAG_V1_CHAINS[chain];
}

/**
 * The chain's native coin (ETH on every v1 chain) as a purchase input: the zero address, the same sentinel BAG
 * uses. It is never an ERC-20: it is paid as the transaction's value, with no approval.
 */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

export function isNativeToken(address: string): boolean {
  return address.trim().toLowerCase() === NATIVE_TOKEN;
}

/** Every v1 chain is EVM: addresses are 20-byte hex, case-insensitive, compared lowercase. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
