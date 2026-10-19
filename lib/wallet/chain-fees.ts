// -----------------------------------------------------------------------------
// Fee hints for chains the wallet has no fee-market data for.
//
// MetaMask does not know Robinhood Chain's fee market: it shows 0 GWEI base and
// priority fees, falls back to a fee per gas ~100× the chain's real one, and then
// reports "not enough ETH" for a wallet that holds far more than the real cost.
// For a chain marked `walletFeeHints` in lib/config/chains.ts, an
// `eth_sendTransaction` that carries no fee fields gets EIP-1559 fees read from
// the chain itself (through the wallet's own RPC): maxFeePerGas = 2 × latest base
// fee + the node's priority fee. The gas LIMIT stays with the wallet: a smart
// account may wrap the call (DelegationManager) and must size that itself.
//
// Any failure while reading fees sends the request unchanged, so this can only
// replace the wallet's guess, never block a transaction.
// -----------------------------------------------------------------------------

import { hexToBigInt, numberToHex, type Hex } from 'viem';
import { bagChainByChainId } from '@/lib/config/chains';
import type { Eip1193Provider } from './eth-provider';

type TxParams = Record<string, unknown>;

const FEE_FIELDS = ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
const BASE_FEE_MULTIPLIER = BigInt(2);

const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);

/** Fee fields for `tx`, or null when the chain is not marked, the caller already chose fees or a type, or a read fails. */
export async function chainFeeHints(provider: Pick<Eip1193Provider, 'request'>, tx: TxParams): Promise<TxParams | null> {
  if (FEE_FIELDS.some((f) => tx[f] !== undefined) || tx.type !== undefined) return null;
  try {
    const rawChainId = isHex(tx.chainId) ? tx.chainId : await provider.request({ method: 'eth_chainId' });
    if (!isHex(rawChainId)) return null;
    if (!bagChainByChainId(Number(hexToBigInt(rawChainId)))?.walletFeeHints) return null;

    const block = (await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as { baseFeePerGas?: unknown } | null;
    if (block && isHex(block.baseFeePerGas)) {
      let priority = BigInt(0);
      try {
        const p = await provider.request({ method: 'eth_maxPriorityFeePerGas' });
        if (isHex(p)) priority = hexToBigInt(p);
      } catch {
        // Not every node serves it; Arbitrum Orbit chains ignore the tip anyway.
      }
      const maxFee = hexToBigInt(block.baseFeePerGas) * BASE_FEE_MULTIPLIER + priority;
      return { maxFeePerGas: numberToHex(maxFee), maxPriorityFeePerGas: numberToHex(priority) };
    }
    // No base fee: a legacy-priced chain.
    const gasPrice = await provider.request({ method: 'eth_gasPrice' });
    return isHex(gasPrice) ? { gasPrice } : null;
  } catch {
    return null;
  }
}

const wrapped = new WeakMap<Eip1193Provider, Eip1193Provider>();

/** The same provider, with fee hints added to `eth_sendTransaction` on marked chains. Memoized, so listeners added through it can be removed through it. */
export function withChainFeeHints(provider: Eip1193Provider): Eip1193Provider {
  const existing = wrapped.get(provider);
  if (existing) return existing;
  const request: Eip1193Provider['request'] = async (args) => {
    if (args.method === 'eth_sendTransaction' && Array.isArray(args.params) && args.params[0] && typeof args.params[0] === 'object') {
      const tx = args.params[0] as TxParams;
      const hints = await chainFeeHints(provider, tx);
      if (hints) return provider.request({ method: args.method, params: [{ ...tx, ...hints }, ...args.params.slice(1)] });
    }
    return provider.request(args);
  };
  const proxy = new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') return request;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  wrapped.set(provider, proxy);
  return proxy;
}
