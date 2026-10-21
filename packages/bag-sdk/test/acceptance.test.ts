import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import {
  checkRegistryCommitment,
  hashBag,
  NATIVE_TOKEN,
  normalizeBag,
  parseBag,
  registryStrategyId,
  validateBag,
  verifyRegistryCommitment,
  type BagDocument,
  type ContractReader,
  type RegistryClient,
} from '../src';
import { fetchBag, MAX_BAG_JSON_BYTES } from '../src/adapters/http';
import { readTokenDecimals } from '../src/adapters/evm';
import { EXTERNAL_DEFINITION_HASH, externalBag, externalBagText } from './helpers';

// -----------------------------------------------------------------------------
// Acceptance: a third party with only a bag.json (a file or a URL) — no BAG
// frontend, server or database — can parse → validate → normalize → hash it,
// and verify it against StrategyRegistry with an RPC they own. The real
// contract is exercised in contracts/test/BagSdkRegistry.test.ts; here the
// registry is an in-memory model with the contract's read semantics.
// -----------------------------------------------------------------------------

const CREATOR = '0x1111111111111111111111111111111111111111';
const IMPOSTOR = '0x2222222222222222222222222222222222222222';
const STRATEGY = '33333333-3333-4333-8333-333333333333';
const REGISTRY = '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** In-memory StrategyRegistry: strategyOf + definitionHashOf, as the contract answers them. */
function fakeRegistry(entries: { creator: string; uuid: string; hashes: Hex[] }[]): RegistryClient {
  const byId = new Map(entries.map((e) => [registryStrategyId(e.creator, e.uuid).toLowerCase(), e] as const));
  return {
    getChainId: async () => 4663,
    getCode: async () => '0x6000',
    async readContract({ functionName, args }) {
      const e = byId.get(String(args![0]).toLowerCase());
      if (functionName === 'strategyOf') return { creator: e?.creator ?? ZERO, latestVersion: e?.hashes.length ?? 0, forkOfStrategyId: ZERO32, forkOfVersion: 0 };
      if (functionName === 'definitionHashOf') return e?.hashes[Number(args![1]) - 1] ?? ZERO32;
      throw new Error(functionName);
    },
  };
}

const servedDoc = (version = 1): BagDocument => {
  const r = parseBag({ ...externalBag(), ref: { strategyId: STRATEGY, version, parentVersion: version === 1 ? null : version - 1, createdAt: '2026-10-06T00:00:00Z' } });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};

