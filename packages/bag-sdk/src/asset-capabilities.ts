import { BAG_V1_CHAINS, isNativeToken, normalizeAddress } from './chains';

// -----------------------------------------------------------------------------
// Asset capabilities: what kind of asset a token is, decided by REVIEW, not by
// the fact that it answers ERC-20 calls.
//
// Recognising a contract as ERC-20 (adapters/evm.ts inspectToken) only says it
// has code and answers decimals/totalSupply/balanceOf. It says nothing about
// transfer restrictions, issuer permissions, pausing, rebasing, fees on
// transfer, or whether a fair price exists. Those are separate checks.
//
//   STANDARD_ERC20      reviewed: freely transferable, no issuer gate. May be bought.
//   RESTRICTED_TRANSFER issuer-restricted transfers (e.g. Coinbase B20 tokenized stocks). Refused: a purchase
//                       delivered through a Composer proxy can be blocked, and price/eligibility need an issuer
//                       adapter (Phase 2).
//   PERMISSIONED        holder must be approved by the issuer (e.g. KYC-gated dShares). Refused (Phase 2).
//   UNREVIEWED          not in the caller's registry. Refused unless the caller explicitly opts in, and then
//                       still reported as unreviewed.
//
// The registry is DATA the caller owns and extends. Nothing here limits the SDK to a fixed token list.
// -----------------------------------------------------------------------------

export type AssetClass = 'STANDARD_ERC20' | 'RESTRICTED_TRANSFER' | 'PERMISSIONED';

export interface AssetCapabilityEntry {
  chainId: number;
  /** Lowercased on registry creation. */
  address: string;
  assetClass: AssetClass;
  /** Who issues it, when known (e.g. 'Circle', 'Coinbase'). Informational. */
  issuer?: string;
  /** Free-text review note: where the facts came from and when. */
  reviewNote?: string;
}

export interface AssetCapabilityRegistry {
  lookup(chainId: number, address: string): AssetCapabilityEntry | null;
  entries(): readonly AssetCapabilityEntry[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Builds an immutable registry. Duplicate (chainId, address) entries with different classes are refused. */
export function createAssetCapabilityRegistry(entries: readonly AssetCapabilityEntry[]): AssetCapabilityRegistry {
  const map = new Map<string, AssetCapabilityEntry>();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.chainId) || e.chainId <= 0) throw new Error(`asset registry: invalid chainId ${e.chainId}`);
    if (!ADDRESS_RE.test(e.address)) throw new Error(`asset registry: invalid address ${e.address}`);
    if (isNativeToken(e.address)) throw new Error('asset registry: the native coin is not a registry entry');
    if (!['STANDARD_ERC20', 'RESTRICTED_TRANSFER', 'PERMISSIONED'].includes(e.assetClass)) throw new Error(`asset registry: unknown class ${e.assetClass}`);
    const key = `${e.chainId}:${normalizeAddress(e.address)}`;
    const prev = map.get(key);
    if (prev && prev.assetClass !== e.assetClass) throw new Error(`asset registry: conflicting classes for ${key}`);
    map.set(key, Object.freeze({ ...e, address: normalizeAddress(e.address) }));
  }
  const all = Object.freeze([...map.values()]);
  return { lookup: (chainId, address) => map.get(`${chainId}:${normalizeAddress(address)}`) ?? null, entries: () => all };
}

export type AssetDecision =
  | { address: string; role: 'input' | 'output'; decision: 'ALLOW'; assetClass: AssetClass | 'NATIVE' | 'UNREVIEWED'; reason: string }
  | { address: string; role: 'input' | 'output'; decision: 'REFUSE'; assetClass: AssetClass | 'UNREVIEWED'; reason: string };

export interface AssetScreening {
  ok: boolean;
  decisions: AssetDecision[];
}

/**
 * Screens every token a purchase touches against the caller's registry. Pure. Restricted and permissioned assets
 * are always refused here (they need an issuer-specific adapter); unreviewed ones are refused unless
 * `allowUnreviewed` is set, and are reported as UNREVIEWED either way.
 */
