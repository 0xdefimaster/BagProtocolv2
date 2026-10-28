/**
 * READ-ONLY: does each launch chain have what BagSettler relies on? (docs/BAG_SETTLER_DESIGN.md, "Launch chains
 * and one-click purchase".)
 *
 *   npx tsx scripts/verify-settler-prereqs.ts                          # robinhood, base, arbitrum
 *   npx tsx scripts/verify-settler-prereqs.ts --chains=base,arbitrum   # only these
 *   npx tsx scripts/verify-settler-prereqs.ts --out=prereqs.json       # also write the results as JSON
 *
 * Per chain, by code reads and eth_call only (no key, no transaction):
 *   - Permit2 at its canonical address, answering DOMAIN_SEPARATOR()      required (Permit2 paths)
 *   - CreateX and the deterministic deployment proxy                      one required (same settler address)
 *   - wrapped native, answering decimals()                                required (native input)
 *   - the payment token (PAYMENT_TOKEN_BY_CHAIN), answering decimals()    required
 *   - the payment token's EIP-2612 surface: DOMAIN_SEPARATOR() + nonces() info (gasless first Permit2 use)
 *   - a Uniswap v3 factory with a wrapped-native / payment-token pool     required (direct AMM legs)
 *   - Multicall3                                                          info
 *
 * Robinhood stock-token liquidity is measured by scripts/check-fee-router-liquidity.ts, not here.
 *
 * STATUS: PASS · FAIL (the read succeeded and the requirement is absent) · INDETERMINATE (RPC error: re-run) ·
 * INFO (recorded, not required). Runtime code hashes are printed for the review record. CreateX and the deployment
 * proxy have no chain-specific immutables, so their hashes must match on every chain; Permit2's embed the chain id
 * and differ by design.
 *
 * Env: <CHAIN>_RPC_URL / RPC_URL_<CHAIN> or ALCHEMY_API_KEY (scripts/rpc-url.ts), else the chain's public RPC.
 *
 * Exit code: 0 when every required check passes, 1 when one fails, 2 when nothing failed but something could not
 * be read.
 */
import './load-env';
import { writeFileSync } from 'node:fs';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { BAG_CHAINS, type BagChain } from '../lib/config/chains';
import { PERMIT2_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS } from '../lib/config/robinhood-chain';
import { PAYMENT_TOKEN_BY_CHAIN } from '../lib/server/payment-assets';
import { scriptRpcUrl } from './rpc-url';

const LAUNCH_CHAINS = ['robinhood', 'base', 'arbitrum'] as const satisfies readonly BagChain[];
type LaunchChain = (typeof LAUNCH_CHAINS)[number];

/** CreateX (github.com/pcaversaccio/createx): the same address on every chain it is deployed to. */
const CREATEX_ADDRESS = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
/** Arachnid's deterministic deployment proxy (CREATE2 factory). */
const DETERMINISTIC_DEPLOYER_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * Uniswap v3 factories. Robinhood's comes from lib/config/robinhood-chain.ts. Base's and Arbitrum's are Uniswap's
 * published deployments; this script does not trust them on sight: a factory passes only if getPool returns a
 * deployed wrapped-native / payment-token pool.
 */
const UNISWAP_V3_FACTORY: Record<LaunchChain, Hex> = {
  robinhood: UNISWAP_V3_FACTORY_ADDRESS,
  base: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  arbitrum: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
};
const FEE_TIERS = [100, 500, 3000, 10000] as const;

const ABI = [
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
    outputs: [{ type: 'address' }],
  },
] as const;

type Status = 'PASS' | 'FAIL' | 'INDETERMINATE' | 'INFO';

