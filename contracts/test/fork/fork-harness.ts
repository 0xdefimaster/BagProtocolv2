import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { network } from 'hardhat';
import { getAddress, keccak256, parseAbi, type Hex } from 'viem';

// -----------------------------------------------------------------------------
// Shared harness for the Robinhood FORK tests (local EDR fork of chain 4663;
// nothing is ever broadcast to Robinhood Chain; every signer is a Hardhat test
// account or an impersonated address on the fork).
//
//   ROBINHOOD_MAINNET_RPC_URL   the upstream RPC (never logged or recorded)
//   ROBINHOOD_FORK_BLOCK        REQUIRED: the pinned fork block (reproducible runs)
//   DCA_FORK_EVIDENCE_DIR       where each test writes its evidence JSON (default fork-evidence/latest)
//   DCA_FORK_ALLOW_LATEST=1     run without a pinned block (results are then not reproducible)
// -----------------------------------------------------------------------------

export const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL;
export const PINNED = process.env.ROBINHOOD_FORK_BLOCK ? BigInt(process.env.ROBINHOOD_FORK_BLOCK) : null;
export const SKIP = RPC ? false : 'ROBINHOOD_MAINNET_RPC_URL not set';

export const A = {
  USDG: getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  TSLA: getAddress('0x322f0929c4625ed5bad873c95208d54e1c003b2d'),
  NVDA: getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'),
  WETH: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  SWAP_ROUTER02: getAddress('0xCaf681a66D020601342297493863E78C959E5cb2'),
  V3_FACTORY: getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'),
  QUOTER_V2: getAddress('0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7'),
  STRATEGY_REGISTRY: getAddress('0x907cc27d644c8ea1c24b8320ad09ecf2819209a8'),
};
export const FEES = [100, 500, 3000, 10000] as const;
export const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
export const V3_FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
export const QUOTER_ABI = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)']);
const ZERO = /^0x0{40}$/i;

/** JSON with bigints as decimal strings. */
export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** Collects one test's evidence and writes it to DCA_FORK_EVIDENCE_DIR/<name>.json. Never holds the RPC URL. */
export function evidence(name: string) {
  const data: Record<string, unknown> = { test: name, evidenceClass: 'TEST_KEY_FORK', notEvidenceOf: ['a mainnet transaction', 'a wallet signature', 'an independent price reference'] };
  const t0 = Date.now();
  return {
    data,
    set(key: string, value: unknown) {
      data[key] = value;
    },
    write() {
      data.runtimeMs = Date.now() - t0;
      const dir = process.env.DCA_FORK_EVIDENCE_DIR ?? join('fork-evidence', 'latest');
      mkdirSync(dir, { recursive: true });
      const text = toJson(data);
      if (RPC && text.includes(RPC)) throw new Error('evidence would contain the RPC URL');
      writeFileSync(join(dir, `${name}.json`), text + '\n');
    },
  };
}

/** Connects to the pinned fork and proves the pin: the first local block is PINNED + 1 and its parent is PINNED's hash. */
export async function connectPinnedFork(log: (m: string) => void) {
  if (PINNED === null && process.env.DCA_FORK_ALLOW_LATEST !== '1') {
    throw new Error('ROBINHOOD_FORK_BLOCK is required (a pinned block makes the run reproducible); set DCA_FORK_ALLOW_LATEST=1 to run unpinned');
  }
  log('connecting to the fork (new contracts and storage are fetched from the RPC; the first run takes minutes)');
  const { viem } = await network.connect('robinhoodFork');
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();
  await tc.mine({ blocks: 1 }); // EDR needs one local block on an Orbit fork before eth_call
  const local = await pc.getBlock({ blockTag: 'latest' });
  const forkNumber = local.number! - 1n;
  const forkBlock = await pc.getBlock({ blockNumber: forkNumber });
  if (PINNED !== null && forkNumber !== PINNED) throw new Error(`fork is at ${forkNumber}, not the pinned ${PINNED}`);
  if (local.parentHash !== forkBlock.hash) throw new Error('the first local block does not extend the fork block');
  const chainId = await pc.getChainId();
  log(`fork block ${forkNumber} (${forkBlock.hash}), timestamp ${forkBlock.timestamp}, local chain id ${chainId}`);
  return { viem, pc, tc, fork: { number: forkNumber, hash: forkBlock.hash!, timestamp: forkBlock.timestamp, pinned: PINNED !== null } };
}