export function screenPurchaseAssets(input: {
  chainId: number;
  inputToken: string;
  outputTokens: readonly string[];
  registry: AssetCapabilityRegistry;
  allowUnreviewed?: boolean;
}): AssetScreening {
  const decide = (address: string, role: 'input' | 'output'): AssetDecision => {
    if (isNativeToken(address)) {
      return role === 'input'
        ? { address: normalizeAddress(address), role, decision: 'ALLOW', assetClass: 'NATIVE', reason: 'native coin, paid as transaction value' }
        : { address: normalizeAddress(address), role, decision: 'REFUSE', assetClass: 'UNREVIEWED', reason: 'the native coin cannot be a basket output; use the wrapped token' };
    }
    const entry = input.registry.lookup(input.chainId, address);
    const a = normalizeAddress(address);
    if (!entry) {
      return input.allowUnreviewed
        ? { address: a, role, decision: 'ALLOW', assetClass: 'UNREVIEWED', reason: 'not reviewed; allowed only because the caller opted in' }
        : { address: a, role, decision: 'REFUSE', assetClass: 'UNREVIEWED', reason: 'not in the asset registry; review it (transferability, issuer, price source) or opt in explicitly' };
    }
    if (entry.assetClass === 'STANDARD_ERC20') return { address: a, role, decision: 'ALLOW', assetClass: entry.assetClass, reason: 'reviewed standard ERC-20' };
    return {
      address: a,
      role,
      decision: 'REFUSE',
      assetClass: entry.assetClass,
      reason: entry.assetClass === 'RESTRICTED_TRANSFER' ? 'issuer-restricted transfers: needs an issuer adapter (not supported yet)' : 'holder must be permissioned by the issuer: needs an issuer adapter (not supported yet)',
    };
  };
  const decisions = [decide(input.inputToken, 'input'), ...input.outputTokens.map((t) => decide(t, 'output'))];
  return { ok: decisions.every((d) => d.decision === 'ALLOW'), decisions };
}

/**
 * Base Phase 1 reviewed set: the starting test matrix, NOT the list of supported tokens. Each was read on Base
 * (chain id, symbol, decimals) on 2026-11-04, and a USDC purchase of each compiled through the pinned Composer and
 * passed a full swap simulation (eth_call) that day. The address of each comes from the issuer's own published list.
 * Extend with your own reviewed entries:
 * `createAssetCapabilityRegistry([...BASE_PHASE1_REVIEWED_ASSETS, ...yours])`. Native ETH needs no entry.
 */
export const BASE_PHASE1_REVIEWED_ASSETS: readonly AssetCapabilityEntry[] = Object.freeze([
  { chainId: BAG_V1_CHAINS.base, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', assetClass: 'STANDARD_ERC20', issuer: 'Circle', reviewNote: 'native USDC on Base (not bridged USDbC); USDC/6' },
  { chainId: BAG_V1_CHAINS.base, address: '0x4200000000000000000000000000000000000006', assetClass: 'STANDARD_ERC20', reviewNote: 'OP Stack WETH predeploy; WETH/18' },
  { chainId: BAG_V1_CHAINS.base, address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', assetClass: 'STANDARD_ERC20', issuer: 'Coinbase', reviewNote: 'cbBTC (Coinbase Wrapped BTC); cbBTC/8' },
  { chainId: BAG_V1_CHAINS.base, address: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', assetClass: 'STANDARD_ERC20', issuer: 'Coinbase', reviewNote: 'cbETH (Coinbase Wrapped Staked ETH); cbETH/18; non-rebasing, value accrues through the exchange rate; address from coinbase.com/cbeth' },
  { chainId: BAG_V1_CHAINS.base, address: '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', assetClass: 'STANDARD_ERC20', issuer: 'Lido', reviewNote: 'wstETH bridged to Base (Lido ERC20Bridged behind an upgradeable proxy, minted and burned by the Lido bridge); wstETH/18; non-rebasing; address from docs.lido.fi/deployed-contracts' },
] satisfies AssetCapabilityEntry[]);
