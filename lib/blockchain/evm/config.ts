import { ChainId } from '@/types/basket-protocol';
import { mainnet } from 'viem/chains';
import { BAG_CHAINS, BAG_CHAINS_LIST } from '@/lib/config/chains';
import { resolveRpcEndpoints } from '@/lib/blockchain/rpc/endpoints';

// -----------------------------------------------------------------------------
// Per-chain deployment config, read from env — never hardcoded RPC URLs,
// factory addresses, or keys in source. See .env.example for the full list.
// Only EVM chains here; Solana (in `SUPPORTED_CHAINS`, types/basket-protocol.ts)
// has no EVM factory and isn't addressed by this module — same "don't force
// multi-chain support that doesn't exist yet" principle Phase 1 already
// applied to `ChainId`.
//
// `robinhood` is supported alongside ethereum/base/arbitrum. There is NO mock
// fallback for an unconfigured chain: lib/server/deploy-bag.ts fails closed
// (`CHAIN_UNAVAILABLE`) when RPC_URL/FACTORY_ADDRESS are missing, in every
// environment — an unconfigured chain can never produce a "deployed" record.
//
// Confirmation policy (Bag deployment verification): this repository has no
// pre-existing confirmation-depth convention (receipts elsewhere are awaited
// with a fixed 120s timeout and no depth), so depth is EXPLICIT and
// configurable here rather than assumed: `CONFIRMATIONS_<CHAIN>` (integer
// 1..64, default 1 = "mined and successful") and a bounded per-request wait
// `BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS` (default 20000, max 55000) so an HTTP
// request can never hang on a pending transaction — the confirm endpoint
// reports PENDING and the client simply retries. Choose a higher depth for
// chains where reorgs are a concern; that is a deployment decision, not one
// this code can infer.
// -----------------------------------------------------------------------------

const EVM_CHAINS = BAG_CHAINS_LIST;
type EvmChainId = (typeof EVM_CHAINS)[number];

function isEvmChain(chain: ChainId): chain is EvmChainId {
  return (EVM_CHAINS as readonly string[]).includes(chain);
}

// Chain objects come from the central chain configuration (lib/config/chains.ts).
const VIEM_CHAIN_BY_ID = Object.fromEntries(
  EVM_CHAINS.map((c) => [c, BAG_CHAINS[c].viemChain as unknown as typeof mainnet])
) as Record<EvmChainId, typeof mainnet>;

function envKey(chain: EvmChainId): string {
  return chain.toUpperCase();
}

export interface EvmChainConfig {
  chain: EvmChainId;
  viemChain: typeof mainnet;
  rpcUrl: string;
  factoryAddress: `0x${string}`;
  explorerUrl?: string;
  /** Block confirmations required before a Bag deployment receipt is accepted. Default 1. */
  confirmations: number;
  /** Max ms one verification request waits for a receipt before reporting PENDING. Default 20000. */
  receiptTimeoutMs: number;
}

export const DEFAULT_CONFIRMATIONS = 1;
export const DEFAULT_RECEIPT_TIMEOUT_MS = 20_000;
const MAX_CONFIRMATIONS = 64;
const MAX_RECEIPT_TIMEOUT_MS = 55_000;

/** Parses a bounded positive integer env var; an unset/blank value yields `fallback`, a malformed or out-of-range one throws (fail closed rather than silently weakening a safety setting). */
function readBoundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name}="${raw}" is invalid — expected an integer between ${min} and ${max}.`);
  }
  return n;
}

const FACTORY_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class ChainNotConfiguredError extends Error {
  constructor(chain: ChainId) {
    super(
      `No EVM deployment config for chain "${chain}". Set an RPC (${chain.toUpperCase()}_RPC_URL or ALCHEMY_API_KEY) and ` +
        `FACTORY_ADDRESS_${chain.toUpperCase()} (see .env.example) before deploying to it.`
    );
    this.name = 'ChainNotConfiguredError';
  }
}

/** Just the `viemChain` for an EVM chain, with no requirement that RPC_URL/FACTORY_ADDRESS be configured yet — for deploy scripts (which are establishing that config, not consuming it) and anything else that needs "what chain object is this" without needing a full `EvmChainConfig`. */
export function getViemChainFor(chain: ChainId): typeof mainnet {
  if (!isEvmChain(chain)) {
    throw new ChainNotConfiguredError(chain);
  }
  return VIEM_CHAIN_BY_ID[chain];
}

/**
 * The canonical numeric EVM chain id for a protocol `ChainId`, from the SAME
 * `VIEM_CHAIN_BY_ID` map deployment verification uses (Robinhood's id comes
 * from `ROBINHOOD_CHAIN_ID`, never a re-typed literal). `null` for a non-EVM
 * chain (solana) or anything unknown — NEVER throws, so it is safe inside
 * speculative checks like `BagExecutionProvider.supports()`.
 */
export function getEvmChainIdFor(chain: ChainId): number | null {
  return isEvmChain(chain) ? VIEM_CHAIN_BY_ID[chain].id : null;
}

/** Reads RPC_URL_<CHAIN> / FACTORY_ADDRESS_<CHAIN> from env. Throws `ChainNotConfiguredError` (not a generic Error) so callers can tell "not configured" apart from "misconfigured"; deploy-bag.ts fails closed on BOTH — there is no mock fallback. */
export function getEvmChainConfig(chain: ChainId): EvmChainConfig {
  if (!isEvmChain(chain)) {
    throw new ChainNotConfiguredError(chain);
  }
  const key = envKey(chain);
  // First endpoint of the resilient RPC layer's list (explicit URL, else
  // Alchemy from ALCHEMY_API_KEY, else the operator's public RPC where one
  // exists — Ethereum has none). Server reads go through
  // lib/blockchain/rpc/clients.ts, which also fails over past this URL.
  const rpcUrl = resolveRpcEndpoints(chain)[0]?.url;
  const factoryAddress = process.env[`FACTORY_ADDRESS_${key}`];
  if (!rpcUrl || !factoryAddress) {
    throw new ChainNotConfiguredError(chain);
  }
  // A placeholder like the .env.example's "0xdeployed-bagfactory-address-..."
  // must never be treated as a configured factory.
  if (!FACTORY_ADDRESS_RE.test(factoryAddress)) {
    throw new Error(`FACTORY_ADDRESS_${key} is not a valid 0x-prefixed 20-byte address.`);
  }
  return {
    chain,
    viemChain: VIEM_CHAIN_BY_ID[chain],
    rpcUrl,
    factoryAddress: factoryAddress as `0x${string}`,
    explorerUrl: process.env[`EXPLORER_URL_${key}`] || BAG_CHAINS[chain].explorerUrl,
    confirmations: readBoundedIntEnv(`CONFIRMATIONS_${key}`, DEFAULT_CONFIRMATIONS, 1, MAX_CONFIRMATIONS),
    receiptTimeoutMs: readBoundedIntEnv('BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS', DEFAULT_RECEIPT_TIMEOUT_MS, 1_000, MAX_RECEIPT_TIMEOUT_MS),
  };
}

/** True if `getEvmChainConfig(chain)` resolves successfully (every required env var present and well-formed). */
export function isEvmChainConfigured(chain: ChainId): boolean {
  try {
    getEvmChainConfig(chain);
    return true;
  } catch {
    return false;
  }
}

