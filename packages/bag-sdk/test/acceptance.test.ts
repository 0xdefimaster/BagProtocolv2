import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import {
  checkRegistryCommitment,
  hashBag,
  normalizeBag,
  parseBag,
  registryStrategyId,
  validateBag,
  verifyRegistryCommitment,
  type BagDocument,
  type ContractReader,
  type RegistryVerificationClient,
} from '../src';
import { fetchBag } from '../src/adapters/http';
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
const REGISTRY = '0x4444444444444444444444444444444444444444' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** In-memory StrategyRegistry: chain id, code existence and the view results it exposes. */
function fakeRegistry(
  entries: { creator: string; uuid: string; hashes: Hex[] }[],
  options: { chainId?: number; code?: Hex } = {},
): RegistryVerificationClient & { readCount(): number } {
  const byId = new Map(entries.map((e) => [registryStrategyId(e.creator, e.uuid).toLowerCase(), e] as const));
  let reads = 0;
  return {
    async getChainId() {
      return options.chainId ?? 4663;
    },
    async getCode() {
      return options.code ?? ('0x60006000' as Hex);
    },
    readCount() {
      return reads;
    },
    async readContract({ functionName, args }) {
      reads++;
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

  it('token decimals can be read with the caller’s own client', async () => {
    const parsed = parseBag(externalBagText());
    if (!parsed.ok) throw new Error('parse');
    const client: ContractReader = { readContract: async ({ functionName }) => (functionName === 'decimals' ? 18 : null) };
    const tokens = await readTokenDecimals(parsed.bag.definition, () => client);
    expect(validateBag(parsed.bag, { tokens }).valid).toBe(true);
    const six: ContractReader = { readContract: async () => 6 };
    expect(validateBag(parsed.bag, { tokens: await readTokenDecimals(parsed.bag.definition, () => six) }).errors.map((e) => e.code)).toEqual(['DECIMALS_MISMATCH', 'DECIMALS_MISMATCH']);
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
    expect(v.checks.map((c) => c.ok)).toEqual([true, true, true, true]);
  });

  it('fails closed before registry reads on a wrong RPC chain or an address without contract code', async () => {
    const entries = [{ creator: CREATOR, uuid: STRATEGY, hashes: [EXTERNAL_DEFINITION_HASH as Hex] }];
    const wrongChain = fakeRegistry(entries, { chainId: 1 });
    const wrongChainResult = await verifyRegistryCommitment({ bag: servedDoc(), expectedCreator: CREATOR, registry: REGISTRY, client: wrongChain });
    expect(wrongChainResult.verified).toBe(false);
    expect(wrongChainResult.preflightChecks).toEqual([
      expect.objectContaining({ name: 'RPC_CHAIN_ID', ok: false }),
    ]);
    expect(wrongChain.readCount()).toBe(0);

    const noCode = fakeRegistry(entries, { code: '0x' as Hex });
    const noCodeResult = await verifyRegistryCommitment({ bag: servedDoc(), expectedCreator: CREATOR, registry: REGISTRY, client: noCode });
    expect(noCodeResult.verified).toBe(false);
    expect(noCodeResult.preflightChecks).toEqual([
      expect.objectContaining({ name: 'RPC_CHAIN_ID', ok: true }),
      expect.objectContaining({ name: 'REGISTRY_HAS_CODE', ok: false }),
    ]);
    expect(noCode.readCount()).toBe(0);
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

  it('a draft bag.json (no ref) can be hashed but not registry-verified, and says why', () => {
    const parsed = parseBag(externalBagText());
    if (!parsed.ok) throw new Error('parse');
    const v = checkRegistryCommitment(parsed.bag, CREATOR, null);
    expect(v.verified).toBe(false);
    expect(v.checks).toEqual([expect.objectContaining({ name: 'REF_PRESENT', ok: false })]);
  });
});
