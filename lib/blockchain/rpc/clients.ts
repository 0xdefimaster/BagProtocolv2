import { createPublicClient, custom, type PublicClient, type Transport } from 'viem';
import { BAG_CHAINS, BagChain } from '@/lib/config/chains';
import { resolveRpcEndpoints } from './endpoints';
import { ResilientRpc } from './resilient-rpc';

// -----------------------------------------------------------------------------
// The ONE way server code gets chain access. `getChainPublicClient(chain)` is
// a normal viem PublicClient (balances, eth_call, allowance, estimateGas,
// logs, receipts, blocks, oracle reads); `getChainTransport(chain)` plugs the
// same resilient layer into a wallet client for the few server-side senders
// (e.g. the creator-rewards settlement worker), so their
// eth_sendRawTransaction gets the hash-checked broadcast path.
//
// Memoized per (chain, endpoint list): health/circuit state is shared across
// requests, and an env change (tests, redeploy) yields a fresh instance.
//
// Server-only. Browser code must not import this (the Alchemy URL contains
// ALCHEMY_API_KEY); browser reads keep using the chain's public RPC.
// -----------------------------------------------------------------------------

const rpcs = new Map<string, ResilientRpc>();
const clients = new Map<string, PublicClient>();

function signature(chain: BagChain): string {
  return `${chain}|${resolveRpcEndpoints(chain).map((e) => e.url).join('|')}`;
}

export function getChainRpc(chain: BagChain): ResilientRpc {
  const key = signature(chain);
  let rpc = rpcs.get(key);
  if (!rpc) {
    rpc = new ResilientRpc({ chain, endpoints: resolveRpcEndpoints(chain) });
    rpcs.set(key, rpc);
  }
  return rpc;
}

/** True when at least one RPC endpoint (primary, secondary or public) exists for the chain. */
export function hasRpcEndpoint(chain: BagChain): boolean {
  return resolveRpcEndpoints(chain).length > 0;
}

export function getChainTransport(chain: BagChain): Transport {
  const rpc = getChainRpc(chain);
  // retryCount 0: retries, failover and backoff are the resilient layer's job.
  return custom({ request: ({ method, params }) => rpc.request(method, params as unknown[] | undefined) }, { retryCount: 0 });
}

export function getChainPublicClient(chain: BagChain): PublicClient {
  const key = signature(chain);
  let client = clients.get(key);
  if (!client) {
    client = createPublicClient({ chain: BAG_CHAINS[chain].viemChain, transport: getChainTransport(chain) }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}

/** Test-only. */
export function __resetChainClientsForTests(): void {
  rpcs.clear();
  clients.clear();
}
