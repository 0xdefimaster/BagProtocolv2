import { getAddress, keccak256, type Hex } from 'viem';
import { BAG_CHAINS, type BagChain } from '@/lib/config/chains';

// -----------------------------------------------------------------------------
// Read-only chain qualification checks (docs/chains/BASE_READINESS.md, gates A–D).
//
// Everything here READS: chain id, token metadata, contract code, view calls.
// Nothing signs, sends, or reads a key. No address is ever defaulted: BAG
// contract addresses and the Composer pin come from the caller's environment,
// and an unset one is reported NOT_CONFIGURED — never guessed, never borrowed
// from another chain.
//
// A chain is production-qualified only when gates A–E all hold with evidence;
// this module can establish A, B and C and probe the RPC for D. A live
// purchase/receipt (D) and an independent consumer run (E) are owner steps.
// -----------------------------------------------------------------------------

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_CONFIGURED' | 'UNSUPPORTED';
export interface ReadinessCheck {
  gate: 'A' | 'B' | 'C' | 'D';
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessClient {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  /** Raw JSON-RPC, for capability probes (debug_traceCall). */
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface RuntimeArtifact {
  deployedBytecode: Hex;
  immutableReferences?: Record<string, { start: number; length: number }[]>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;
const COMPOSER_ABI = [
  { type: 'function', name: 'predictProxyAddress', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/**
 * On-chain runtime vs a compiled artifact: equal once constructor-set immutables and every embedded 53-byte CBOR
 * metadata blob are zeroed on both sides (a factory embeds its child's metadata too). Metadata differs with comment
 * or line-ending changes and says nothing about behaviour.
 */
export function runtimeMatchesArtifact(onChain: Hex | undefined, a: RuntimeArtifact): { masked: boolean; exact: boolean; bytes: number; artifactBytes: number } {
  const hex = (x: string) => Buffer.from(x.slice(2), 'hex');
  const code = hex(onChain ?? '0x');
  const want = hex(a.deployedBytecode);
  const CBOR = Buffer.from('a264697066735822', 'hex');
  const blobs = (b: Buffer) => {
    const at: number[] = [];
    for (let i = b.indexOf(CBOR); i >= 0; i = b.indexOf(CBOR, i + 1)) at.push(i);
    return at;
  };
  const ranges = [...new Set([...blobs(code), ...blobs(want)])];
  const mask = (b: Buffer) => {
    const c = Buffer.from(b);
    for (const refs of Object.values(a.immutableReferences ?? {})) for (const r of refs) c.fill(0, r.start, r.start + r.length);
    for (const i of ranges) c.fill(0, i, Math.min(c.length, i + 53));
    return c;
  };
  return { exact: code.equals(want), masked: code.length > 0 && code.length === want.length && mask(code).equals(mask(want)), bytes: code.length, artifactBytes: want.length };
}

function envAddress(env: Record<string, string | undefined>, name: string): Hex | null | 'INVALID' {
  const v = env[name]?.trim();
  // `.env.example` ships `0xdeployed-…` placeholders: those mean "not deployed", not a typo.
  if (!v || /^0xdeployed-/i.test(v)) return null;
  return ADDRESS_RE.test(v) ? (getAddress(v) as Hex) : 'INVALID';
}

export interface ReadinessInput {
  chain: BagChain;
  client: ReadinessClient;
  env: Record<string, string | undefined>;
  /** Compiled artifacts by contract name; a missing one makes that bytecode check NOT_CONFIGURED. */
  artifacts: Partial<Record<'StrategyRegistry' | 'BagFactory' | 'StrategyCompositions', RuntimeArtifact>>;
}

export async function checkChainReadiness({ chain, client, env, artifacts }: ReadinessInput): Promise<ReadinessCheck[]> {
  const cfg = BAG_CHAINS[chain];
  const K = chain.toUpperCase();
  const out: ReadinessCheck[] = [];
  const push = (gate: ReadinessCheck['gate'], name: string, status: CheckStatus, detail: string) => out.push({ gate, name, status, detail });
  const safe = async <T>(f: () => Promise<T>): Promise<T | Error> => {
    try {
      return await f();
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  };

  // ---- Gate A: chain and asset identity ------------------------------------------------------------------
  const chainId = await safe(() => client.getChainId());
  const rightChain = chainId === cfg.chainId;
  push('A', 'RPC_CHAIN_ID', rightChain ? 'PASS' : 'FAIL', chainId instanceof Error ? 'RPC unreachable' : `RPC ${chainId}, expected ${cfg.chainId}`);
  if (!rightChain) return out; // every later read would be about the wrong chain

  const token = async (name: string, address: string | null, symbol: string, decimals: number) => {
    if (!address) return push('A', name, 'NOT_CONFIGURED', 'no address in lib/config/chains.ts');
    const a = address as Hex;
    const code = await safe(() => client.getCode({ address: a }));
    if (code instanceof Error || !code || code === '0x') return push('A', name, 'FAIL', `${a}: no code`);
    const s = await safe(() => client.readContract({ address: a, abi: ERC20_ABI, functionName: 'symbol' }));
    const d = await safe(() => client.readContract({ address: a, abi: ERC20_ABI, functionName: 'decimals' }));
    const ok = s === symbol && Number(d) === decimals;
    push('A', name, ok ? 'PASS' : 'FAIL', `${a}: symbol ${s instanceof Error ? '?' : String(s)}, decimals ${d instanceof Error ? '?' : String(d)} (expected ${symbol}/${decimals})`);
  };
  await token('WRAPPED_NATIVE', cfg.wrappedNativeAddress, 'WETH', 18);
  await token('SETTLEMENT_STABLECOIN', cfg.sweepOutputToken.address, cfg.sweepOutputToken.symbol, cfg.sweepOutputToken.decimals);

  // ---- Gate B: BAG contracts (addresses only from env, never defaulted) ----------------------------------
  const bagContract = async (name: 'StrategyRegistry' | 'BagFactory' | 'StrategyCompositions', envName: string) => {
    const addr = envAddress(env, envName);
    if (addr === null) return push('B', `${name.toUpperCase()}_DEPLOYED`, 'NOT_CONFIGURED', `${envName} unset (no default; deploy, then set it)`);
    if (addr === 'INVALID') return push('B', `${name.toUpperCase()}_DEPLOYED`, 'FAIL', `${envName} is not an address`);
    const code = await safe(() => client.getCode({ address: addr }));
    if (code instanceof Error || !code || code === '0x') return push('B', `${name.toUpperCase()}_DEPLOYED`, 'FAIL', `${addr}: no code`);
    push('B', `${name.toUpperCase()}_DEPLOYED`, 'PASS', `${addr}: ${(code.length - 2) / 2} bytes, keccak ${keccak256(code)}`);
    const art = artifacts[name];
    if (!art) return push('B', `${name.toUpperCase()}_BYTECODE`, 'NOT_CONFIGURED', 'no compiled artifact (npx hardhat compile)');
    const cmp = runtimeMatchesArtifact(code, art);
    push('B', `${name.toUpperCase()}_BYTECODE`, cmp.masked ? 'PASS' : 'FAIL', cmp.masked ? (cmp.exact ? 'exact match' : 'match (immutables and metadata masked)') : `differs (${cmp.bytes} vs ${cmp.artifactBytes} bytes)`);
  };
  await bagContract('StrategyRegistry', `STRATEGY_REGISTRY_ADDRESS_${K}`);
  await bagContract('BagFactory', `FACTORY_ADDRESS_${K}`);
  await bagContract('StrategyCompositions', `STRATEGY_COMPOSITIONS_ADDRESS_${K}`);

  // ---- Gate C: Composer deployment pin for THIS chain ----------------------------------------------------
  const factory = envAddress(env, `COMPOSER_FACTORY_${K}`);
  const pinHash = env[`COMPOSER_FACTORY_CODE_HASH_${K}`]?.trim();
  if (factory === null || !pinHash) {
    push('C', 'COMPOSER_PIN', 'NOT_CONFIGURED', `COMPOSER_FACTORY_${K} and COMPOSER_FACTORY_CODE_HASH_${K} unset (a reviewed per-chain pin is required; none is defaulted)`);
  } else if (factory === 'INVALID' || !HASH_RE.test(pinHash)) {
    push('C', 'COMPOSER_PIN', 'FAIL', 'pin is not an address + 32-byte hash');
  } else {
    const code = await safe(() => client.getCode({ address: factory }));
    const live = code instanceof Error || !code ? null : keccak256(code);
    push('C', 'COMPOSER_FACTORY_CODE_HASH', live !== null && live.toLowerCase() === pinHash.toLowerCase() ? 'PASS' : 'FAIL', `live ${live ?? 'no code'}, pin ${pinHash}`);
    const signer = envAddress(env, 'COMPOSER_TEST_SIGNER');
    if (signer === null || signer === 'INVALID') {
      push('C', 'COMPOSER_PROXY_PREDICTION', 'NOT_CONFIGURED', 'COMPOSER_TEST_SIGNER unset (any address you control; read-only)');
    } else {
      const proxy = await safe(() => client.readContract({ address: factory, abi: COMPOSER_ABI, functionName: 'predictProxyAddress', args: [signer] }));
      if (proxy instanceof Error || typeof proxy !== 'string' || !ADDRESS_RE.test(proxy)) {
        push('C', 'COMPOSER_PROXY_PREDICTION', 'FAIL', 'predictProxyAddress did not return an address');
      } else {
        const pcode = await safe(() => client.getCode({ address: proxy as Hex }));
        if (pcode instanceof Error || !pcode || pcode === '0x') {
          push('C', 'COMPOSER_PROXY_PREDICTION', 'PASS', `${proxy}: not deployed yet (first purchase targets the factory)`);
        } else {
          const o = await safe(() => client.readContract({ address: proxy as Hex, abi: COMPOSER_ABI, functionName: 'owner' }));
          const f = await safe(() => client.readContract({ address: proxy as Hex, abi: COMPOSER_ABI, functionName: 'factory' }));
          const ok = typeof o === 'string' && typeof f === 'string' && getAddress(o) === signer && getAddress(f) === factory;
          push('C', 'COMPOSER_PROXY_PREDICTION', ok ? 'PASS' : 'FAIL', `${proxy}: owner ${String(o)}, factory ${String(f)}`);
        }
      }
    }
  }

  // ---- Gate D: what receipt evidence this RPC can serve (probe only) -------------------------------------
  const trace = await safe(() =>
    client.request({ method: 'debug_traceCall', params: [{ to: cfg.sweepOutputToken.address, data: '0x95d89b41' }, 'latest', { tracer: 'callTracer' }] })
  );
  push('D', 'RPC_DEBUG_TRACE_CALL', trace instanceof Error ? 'UNSUPPORTED' : 'PASS', trace instanceof Error ? 'debug_traceCall refused: balance-trace receipt modes unavailable on this RPC; DELIVERY_LOG (SDK 0.4) does not need it' : 'served');
  return out;
}

export type GateStatus = 'PASS' | 'FAIL' | 'INCOMPLETE';
export function summarizeGates(checks: ReadinessCheck[]): Record<'A' | 'B' | 'C' | 'D', GateStatus> {
  const gate = (g: ReadinessCheck['gate']): GateStatus => {
    const cs = checks.filter((c) => c.gate === g);
    if (cs.some((c) => c.status === 'FAIL')) return 'FAIL';
    if (cs.length === 0 || cs.some((c) => c.status !== 'PASS')) return 'INCOMPLETE';
    return 'PASS';
  };
  // D is never PASS from read-only checks: it needs a live purchase whose receipt the SDK verifies (owner step).
  return { A: gate('A'), B: gate('B'), C: gate('C'), D: gate('D') === 'FAIL' ? 'FAIL' : 'INCOMPLETE' };
}
