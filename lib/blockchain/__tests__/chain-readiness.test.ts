import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { checkChainReadiness, runtimeMatchesArtifact, summarizeGates, type ReadinessClient } from '../chain-readiness';
import { BAG_CHAINS } from '@/lib/config/chains';

// Read-only qualification checks with a scripted chain. Synthetic addresses only (0x…b0xx); none is a real deployment.

const BASE = BAG_CHAINS.base;
const WETH = BASE.wrappedNativeAddress as Hex;
const USDC = BASE.sweepOutputToken.address as Hex;
const REGISTRY = '0x000000000000000000000000000000000000b001' as Hex;
const FACTORY = '0x000000000000000000000000000000000000b002' as Hex;
const COMPOSER = '0x000000000000000000000000000000000000b003' as Hex;
const PROXY = '0x000000000000000000000000000000000000b004' as Hex;
const SIGNER = '0x000000000000000000000000000000000000b005' as Hex;
const META = `a264697066735822${'11'.repeat(34)}64736f6c6343000818${'0033'}`; // 53-byte CBOR blob
const REGISTRY_CODE = `0x6080604052${META}` as Hex;
const COMPOSER_CODE = '0x60016002' as Hex;

function fakeChain(o: { chainId?: number; code?: Record<string, Hex>; tokens?: Record<string, [string, number]>; proxyOwner?: Hex; trace?: boolean } = {}): ReadinessClient {
  const code: Record<string, Hex> = { [WETH.toLowerCase()]: '0x01', [USDC.toLowerCase()]: '0x01', ...o.code };
  const tokens: Record<string, [string, number]> = { [WETH.toLowerCase()]: ['WETH', 18], [USDC.toLowerCase()]: ['USDC', 6], ...o.tokens };
  return {
    getChainId: async () => o.chainId ?? 8453,
    getCode: async ({ address }) => code[address.toLowerCase()],
    readContract: async ({ address, functionName }) => {
      const a = address.toLowerCase();
      if (functionName === 'symbol') return tokens[a][0];
      if (functionName === 'decimals') return tokens[a][1];
      if (functionName === 'predictProxyAddress' && a === COMPOSER.toLowerCase()) return PROXY;
      if (functionName === 'owner' && a === PROXY.toLowerCase()) return o.proxyOwner ?? SIGNER;
      if (functionName === 'factory' && a === PROXY.toLowerCase()) return COMPOSER;
      throw new Error('execution reverted');
    },
    request: async () => {
      if (o.trace) return {};
      throw new Error('method not found');
    },
  };
}
const byName = (cs: { name: string; status: string }[]) => Object.fromEntries(cs.map((c) => [c.name, c.status]));

