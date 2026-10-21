// -----------------------------------------------------------------------------
// Read-only check of a live StrategyRegistry commitment, using ONLY
// @bagprotocol/sdk (imported by path inside this repository) and viem.
//
//   1. the RPC is on the registry's chain          (eth_chainId)
//   2. the registry contract exists there          (eth_getCode, non-empty)
//   3. the bag.json parses; its definitionHash is recomputed locally
//   4. the registry holds that hash for (expected creator, ref.strategyId, ref.version)
//
// It reads; it never signs or sends a transaction, and it needs no key. The
// creator is YOUR input: the document's own claims are not trusted.
//
// Usage (RPC_URL from your environment; it is never printed):
//   RPC_URL=... npx tsx packages/bag-sdk/examples/verify-registry.ts <bag.json path|URL> <expectedCreator> [registryAddress]
//
// Exit code: 0 PASS, 1 FAIL, 2 usage, 3 BLOCKED (RPC or bag.json URL unreachable).
// -----------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, type Hex } from 'viem';
import { chainIdOf, hashBag, normalizeBag, parseBag, STRATEGY_REGISTRY_DEPLOYMENTS, verifyRegistryCommitment, type RegistryClient } from '../src/index';
import { fetchBag } from '../src/adapters/http';

/** The reads this check makes: chain id, contract code, and the registry views. No wallet methods. */
export interface RegistryReadClient extends RegistryClient {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
}

export interface VerifyRegistryOptions {
  source: string;
  expectedCreator: string;
  client: RegistryReadClient;
  /** Overrides the known deployment for the bag's chain. */
  registry?: Hex;
  readText?: (path: string) => Promise<string>;
  fetch?: typeof fetch;
}

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';

export interface VerifyRegistryReport {
  verdict: Verdict;
  registry: { chainId: number; address: Hex } | null;
  checks: { name: string; ok: boolean; detail: string }[];
  blockedReason?: string;
}

/** First line of an error, with any URL removed (an RPC URL can carry a key). */
export function safeError(e: unknown): string {
  const raw = (e as { shortMessage?: string }).shortMessage ?? (e as Error)?.message ?? String(e);
  return raw.split('\n')[0].replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
}

export async function verifyRegistry(o: VerifyRegistryOptions): Promise<VerifyRegistryReport> {
  const checks: VerifyRegistryReport['checks'] = [];
  const finish = (registry: VerifyRegistryReport['registry'], blockedReason?: string): VerifyRegistryReport => ({
    verdict: blockedReason ? 'BLOCKED' : checks.length > 0 && checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
    registry,
    checks,
    ...(blockedReason ? { blockedReason } : {}),
  });

  const isUrl = /^https?:\/\//.test(o.source);
  let parsed: Awaited<ReturnType<typeof fetchBag>>;
  try {
    parsed = isUrl ? await fetchBag(o.source, { fetch: o.fetch }) : parseBag(await (o.readText ?? ((p) => readFile(p, 'utf8')))(o.source));
  } catch (e) {
    if (!isUrl) throw e;
    // The server answering "not found" is a result; anything else (refused, proxy, timeout) means it could not be checked.
    if (/answered (404|410)\b/.test((e as Error).message)) {
      checks.push({ name: 'BAG_JSON_FETCH', ok: false, detail: safeError(e) });
      return finish(null);
    }
    return finish(null, `bag.json URL unreachable: ${safeError(e)}`);
  }
  checks.push({ name: 'BAG_JSON_PARSES', ok: parsed.ok, detail: parsed.ok ? 'ok' : parsed.issues.map((i) => i.code).join(', ') });
  if (!parsed.ok) return finish(null);

  const bag = normalizeBag(parsed.bag);
  const chainId = chainIdOf(bag.definition.chain);
  const known = STRATEGY_REGISTRY_DEPLOYMENTS[bag.definition.chain];
  const address = o.registry ?? known?.address;
  if (!address) {
    checks.push({ name: 'REGISTRY_KNOWN', ok: false, detail: `no StrategyRegistry is known on ${bag.definition.chain}; pass its address` });
    return finish(null);
  }
  const registry = { chainId, address };

  const recomputed = hashBag(bag);
  if (bag.definitionHash) {
    // Informational: the stated hash is the document's claim; the registry check below is what counts.
    checks.push({ name: 'STATED_HASH_MATCHES', ok: bag.definitionHash.toLowerCase() === recomputed, detail: `stated ${bag.definitionHash}, recomputed ${recomputed}` });
  }

  let v: Awaited<ReturnType<typeof verifyRegistryCommitment>>;
  try {
    v = await verifyRegistryCommitment({ bag, expectedCreator: o.expectedCreator, registry: address, client: o.client });
  } catch (e) {
    return finish(registry, `registry read failed: ${safeError(e)}`);
  }
  checks.push(...v.checks);
  return finish(registry);
}

async function main() {
  const [source, expectedCreator, registry] = process.argv.slice(2);
  const rpcUrl = process.env.RPC_URL;
  if (!source || !expectedCreator || !rpcUrl) {
    console.error('Usage: RPC_URL=... npx tsx verify-registry.ts <bag.json path|URL> <expectedCreator> [registryAddress]');
    process.exit(2);
  }
  // A public client only: there is no account, so nothing here can sign or send.
  const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as RegistryReadClient;
  const report = await verifyRegistry({ source, expectedCreator, client, registry: registry as Hex | undefined });
  for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
  if (report.blockedReason) console.log(`BLOCKED  ${report.blockedReason}`);
  console.log(`VERDICT ${report.verdict}`);
  process.exit(report.verdict === 'PASS' ? 0 : report.verdict === 'BLOCKED' ? 3 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(safeError(e));
    process.exit(1);
  });
}
