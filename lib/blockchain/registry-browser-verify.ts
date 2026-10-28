import { isBagChain, parseBag, STRATEGY_REGISTRY_DEPLOYMENTS, verifyRegistryCommitment, type RegistryClient } from '@/packages/bag-sdk/src';

// -----------------------------------------------------------------------------
// Independent re-check of a Bag's StrategyRegistry commitments, run in the
// viewer's browser with the standalone SDK (packages/bag-sdk) instead of BAG's
// own record. For each version BAG reports as registered:
//
//   bag.json as served → hash recomputed locally
//   → the registry the SDK knows for the chain (not BAG's configured address)
//   → read through the browser's own RPC client
//   → committed hash for (creator, strategy, version) == recomputed hash
//
// BAG supplies the document and the creator address (both shown to the viewer);
// the chain supplies the commitment. Nothing is signed or sent.
// -----------------------------------------------------------------------------

export type BrowserCheck =
  | { version: number; state: 'VERIFIED' }
  | { version: number; state: 'MISMATCH'; detail: string }
  | { version: number; state: 'UNAVAILABLE'; detail: string };

export interface BrowserVerifyInput {
  bagId: string;
  chain: string;
  creatorWallet: string;
  /** BAG's configured registry: only compared with the SDK's, never used for the read. */
  serverRegistryAddress: string | null;
  versions: number[];
  client: RegistryClient;
  fetchFn?: typeof fetch;
}

export interface BrowserVerifyResult {
  registry: string | null;
  /** True when BAG's configured registry is not the one the SDK knows for the chain. */
  registryMismatch: boolean;
  checks: BrowserCheck[];
}

export async function verifyRegistrationsInBrowser(input: BrowserVerifyInput): Promise<BrowserVerifyResult> {
  const deployment = isBagChain(input.chain) ? STRATEGY_REGISTRY_DEPLOYMENTS[input.chain] : undefined;
  if (!deployment) {
    return { registry: null, registryMismatch: false, checks: input.versions.map((version) => ({ version, state: 'UNAVAILABLE', detail: `No known StrategyRegistry on ${input.chain}.` })) };
  }
  const registryMismatch = !!input.serverRegistryAddress && input.serverRegistryAddress.toLowerCase() !== deployment.address.toLowerCase();

  const doFetch = input.fetchFn ?? fetch;
  const checks: BrowserCheck[] = [];
  for (const version of input.versions) {
    try {
      const res = await doFetch(`/api/strategies/${encodeURIComponent(input.bagId)}/versions/${version}`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        checks.push({ version, state: 'UNAVAILABLE', detail: `bag.json for v${version} could not be loaded (${res.status}).` });
        continue;
      }
      const parsed = parseBag(await res.text());
      if (!parsed.ok) {
        checks.push({ version, state: 'MISMATCH', detail: `bag.json for v${version} does not parse: ${parsed.issues.map((i) => i.code).join(', ')}.` });
        continue;
      }
      const v = await verifyRegistryCommitment({ bag: parsed.bag, expectedCreator: input.creatorWallet, registry: deployment.address, client: input.client });
      if (v.verified) checks.push({ version, state: 'VERIFIED' });
      else {
        const failed = v.checks.filter((c) => !c.ok);
        const rpcUnavailable = failed.some((c) => c.name === 'RPC_CHAIN_MATCHES_STRATEGY');
        checks.push({ version, state: rpcUnavailable ? 'UNAVAILABLE' : 'MISMATCH', detail: failed.map((c) => c.detail).join('; ') });
      }
    } catch {
      checks.push({ version, state: 'UNAVAILABLE', detail: `v${version} could not be checked from your browser.` });
    }
  }
  return { registry: deployment.address, registryMismatch, checks };
}