describe('checkChainReadiness (base)', () => {
  it('nothing configured: A passes from the chain config; B and C are NOT_CONFIGURED, never defaulted; D incomplete', async () => {
    const checks = await checkChainReadiness({ chain: 'base', client: fakeChain(), env: {}, artifacts: {} });
    expect(byName(checks)).toMatchObject({
      RPC_CHAIN_ID: 'PASS',
      WRAPPED_NATIVE: 'PASS',
      SETTLEMENT_STABLECOIN: 'PASS',
      STRATEGYREGISTRY_DEPLOYED: 'NOT_CONFIGURED',
      BAGFACTORY_DEPLOYED: 'NOT_CONFIGURED',
      COMPOSER_PIN: 'NOT_CONFIGURED',
      RPC_DEBUG_TRACE_CALL: 'UNSUPPORTED',
    });
    expect(summarizeGates(checks)).toEqual({ A: 'PASS', B: 'INCOMPLETE', C: 'INCOMPLETE', D: 'INCOMPLETE' });
  });

  it("`.env.example`'s 0xdeployed-… placeholder is NOT_CONFIGURED; any other non-address is a FAIL", async () => {
    const placeholder = await checkChainReadiness({ chain: 'base', client: fakeChain(), env: { FACTORY_ADDRESS_BASE: '0xdeployed-bagfactory-address-on-base' }, artifacts: {} });
    expect(byName(placeholder).BAGFACTORY_DEPLOYED).toBe('NOT_CONFIGURED');
    const typo = await checkChainReadiness({ chain: 'base', client: fakeChain(), env: { FACTORY_ADDRESS_BASE: '0x1234' }, artifacts: {} });
    expect(byName(typo).BAGFACTORY_DEPLOYED).toBe('FAIL');
  });

  it('a wrong-chain RPC stops everything after the chain id', async () => {
    const checks = await checkChainReadiness({ chain: 'base', client: fakeChain({ chainId: 42161 }), env: {}, artifacts: {} });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'RPC_CHAIN_ID', status: 'FAIL' });
  });

  it('a token whose metadata does not match the config fails A', async () => {
    const checks = await checkChainReadiness({ chain: 'base', client: fakeChain({ tokens: { [USDC.toLowerCase()]: ['USDbC', 6] } }), env: {}, artifacts: {} });
    expect(byName(checks).SETTLEMENT_STABLECOIN).toBe('FAIL');
  });

  it('B: a configured contract must have code and match the artifact (metadata masked); a different one fails', async () => {
    const env = { STRATEGY_REGISTRY_ADDRESS_BASE: REGISTRY, FACTORY_ADDRESS_BASE: FACTORY };
    const otherMeta = REGISTRY_CODE.replace('11'.repeat(34), '22'.repeat(34)) as Hex;
    const checks = await checkChainReadiness({
      chain: 'base',
      client: fakeChain({ code: { [REGISTRY.toLowerCase()]: otherMeta } }),
      env,
      artifacts: { StrategyRegistry: { deployedBytecode: REGISTRY_CODE } },
    });
    expect(byName(checks)).toMatchObject({ STRATEGYREGISTRY_DEPLOYED: 'PASS', STRATEGYREGISTRY_BYTECODE: 'PASS', BAGFACTORY_DEPLOYED: 'FAIL' });
    const wrong = await checkChainReadiness({
      chain: 'base',
      client: fakeChain({ code: { [REGISTRY.toLowerCase()]: '0x6080604053' } }),
      env: { STRATEGY_REGISTRY_ADDRESS_BASE: REGISTRY },
      artifacts: { StrategyRegistry: { deployedBytecode: REGISTRY_CODE } },
    });
    expect(byName(wrong).STRATEGYREGISTRY_BYTECODE).toBe('FAIL');
  });

  it('C: the per-chain pin must match the live code hash, and the signer’s proxy must be owned by the signer', async () => {
    const env = { COMPOSER_FACTORY_BASE: COMPOSER, COMPOSER_FACTORY_CODE_HASH_BASE: keccak256(COMPOSER_CODE), COMPOSER_TEST_SIGNER: SIGNER };
    const ok = await checkChainReadiness({ chain: 'base', client: fakeChain({ code: { [COMPOSER.toLowerCase()]: COMPOSER_CODE, [PROXY.toLowerCase()]: '0x01' } }), env, artifacts: {} });
    expect(byName(ok)).toMatchObject({ COMPOSER_FACTORY_CODE_HASH: 'PASS', COMPOSER_PROXY_PREDICTION: 'PASS' });
    expect(summarizeGates(ok).C).toBe('PASS');

    const badHash = await checkChainReadiness({ chain: 'base', client: fakeChain({ code: { [COMPOSER.toLowerCase()]: '0x60016003' } }), env, artifacts: {} });
    expect(byName(badHash).COMPOSER_FACTORY_CODE_HASH).toBe('FAIL');

    const notOwner = await checkChainReadiness({
      chain: 'base',
      client: fakeChain({ code: { [COMPOSER.toLowerCase()]: COMPOSER_CODE, [PROXY.toLowerCase()]: '0x01' }, proxyOwner: REGISTRY }),
      env,
      artifacts: {},
    });
    expect(byName(notOwner).COMPOSER_PROXY_PREDICTION).toBe('FAIL');
  });

  it('the Robinhood pin is not read for Base: only *_BASE variables count', async () => {
    const env = { COMPOSER_FACTORY_ROBINHOOD: COMPOSER, COMPOSER_FACTORY_CODE_HASH_ROBINHOOD: keccak256(COMPOSER_CODE), COMPOSER_FACTORY: COMPOSER };
    const checks = await checkChainReadiness({ chain: 'base', client: fakeChain({ code: { [COMPOSER.toLowerCase()]: COMPOSER_CODE } }), env, artifacts: {} });
    expect(byName(checks).COMPOSER_PIN).toBe('NOT_CONFIGURED');
  });

  it('D is never PASS from read-only checks, even when the RPC serves debug_traceCall', async () => {
    const checks = await checkChainReadiness({ chain: 'base', client: fakeChain({ trace: true }), env: {}, artifacts: {} });
    expect(byName(checks).RPC_DEBUG_TRACE_CALL).toBe('PASS');
    expect(summarizeGates(checks).D).toBe('INCOMPLETE');
  });
});

describe('runtimeMatchesArtifact', () => {
  it('masks immutables and metadata, not code', () => {
    const art = { deployedBytecode: `0x60aa${'00'.repeat(4)}${META}` as Hex, immutableReferences: { '1': [{ start: 2, length: 4 }] } };
    expect(runtimeMatchesArtifact(`0x60aa${'ff'.repeat(4)}${META}` as Hex, art)).toMatchObject({ masked: true, exact: false });
    expect(runtimeMatchesArtifact(`0x60ab${'ff'.repeat(4)}${META}` as Hex, art).masked).toBe(false);
    expect(runtimeMatchesArtifact(undefined, art).masked).toBe(false);
  });
});