type Artifact = { deployedBytecode: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
export const artifact = (name: string): Artifact => JSON.parse(readFileSync(join('artifacts', 'contracts', `${name}.sol`, `${name}.json`), 'utf8'));

/**
 * Compares on-chain runtime code with this repository's compiled artifact. `exact`: byte-identical. `masked`:
 * identical once the constructor-set immutables and the trailing CBOR metadata (source/compiler fingerprint)
 * are zeroed on both sides, i.e. the same contract code with other constructor values or comments.
 */
export function compareRuntime(onChain: Hex | undefined, name: string) {
  const a = artifact(name);
  const hex = (x: string) => Buffer.from(x.slice(2), 'hex');
  const code = hex(onChain ?? '0x');
  const want = hex(a.deployedBytecode);
  const strip = (b: Buffer) => {
    if (b.length < 2) return b;
    const n = b.readUInt16BE(b.length - 2);
    return n + 2 <= b.length ? b.subarray(0, b.length - n - 2) : b;
  };
  const mask = (b: Buffer) => {
    const c = Buffer.from(b);
    for (const refs of Object.values(a.immutableReferences ?? {})) for (const r of refs) c.fill(0, r.start, r.start + r.length);
    return c;
  };
  return {
    bytes: code.length,
    artifactBytes: want.length,
    codeKeccak: keccak256(onChain ?? '0x'),
    exact: code.equals(want),
    masked: code.length === want.length && strip(mask(code)).equals(strip(mask(want))),
  };
}

/** The revert's error name (and args) from a viem error, or the revert string. */
export function errorName(e: unknown): string {
  for (let x: any = e; x; x = x.cause) {
    if (x?.data?.errorName) return `${x.data.errorName}(${(x.data.args ?? []).map(String).join(',')})`;
    if (typeof x?.reason === 'string') return `Error(${x.reason})`;
  }
  const m = String((e as Error)?.message ?? e).match(/custom error '?(\w+\([^)]*\))|reverted with reason string '([^']+)'/);
  return m ? (m[1] ?? `Error(${m[2]})`) : String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200);
}

export async function bestQuote(pc: any, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, fees: readonly number[] = FEES) {
  let best: { fee: number; out: bigint } | null = null;
  for (const fee of fees) {
    const pool = (await pc.readContract({ address: A.V3_FACTORY, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [tokenIn, tokenOut, fee] })) as Hex;
    if (ZERO.test(pool)) continue;
    try {
      const { result } = await pc.simulateContract({ address: A.QUOTER_V2, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
      if (!best || result[0] > best.out) best = { fee, out: result[0] };
    } catch {
      /* no liquidity in range at this tier */
    }
  }
  return best;
}

/** Funds `to` with USDG on the fork from a USDG/WETH pool's balance (impersonated; fork-local state only). */
export async function fundUsdg(viem: any, pc: any, tc: any, to: Hex, amount: bigint) {
  for (const fee of FEES) {
    const pool = (await pc.readContract({ address: A.V3_FACTORY, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [A.USDG, A.WETH, fee] })) as Hex;
    if (ZERO.test(pool) || ((await pc.readContract({ address: A.USDG, abi: ERC20, functionName: 'balanceOf', args: [pool] })) as bigint) < amount) continue;
    await tc.impersonateAccount({ address: pool });
    await tc.setBalance({ address: pool, value: 10n ** 18n });
    const w = await viem.getWalletClient(pool);
    await pc.waitForTransactionReceipt({ hash: await w.writeContract({ address: A.USDG, abi: ERC20, functionName: 'transfer', args: [to, amount], account: pool, chain: undefined }) });
    await tc.stopImpersonatingAccount({ address: pool });
    return pool;
  }
  throw new Error('no USDG/WETH pool holds enough USDG to fund the test account on the fork');
}

export function stepLogger(name: string) {
  const t0 = Date.now();
  return (msg: string) => console.log(`  [${name} +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}
