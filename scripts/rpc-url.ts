// The RPC a CLI script talks to — the SAME choice the app makes
// (lib/blockchain/rpc/endpoints.ts): `<CHAIN>_RPC_URL` (or legacy
// `RPC_URL_<CHAIN>`), else Alchemy from ALCHEMY_API_KEY, else the chain's
// public RPC. One resolver, so a script never quietly uses a different
// endpoint than the server that later verifies its transactions.
import { resolveRpcEndpoints, redactRpcUrl } from '../lib/blockchain/rpc/endpoints';
import type { BagChain } from '../lib/config/chains';

export function scriptRpcUrl(chain: BagChain): string {
  const first = resolveRpcEndpoints(chain)[0];
  if (!first) {
    throw new Error(`No RPC endpoint for ${chain}: set ${chain.toUpperCase()}_RPC_URL or ALCHEMY_API_KEY.`);
  }
  console.log(`RPC for ${chain}: ${redactRpcUrl(first.url)} (${first.provider})`);
  return first.url;
}
