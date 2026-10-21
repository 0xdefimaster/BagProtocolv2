import { isNativeToken } from '../chains';
import type { BagChain } from '../chains';
import type { ContractReader } from '../registry';
import type { BagDefinition } from '../types';
import type { TokenInfo } from '../validate';

// -----------------------------------------------------------------------------
// Chain adapter: token facts for `validateBag(bag, { tokens })`. The caller
// passes its own viem client per chain; the SDK has no RPC.
// -----------------------------------------------------------------------------

const ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

/** Reads ERC-20 decimals and resolves native ETH's known 18 decimals without calling decimals() on address(0). */
export async function readTokenDecimals(definition: BagDefinition, clientFor: (chain: BagChain) => ContractReader): Promise<TokenInfo[]> {
  return Promise.all(
    definition.assets.map(async (a) => ({
      chain: a.chain,
      address: a.address,
      decimals: isNativeToken(a.address)
        ? 18
        : Number(await clientFor(a.chain).readContract({ address: a.address as `0x${string}`, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })),
    }))
  );
}