describe('third-party pipeline without any BAG record', () => {
  it('file → parse → validate → normalize → hash', () => {
    const parsed = parseBag(externalBagText());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tokens = parsed.bag.definition.assets.map((a) => ({ chain: a.chain, address: a.address, decimals: 18 }));
    const validation = validateBag(parsed.bag, { tokens });
    expect(validation.valid).toBe(true);
    const normalized = normalizeBag(parsed.bag);
    expect(normalized.definition.assets.map((a) => a.address)).toEqual(['0xa0000000000000000000000000000000000000aa', '0xb0000000000000000000000000000000000000bb']);
    expect(hashBag(normalized)).toBe(EXTERNAL_DEFINITION_HASH);
    expect(validation.definitionHash).toBe(EXTERNAL_DEFINITION_HASH);
    expect(parsed.bag.ref).toBeUndefined();
  });

  it('URL → fetchBag (caller-supplied fetch) → same result', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(externalBagText(), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const parsed = await fetchBag('https://example.org/strategies/hand.bag.json', { fetch: fetchImpl });
    expect(calls).toEqual(['https://example.org/strategies/hand.bag.json']);
    expect(parsed.ok && hashBag(parsed.bag)).toBe(EXTERNAL_DEFINITION_HASH);
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchBag('https://example.org/missing.json', { fetch: failing })).rejects.toThrow(/404/);
  });

  it('enforces the response byte limit while streaming and does not echo secret URLs', async () => {
    const multibyte = `"${'é'.repeat(Math.ceil((MAX_BAG_JSON_BYTES + 1) / 2))}"`;
    expect(multibyte.length).toBeLessThan(MAX_BAG_JSON_BYTES);
    const tooLargeUtf8 = (async () => new Response(multibyte)) as unknown as typeof fetch;
    await expect(fetchBag('https://example.org/secret?key=hidden', { fetch: tooLargeUtf8 })).rejects.toThrow(/larger than/);

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(' '.repeat(MAX_BAG_JSON_BYTES + 1)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const tooLargeStream = (async () => new Response(body)) as unknown as typeof fetch;
    await expect(fetchBag('https://example.org/large.json', { fetch: tooLargeStream })).rejects.toThrow(/larger than/);
    expect(cancelled).toBe(true);

    const networkFailure = (async () => {
      throw new Error('https://example.org/secret?key=hidden');
    }) as unknown as typeof fetch;
    const error = await fetchBag('https://example.org/secret?key=hidden', { fetch: networkFailure }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('hidden');
  });

  it('token decimals can be read with the caller’s own client', async () => {
    const parsed = parseBag(externalBagText());
    if (!parsed.ok) throw new Error('parse');
    const client: ContractReader = { readContract: async ({ functionName }) => (functionName === 'decimals' ? 18 : null) };
    const tokens = await readTokenDecimals(parsed.bag.definition, () => client);
    expect(validateBag(parsed.bag, { tokens }).valid).toBe(true);
    const six: ContractReader = { readContract: async () => 6 };
    expect(validateBag(parsed.bag, { tokens: await readTokenDecimals(parsed.bag.definition, () => six) }).errors.map((e) => e.code)).toEqual(['DECIMALS_MISMATCH', 'DECIMALS_MISMATCH']);
  });

  it('uses native ETH decimals without calling decimals() on the zero address', async () => {
    const raw = externalBag();
    raw.definition.assets[0].address = NATIVE_TOKEN;
    const parsed = parseBag(raw);
    if (!parsed.ok) throw new Error('parse');
    let calls = 0;
    const client: ContractReader = { readContract: async () => (calls++, 18) };
    const tokens = await readTokenDecimals(parsed.bag.definition, () => client);
    expect(tokens[0]).toMatchObject({ address: NATIVE_TOKEN, decimals: 18 });
    expect(calls).toBe(1);
  });
});

describe('bag.json + registry commitment → independent verification', () => {
  const registered = fakeRegistry([{ creator: CREATOR, uuid: STRATEGY, hashes: [EXTERNAL_DEFINITION_HASH as Hex] }]);

  it('registryStrategyId = keccak256(abi.encode(creator, uuid as bytes32))', () => {
    const ref = `0x${STRATEGY.replace(/-/g, '').padStart(64, '0')}` as Hex;
    expect(registryStrategyId(CREATOR, STRATEGY)).toBe(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [CREATOR, ref])));
  });

  it('verified with the expected creator', async () => {
    const v = await verifyRegistryCommitment({ bag: servedDoc(), expectedCreator: CREATOR, registry: REGISTRY, client: registered });
    expect(v.verified).toBe(true);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.checks.map((c) => c.name)).toEqual(['RPC_CHAIN_MATCHES_STRATEGY', 'REGISTRY_ADDRESS_MATCHES_KNOWN_DEPLOYMENT', 'REGISTRY_HAS_CODE', 'REF_PRESENT', 'STRATEGY_REGISTERED_BY_EXPECTED_CREATOR', 'VERSION_REGISTERED', 'DEFINITION_MATCHES_REGISTRY']);
  });

  it('the creator is a verification input: the JSON’s own registry claim is never authority', async () => {
    const bag = servedDoc();
    bag.commitments = { registry: { status: 'REGISTERED', creator: IMPOSTOR, registryStrategyId: registryStrategyId(IMPOSTOR, STRATEGY) } };
    // The JSON claims IMPOSTOR; the caller expects CREATOR → still verified against CREATOR's on-chain entry.
    expect((await verifyRegistryCommitment({ bag, expectedCreator: CREATOR, registry: REGISTRY, client: registered })).verified).toBe(true);
    // Expecting IMPOSTOR (e.g. copied from the JSON) finds nothing registered under IMPOSTOR's id.
    const asImpostor = await verifyRegistryCommitment({ bag, expectedCreator: IMPOSTOR, registry: REGISTRY, client: registered });
    expect(asImpostor.verified).toBe(false);
    expect(asImpostor.checks.find((c) => c.name === 'STRATEGY_REGISTERED_BY_EXPECTED_CREATOR')!.ok).toBe(false);
  });

  it('a tampered definition (stated hash kept) is not verified', async () => {
    const bag = servedDoc();
    bag.definitionHash = EXTERNAL_DEFINITION_HASH;
    bag.definition.assets[0].weightBps = 5000;
    bag.definition.assets[1].weightBps = 5000;
    const v = await verifyRegistryCommitment({ bag, expectedCreator: CREATOR, registry: REGISTRY, client: registered });
    expect(v.verified).toBe(false);
    expect(v.checks.find((c) => c.name === 'DEFINITION_MATCHES_REGISTRY')!.ok).toBe(false);
  });

  it('an unregistered version is not verified', async () => {
    const v = await verifyRegistryCommitment({ bag: servedDoc(2), expectedCreator: CREATOR, registry: REGISTRY, client: registered });
    expect(v.verified).toBe(false);
    expect(v.checks.find((c) => c.name === 'VERSION_REGISTERED')!.ok).toBe(false);
  });

  it('fails closed before registry reads when the RPC chain, known address, or code is wrong', async () => {
    let registryReads = 0;
    const base = fakeRegistry([{ creator: CREATOR, uuid: STRATEGY, hashes: [EXTERNAL_DEFINITION_HASH as Hex] }]);
    const tracked: RegistryClient = {
      ...base,
      async readContract(args) { registryReads++; return base.readContract(args); },
    };

    const wrongChain = await verifyRegistryCommitment({
      bag: servedDoc(), expectedCreator: CREATOR, registry: REGISTRY,
      client: { ...tracked, getChainId: async () => 1 },
    });
    expect(wrongChain.verified).toBe(false);
    expect(wrongChain.checks.find((c) => c.name === 'RPC_CHAIN_MATCHES_STRATEGY')?.ok).toBe(false);
    expect(registryReads).toBe(0);

    const wrongAddress = await verifyRegistryCommitment({
      bag: servedDoc(), expectedCreator: CREATOR, registry: '0x4444444444444444444444444444444444444444' as Hex, client: tracked,
    });
    expect(wrongAddress.checks.find((c) => c.name === 'REGISTRY_ADDRESS_MATCHES_KNOWN_DEPLOYMENT')?.ok).toBe(false);
    expect(registryReads).toBe(0);

    const noCode = await verifyRegistryCommitment({
      bag: servedDoc(), expectedCreator: CREATOR, registry: REGISTRY,
      client: { ...tracked, getCode: async () => '0x' },
    });
    expect(noCode.verified).toBe(false);
    expect(noCode.checks.find((c) => c.name === 'REGISTRY_HAS_CODE')?.ok).toBe(false);
    expect(registryReads).toBe(0);
  });

  it('a draft bag.json (no ref) can be hashed but not registry-verified, and says why', () => {
    const parsed = parseBag(externalBagText());
    if (!parsed.ok) throw new Error('parse');
    const v = checkRegistryCommitment(parsed.bag, CREATOR, null);
    expect(v.verified).toBe(false);
    expect(v.checks).toEqual([expect.objectContaining({ name: 'REF_PRESENT', ok: false })]);
  });
});
