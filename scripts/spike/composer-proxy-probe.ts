/**
 * LI.FI Composer user proxy — READ-ONLY probe. No key, no transaction.
 *
 * HISTORICAL exploratory probe. Current documentation specifies CreateX CREATE3;
 * the SDK now uses a pinned factory's predictProxyAddress plus owner/factory checks.
 * See docs/SDK_COMPOSER_TRUST.md and resolveLifiComposerAccount. The CREATE2
 * hypotheses below are diagnostic history, not the supported account resolver.
 * This probe collects on-chain facts for known (wallet, proxy) pairs:
 *
 *   - the proxy's code: size, hash, EIP-1167 clone (and its implementation), ERC-1967 implementation slot, and
 *     whether the wallet's address is embedded in the code;
 *   - who created it (Blockscout's public address API) and in which transaction;
 *   - whether every proxy shares the same code shape;
 *   - a few CREATE2 hypotheses (factory = creator, common salt schemes, minimal-constructor init codes). A match on
 *     every pair is evidence, not documentation: confirm the scheme with LI.FI before relying on it.
 *
 *   npx tsx scripts/spike/composer-proxy-probe.ts [--pair 0xWallet:0xProxy ...]
 *
 * Defaults to the two pairs observed live with examples/live-compile.ts. Env: ROBINHOOD_RPC_URL / RPC_URL_ROBINHOOD,
 * else the public RPC (never printed).
 */
import '../load-env';
import { concat, createPublicClient, encodeAbiParameters, encodePacked, getContractAddress, http, keccak256, pad, type Hex } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_EXPLORER_URL, ROBINHOOD_RPC_URL } from '../../lib/config/robinhood-chain';

const DEFAULT_PAIRS: [string, string][] = [
  ['0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46', '0x0a6baefc776477c494ab8b0a288881a7b72196f7'],
  ['0xb193DE199EeB9bd1143607a11AD00999Ceb956b8', '0xad834b4de0295622a4042a3caa62ce5b961578e7'],
];
// ERC-1967: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1).
const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const pairs = (): [string, string][] => {
  const out: [string, string][] = [];
  process.argv.forEach((a, i) => {
    if (a !== '--pair') return;
    const [w, p] = (process.argv[i + 1] ?? '').split(':');
    if (!ADDR.test(w ?? '') || !ADDR.test(p ?? '')) throw new Error(`--pair needs 0xWallet:0xProxy, got "${process.argv[i + 1]}"`);
    out.push([w, p]);
  });
  return out.length > 0 ? out : DEFAULT_PAIRS;
};

