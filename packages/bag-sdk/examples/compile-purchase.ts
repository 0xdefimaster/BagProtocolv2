// -----------------------------------------------------------------------------
// A third-party script. It uses ONLY @bagprotocol/sdk (imported by path inside
// this repository): no BAG frontend, server, database or app code.
//
//   bag.json (file or URL) → parse → validate → normalize → hash → [verify]
//   → quote → simulate → compile → UNSIGNED Composer transaction
//
// It never signs or sends. Your wallet signs the approvals and the transaction.
// A purchase made this way is an execution of the strategy into your own
// wallet, not a BAG position: BAG's ledger and fees do not apply to it.
//
// Usage (your own credentials, read from YOUR environment; never printed):
//   LIFI_API_KEY=...  RPC_URL=...  [COMPOSER_URL=...]  npx tsx packages/bag-sdk/examples/compile-purchase.ts \
//     <bag.json path or URL> <inputToken> <amountRaw> <signer> [registry expectedCreator]
// -----------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, type Hex } from 'viem';
import { chainIdOf, compileBag, hashBag, normalizeBag, parseBag, simulateBag, validateBag, verifyRegistryCommitment, type ComposerProvider, type ContractReader, type SimulationClient } from '../src/index';
import { fetchBag } from '../src/adapters/http';
import { readTokenDecimals } from '../src/adapters/evm';
import { lifiComposer } from '../src/adapters/lifi';

export interface RunOptions {
  source: string;
  inputToken: string;
  amountRaw: bigint;
  signer: string;
  provider: ComposerProvider;
  allowedTransactionTargets: string[];
  allowedApprovalSpenders: string[];
  client: SimulationClient & ContractReader;
  registry?: { address: Hex; expectedCreator: string };
  readText?: (path: string) => Promise<string>;
  fetch?: typeof fetch;
}

/** Runs the whole pipeline and returns a printable report. Throws on the first step that cannot continue. */
export async function run(o: RunOptions) {
  const report: Record<string, unknown> = {};
  const parsed = /^https?:\/\//.test(o.source) ? await fetchBag(o.source, { fetch: o.fetch }) : parseBag(await (o.readText ?? ((p) => readFile(p, 'utf8')))(o.source));
  report.parse = parsed.ok ? 'ok' : parsed.issues;
  if (!parsed.ok) return report;

  const tokens = await readTokenDecimals(parsed.bag.definition, () => o.client);
  const validation = validateBag(parsed.bag, { tokens });
  report.validate = validation.valid ? 'ok' : validation.errors;
  if (!validation.valid) return report;

  const bag = normalizeBag(parsed.bag);
  report.definitionHash = hashBag(bag);

  if (o.registry) {
    const v = await verifyRegistryCommitment({ bag, expectedCreator: o.registry.expectedCreator, registry: o.registry.address, client: o.client });
    report.verify = v.verified ? 'verified' : v.checks.filter((c) => !c.ok);
  }

  const compiled = await compileBag(
    bag,
    { inputToken: o.inputToken, amountRaw: o.amountRaw, signer: o.signer, tokens },
    {
      provider: o.provider,
      trust: {
        chainId: chainIdOf(bag.definition.chain),
        allowedTransactionTargets: o.allowedTransactionTargets,
        allowedApprovalSpenders: o.allowedApprovalSpenders,
      },
    }
  );
  const q = compiled.quote;
  report.quote = {
    provider: q.provider,
    accounting: q.plan.accounting,
    slippageBps: q.plan.slippageBps,
    maxPriceImpactBps: q.plan.maxPriceImpactBps,
    priceImpactBps: q.priceImpactBps,
    kept: q.plan.kept && { token: q.plan.kept.token, amountRaw: String(q.plan.kept.amountRaw) },
    legs: q.legs.map((l) => ({ token: l.token, targetInputRaw: String(l.targetInputRaw), expectedOutRaw: l.expectedOutRaw, minOutRaw: l.minOutRaw })),
  };
  report.simulate = await simulateBag(compiled, { client: o.client });
  report.approvals = compiled.approvals.map((a) => ({ token: a.token, spender: a.spender, amountRaw: String(a.amountRaw) }));
  report.unsignedTransaction = { to: compiled.transaction.to, data: compiled.transaction.data, value: String(compiled.transaction.value), chainId: compiled.transaction.chainId };
  return report;
}

async function main() {
  const [source, inputToken, amountRaw, signer, registry, expectedCreator] = process.argv.slice(2);
  const apiKey = process.env.LIFI_API_KEY;
  const rpcUrl = process.env.RPC_URL;
  const allowedTransactionTargets = (process.env.COMPOSER_TRUSTED_TARGETS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const allowedApprovalSpenders = (process.env.COMPOSER_TRUSTED_SPENDERS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!source || !inputToken || !amountRaw || !signer || !apiKey || !rpcUrl || allowedTransactionTargets.length === 0) {
    console.error('Usage: LIFI_API_KEY=... RPC_URL=... COMPOSER_TRUSTED_TARGETS=0x... [COMPOSER_TRUSTED_SPENDERS=0x...,0x...] npx tsx compile-purchase.ts <bag.json path|URL> <inputToken> <amountRaw> <signer> [registry expectedCreator]');
    process.exit(2);
  }
  // LI.FI's production Composer API (docs.li.fi quickstart; what BAG uses). Override with COMPOSER_URL.
  const baseUrl = process.env.COMPOSER_URL ?? 'https://composer.li.quest';
  const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as SimulationClient & ContractReader;
  const report = await run({
    source,
    inputToken,
    amountRaw: BigInt(amountRaw),
    signer,
    provider: lifiComposer({ apiKey, baseUrl }),
    allowedTransactionTargets,
    allowedApprovalSpenders,
    client,
    registry: registry && expectedCreator ? { address: registry as Hex, expectedCreator } : undefined,
  });
  // simulate can carry bigint amounts (INSUFFICIENT_BALANCE); print them as decimal strings.
  console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error((e as Error).message.split('\n')[0]);
    process.exit(1);
  });
}
