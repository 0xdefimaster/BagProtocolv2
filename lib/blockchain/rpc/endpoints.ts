import { BAG_CHAINS, BagChain } from '@/lib/config/chains';

// Ordered RPC endpoints for a chain (see lib/config/chains.ts for the policy).
// Server-only: the Alchemy URL embeds ALCHEMY_API_KEY and must never reach a
// browser bundle. Browser code keeps using the chain's public RPC.

export type RpcTier = 'primary' | 'secondary' | 'public';

export interface RpcEndpoint {
  tier: RpcTier;
  /** 'alchemy' | 'custom' | 'public' — for logs and health reporting. */
  provider: 'alchemy' | 'custom' | 'public';
  url: string;
}

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function resolveRpcEndpoints(chain: BagChain, env: Env = process.env): RpcEndpoint[] {
  const cfg = BAG_CHAINS[chain];
  const key = chain.toUpperCase();
  const out: RpcEndpoint[] = [];

  const explicit = nonEmpty(env[`${key}_RPC_URL`]) ?? nonEmpty(env[`RPC_URL_${key}`]);
  const alchemyKey = nonEmpty(env.ALCHEMY_API_KEY);
  if (explicit) {
    out.push({ tier: 'primary', provider: explicit.includes('.alchemy.com') ? 'alchemy' : 'custom', url: explicit });
  } else if (alchemyKey) {
    out.push({ tier: 'primary', provider: 'alchemy', url: `https://${cfg.alchemyNetwork}.g.alchemy.com/v2/${alchemyKey}` });
  }

  const secondary = nonEmpty(env[`${key}_RPC_URL_SECONDARY`]);
  if (secondary) out.push({ tier: 'secondary', provider: 'custom', url: secondary });

  if (env.RPC_PUBLIC_FALLBACK !== 'false') {
    for (const url of cfg.publicRpcUrls) out.push({ tier: 'public', provider: 'public', url });
  }

  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

/** Strips credentials (Alchemy/QuickNode keys live in the path or query) so an endpoint can be logged. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' || u.pathname === '' ? '' : '/…'}`;
  } catch {
    return '<invalid-url>';
  }
}