async function creatorOf(address: string): Promise<{ creator: string | null; tx: string | null }> {
  try {
    const res = await fetch(`${ROBINHOOD_EXPLORER_URL}/api/v2/addresses/${address}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { creator: null, tx: null };
    const j = (await res.json()) as Record<string, unknown>;
    const creator = (j.creator_address_hash as string | undefined) ?? null;
    const tx = ((j.creation_transaction_hash ?? j.creation_tx_hash) as string | undefined) ?? null;
    return { creator, tx };
  } catch {
    return { creator: null, tx: null };
  }
}

/** Minimal "copy the runtime and return it" constructors (OpenZeppelin Clones style and Solady style), runtime ≤ 255 bytes. */
function initCodes(runtime: Hex): { name: string; code: Hex }[] {
  const len = (runtime.length - 2) / 2;
  if (len > 255) return [];
  const l = len.toString(16).padStart(2, '0');
  return [
    { name: 'oz-minimal-constructor', code: concat([`0x3d60${l}80600a3d3981f3`, runtime]) },
    { name: 'solady-minimal-constructor', code: concat([`0x60${l}3d8160093d39f3`, runtime]) },
  ];
}

function salts(wallet: Hex): { name: string; salt: Hex }[] {
  return [
    { name: 'bytes32(uint160(wallet))', salt: pad(wallet, { size: 32 }) },
    { name: 'bytes32(wallet) right-padded', salt: pad(wallet, { size: 32, dir: 'right' }) },
    { name: 'keccak256(abi.encodePacked(wallet))', salt: keccak256(encodePacked(['address'], [wallet])) },
    { name: 'keccak256(abi.encode(wallet))', salt: keccak256(encodeAbiParameters([{ type: 'address' }], [wallet])) },
    { name: 'keccak256(abi.encode(wallet, chainId))', salt: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [wallet, BigInt(ROBINHOOD_CHAIN_ID)])) },
  ];
}

async function main() {
  const client = createPublicClient({ transport: http(ROBINHOOD_RPC_URL) });
  const chainId = await client.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID}).`);

  const rows: { wallet: Hex; proxy: Hex; code: Hex; creator: string | null }[] = [];
  for (const [w, p] of pairs()) {
    const wallet = w.toLowerCase() as Hex;
    const proxy = p.toLowerCase() as Hex;
    const code = ((await client.getCode({ address: proxy })) ?? '0x').toLowerCase() as Hex;
    const size = (code.length - 2) / 2;
    console.log(`\nwallet ${wallet}\nproxy  ${proxy}`);
    if (size === 0) {
      console.log('  code: none (not deployed yet: counterfactual)');
      rows.push({ wallet, proxy, code, creator: null });
      continue;
    }
    const clone = EIP1167.exec(code);
    const slot = await client.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT }).catch(() => undefined);
    const impl1967 = slot && BigInt(slot) !== BigInt(0) ? `0x${slot.slice(-40)}` : null;
    const { creator, tx } = await creatorOf(proxy);
    console.log(`  code: ${size} bytes, keccak ${keccak256(code)}`);
    console.log(`  EIP-1167 clone: ${clone ? `yes → implementation 0x${clone[1]}` : 'no'}`);
    console.log(`  ERC-1967 implementation slot: ${impl1967 ?? 'empty'}`);
    console.log(`  wallet address embedded in code: ${code.includes(wallet.slice(2)) ? 'yes' : 'no'}`);
    console.log(`  created by: ${creator ?? 'not reported'}${tx ? ` in tx ${tx}` : ''}`);
    rows.push({ wallet, proxy, code, creator: creator?.toLowerCase() ?? null });
  }

  const deployed = rows.filter((r) => r.code !== '0x');
  if (deployed.length >= 2) {
    // Same shape = identical code once each proxy's own wallet bytes are blanked out.
    const shape = (r: (typeof rows)[number]) => keccak256(r.code.split(r.wallet.slice(2)).join('0'.repeat(40)) as Hex);
    console.log(`\nsame code shape for every proxy: ${new Set(deployed.map(shape)).size === 1 ? 'yes' : 'no'}`);
    console.log(`same creator for every proxy: ${new Set(deployed.map((r) => r.creator)).size === 1 && deployed[0].creator ? `yes (${deployed[0].creator})` : 'no / not reported'}`);
  }

  // CREATE2 hypotheses: a scheme counts only if it reproduces EVERY deployed proxy.
  const matches = new Map<string, number>();
  for (const r of deployed) {
    if (!r.creator) continue;
    for (const ic of initCodes(r.code)) {
      for (const s of salts(r.wallet)) {
        const predicted = getContractAddress({ opcode: 'CREATE2', from: r.creator as Hex, salt: s.salt, bytecode: ic.code }).toLowerCase();
        if (predicted === r.proxy) matches.set(`${ic.name} + ${s.name}`, (matches.get(`${ic.name} + ${s.name}`) ?? 0) + 1);
      }
    }
  }
  const all = [...matches].filter(([, n]) => n === deployed.length && n > 0).map(([k]) => k);
  console.log(`\nCREATE2 hypotheses matching every proxy: ${all.length > 0 ? all.join('; ') : 'NONE'}`);
  if (all.length === 0) console.log('No CREATE2 hypothesis matched. Composer documents CREATE3; use the pinned-factory SDK account resolver.');
}

main().catch((e) => {
  console.error(((e as Error).message ?? String(e)).split('\n')[0].replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'));
  process.exit(1);
});