interface Check {
  /** 'all' for a comparison across chains. */
  chain: LaunchChain | 'all';
  name: string;
  status: Status;
  required: boolean;
  detail: string;
  codeHash?: Hex;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** A revert or an empty answer means the contract answered (FAIL); anything else is a transport failure (INDETERMINATE). */
const isRevert = (e: unknown) =>
  e instanceof BaseError && Boolean(e.walk((err) => err instanceof ContractFunctionRevertedError || err instanceof ContractFunctionZeroDataError));

async function codeOf(client: PublicClient, address: Hex): Promise<{ hash: Hex } | null> {
  const code = await client.getCode({ address });
  return code && code !== '0x' ? { hash: keccak256(code) } : null;
}

async function checkChain(chain: LaunchChain): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Omit<Check, 'chain'>) => checks.push({ chain, ...c });
  const cfg = BAG_CHAINS[chain];
  const payment = PAYMENT_TOKEN_BY_CHAIN[chain];

  let client: PublicClient;
  try {
    client = createPublicClient({ transport: http(scriptRpcUrl(chain)) }) as unknown as PublicClient;
    const chainId = await client.getChainId();
    if (chainId !== cfg.chainId) {
      add({ name: 'chain id', status: 'FAIL', required: true, detail: `RPC reports ${chainId}, expected ${cfg.chainId}` });
      return checks;
    }
  } catch (e) {
    add({ name: 'RPC', status: 'INDETERMINATE', required: true, detail: firstLine(e) });
    return checks;
  }

  /** Runs one check; a transport error becomes INDETERMINATE, never PASS or FAIL. */
  const run = async (name: string, required: boolean, fn: () => Promise<Omit<Check, 'chain' | 'name' | 'required'>>) => {
    try {
      add({ name, required, ...(await fn()) });
    } catch (e) {
      if (!isRevert(e)) add({ name, required, status: 'INDETERMINATE', detail: firstLine(e) });
      else add({ name, required, status: required ? 'FAIL' : 'INFO', detail: `reverted or empty: ${firstLine(e)}` });
    }
  };

  await run('Permit2', true, async () => {
    const code = await codeOf(client, PERMIT2_ADDRESS);
    if (!code) return { status: 'FAIL', detail: `no code at ${PERMIT2_ADDRESS}` };
    const separator = await client.readContract({ address: PERMIT2_ADDRESS, abi: ABI, functionName: 'DOMAIN_SEPARATOR' });
    return { status: 'PASS', detail: `DOMAIN_SEPARATOR ${separator.slice(0, 10)}…`, codeHash: code.hash };
  });

  const deployers: [string, Hex][] = [['CreateX', CREATEX_ADDRESS], ['Deterministic deployment proxy', DETERMINISTIC_DEPLOYER_ADDRESS]];
  for (const [name, address] of deployers) {
    await run(name, false, async () => {
      const code = await codeOf(client, address);
      return code ? { status: 'INFO', detail: `present at ${address}`, codeHash: code.hash } : { status: 'INFO', detail: `absent at ${address}` };
    });
  }
  const deployerResults = checks.filter((c) => deployers.some(([name]) => name === c.name));
  if (deployerResults.some((c) => c.codeHash)) add({ name: 'Same-address deployer', status: 'PASS', required: true, detail: 'at least one present' });
  else if (deployerResults.some((c) => c.status === 'INDETERMINATE')) add({ name: 'Same-address deployer', status: 'INDETERMINATE', required: true, detail: 'not every deployer could be read' });
  else add({ name: 'Same-address deployer', status: 'FAIL', required: true, detail: 'neither CreateX nor the deployment proxy is deployed' });

  await run('Wrapped native', true, async () => {
    const address = cfg.wrappedNativeAddress as Hex;
    if (!(await codeOf(client, address))) return { status: 'FAIL', detail: `no code at ${address}` };
    const decimals = await client.readContract({ address, abi: ABI, functionName: 'decimals' });
    return decimals === 18 ? { status: 'PASS', detail: `${address}, 18 decimals` } : { status: 'FAIL', detail: `${address} reports ${decimals} decimals` };
  });

  if (!payment) {
    add({ name: 'Payment token', status: 'FAIL', required: true, detail: 'no PAYMENT_TOKEN_BY_CHAIN entry' });
  } else {
    const token = payment.address as Hex;
    await run(`Payment token ${payment.symbol}`, true, async () => {
      if (!(await codeOf(client, token))) return { status: 'FAIL', detail: `no code at ${token}` };
      const decimals = await client.readContract({ address: token, abi: ABI, functionName: 'decimals' });
      return { status: 'PASS', detail: `${token}, ${decimals} decimals` };
    });
    // Answering both reads is necessary for EIP-2612, not proof of a working permit(): treat as "likely" until a
    // signed permit has been simulated.
    await run(`${payment.symbol} EIP-2612 surface`, false, async () => {
      await client.readContract({ address: token, abi: ABI, functionName: 'DOMAIN_SEPARATOR' });
      await client.readContract({ address: token, abi: ABI, functionName: 'nonces', args: [PERMIT2_ADDRESS] });
      return { status: 'INFO', detail: 'DOMAIN_SEPARATOR() and nonces() answer: permit() likely' };
    });

    await run('Uniswap v3 pool (wrapped native / payment)', true, async () => {
      const factory = UNISWAP_V3_FACTORY[chain];
      if (!(await codeOf(client, factory))) return { status: 'FAIL', detail: `no code at factory ${factory}` };
      const found: string[] = [];
      for (const fee of FEE_TIERS) {
        const pool = await client.readContract({ address: factory, abi: ABI, functionName: 'getPool', args: [cfg.wrappedNativeAddress as Hex, token, fee] });
        if (pool !== ZERO && (await codeOf(client, pool))) found.push(`${fee}`);
      }
      return found.length > 0
        ? { status: 'PASS', detail: `factory ${factory}, fee tiers ${found.join('/')}` }
        : { status: 'FAIL', detail: `factory ${factory} has no deployed pool for this pair` };
    });
  }

  await run('Multicall3', false, async () => {
    const code = await codeOf(client, MULTICALL3_ADDRESS);
    return { status: 'INFO', detail: code ? `present at ${MULTICALL3_ADDRESS}` : `absent at ${MULTICALL3_ADDRESS}` };
  });

  return checks;
}

/** CreateX and the deployment proxy must be byte-identical wherever both chains have them. */
function crossChainChecks(checks: Check[]): Check[] {
  const out: Check[] = [];
  for (const name of ['CreateX', 'Deterministic deployment proxy']) {
    const hashes = new Set(checks.filter((c) => c.name === name && c.codeHash).map((c) => c.codeHash));
    if (hashes.size > 1) out.push({ chain: 'all', name: `${name} runtime differs across chains`, status: 'FAIL', required: true, detail: [...hashes].join(' ≠ ') });
  }
  return out;
}

async function main() {
  const requested = arg('chains')?.split(',').map((s) => s.trim());
  const unknown = requested?.filter((c) => !(LAUNCH_CHAINS as readonly string[]).includes(c));
  if (unknown && unknown.length > 0) {
    console.error(`--chains: unknown ${unknown.join(', ')} (launch chains: ${LAUNCH_CHAINS.join(', ')})`);
    process.exit(2);
  }
  const chains = (requested as LaunchChain[] | undefined) ?? [...LAUNCH_CHAINS];

  const checks: Check[] = [];
  for (const chain of chains) checks.push(...(await checkChain(chain)));
  checks.push(...crossChainChecks(checks));

  for (const chain of [...chains, 'all'] as const) {
    const rows = checks.filter((x) => x.chain === chain);
    if (rows.length === 0) continue;
    console.log(`\n${chain === 'all' ? 'across chains' : chain}`);
    for (const c of rows) {
      console.log(`  ${c.status.padEnd(13)} ${c.required ? '*' : ' '} ${c.name}: ${c.detail}${c.codeHash ? ` [runtime ${c.codeHash}]` : ''}`);
    }
  }
  console.log('\n* required');

  const out = arg('out');
  if (out) {
    writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
    console.log(`Results written to ${out}`);
  }

  const required = checks.filter((c) => c.required);
  if (required.some((c) => c.status === 'FAIL')) process.exit(1);
  if (required.some((c) => c.status === 'INDETERMINATE')) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  console.error(`SETUP_ERROR: ${firstLine(e)}`);
  process.exit(2);
});
