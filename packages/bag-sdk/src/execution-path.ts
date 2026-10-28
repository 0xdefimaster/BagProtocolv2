import { BagSdkError } from './errors';

// -----------------------------------------------------------------------------
// How a wallet pays for a compiled purchase, chosen by an ordered rule table.
// Pure: the same facts give the same choice and the same reasons.
//
// Each rule names one path, the facts it requires (each with the reason code
// reported when it does not hold) and what the path costs the payer: wallet
// prompts (signatures + transactions) and transactions the payer submits.
// The choice is the eligible path with the fewest prompts; ties go to the
// earlier rule, so paths that need nothing outside the wallet come first.
// The other eligible paths follow in the same order: the fallback when a
// wallet turns a path down at run time (select again with the corrected fact).
//
// The facts are the caller's. The SDK reads no wallet, allowance or relayer,
// and an omitted optional fact counts as false: an unknown capability is
// never assumed.
// -----------------------------------------------------------------------------

/** Every path, in rule (preference) order. */
export const EXECUTION_PATHS = Object.freeze(['NATIVE', 'DIRECT', 'ATOMIC_BATCH', 'PERMIT2_RELAYED', 'PERMIT2_SELF', 'SEQUENTIAL'] as const);

export type ExecutionPath = (typeof EXECUTION_PATHS)[number];

export type ExecutionPathReason =
  /** NATIVE: the purchase is paid with an ERC-20. */
  | 'NOT_NATIVE_PAYMENT'
  /** ERC-20 paths: the purchase is paid with the native coin as the transaction value. */
  | 'NATIVE_PAYMENT'
  /** DIRECT: an allowance is still short. */
  | 'APPROVALS_NEEDED'
  /** ATOMIC_BATCH / SEQUENTIAL: every allowance already suffices (DIRECT applies). */
  | 'NO_APPROVALS_NEEDED'
  | 'NO_ATOMIC_BATCH'
  | 'EXECUTOR_NO_PERMIT2'
  | 'NO_TYPED_DATA_SIGNING'
  | 'NO_RELAYER'
  /** Note on an eligible Permit2 path: its prompts include a one-time token approval to Permit2. */
  | 'PERMIT2_SETUP_REQUIRED';

export interface ExecutionPathFacts {
  /** How the purchase is paid: the plan's `inputKind`. */
  payment: 'native' | 'erc20';
  /** Approvals to the executor's spender still short: compiled approvals the current allowance does not cover. 0 for native. */
  approvalsNeeded: number;
  wallet: {
    /** The wallet reports atomic batching for the purchase chain (see `hasAtomicBatchCapability`). */
    atomicBatch: boolean;
    /** The wallet produces EIP-712 typed-data signatures. */
    typedDataSigning?: boolean;
    /** The payer's allowance to Permit2 already covers the payment. Read by the Permit2 paths only. */
    permit2Approved?: boolean;
  };
  /** The executor accepts a Permit2 witness transfer instead of an approval. False for LI.FI Composer. */
  executorAcceptsPermit2?: boolean;
  /** A relayer will submit a signed Permit2 purchase. */
  relayerAvailable?: boolean;
}

export interface ExecutionPathCandidate {
  path: ExecutionPath;
  eligible: boolean;
  /** The requirements that do not hold, in rule order. Empty when eligible. */
  blockedBy: ExecutionPathReason[];
  /** Eligible paths only: steps already counted in `walletPrompts` that the caller should explain. */
  notes: ExecutionPathReason[];
  /** Signatures + transactions the wallet asks for. null when not eligible. */
  walletPrompts: number | null;
  /** Transactions the payer submits and pays gas for. null when not eligible. */
  payerTransactions: number | null;
}

export interface ExecutionPathSelection {
  path: ExecutionPath;
  walletPrompts: number;
  payerTransactions: number;
  notes: ExecutionPathReason[];
  /** Every eligible path, best first: the fallback order. */
  ranked: ExecutionPath[];
  /** Every rule in table order, eligible or not, with its reasons. */
  candidates: ExecutionPathCandidate[];
}

interface Facts {
  native: boolean;
  approvals: number;
  atomicBatch: boolean;
  typedData: boolean;
  permit2Approved: boolean;
  permit2: boolean;
  relayer: boolean;
}

interface Cost { prompts: number; transactions: number; notes: ExecutionPathReason[] }

interface Rule {
  path: ExecutionPath;
  requires: readonly (readonly [ExecutionPathReason, (f: Facts) => boolean])[];
  cost: (f: Facts) => Cost;
}

const erc20 = ['NATIVE_PAYMENT', (f: Facts) => !f.native] as const;
const approvalsShort = ['NO_APPROVALS_NEEDED', (f: Facts) => f.approvals > 0] as const;
const permit2 = ['EXECUTOR_NO_PERMIT2', (f: Facts) => f.permit2] as const;
const typedData = ['NO_TYPED_DATA_SIGNING', (f: Facts) => f.typedData] as const;

/** A one-time token approval to Permit2 when the payer has none: one more prompt and transaction. */
const permit2Cost = (f: Facts, prompts: number, transactions: number): Cost =>
  f.permit2Approved
    ? { prompts, transactions, notes: [] }
    : { prompts: prompts + 1, transactions: transactions + 1, notes: ['PERMIT2_SETUP_REQUIRED'] };

const RULES: readonly Rule[] = [
  // Native coin as the transaction value: never an approval.
  { path: 'NATIVE', requires: [['NOT_NATIVE_PAYMENT', (f) => f.native]], cost: () => ({ prompts: 1, transactions: 1, notes: [] }) },
  // Every allowance already suffices: the purchase transaction alone.
  { path: 'DIRECT', requires: [erc20, ['APPROVALS_NEEDED', (f) => f.approvals === 0]], cost: () => ({ prompts: 1, transactions: 1, notes: [] }) },
  // Exact approvals and the purchase as one atomic EIP-5792 batch: one confirmation, all or nothing.
  { path: 'ATOMIC_BATCH', requires: [erc20, approvalsShort, ['NO_ATOMIC_BATCH', (f) => f.atomicBatch]], cost: () => ({ prompts: 1, transactions: 1, notes: [] }) },
  // One Permit2 witness signature; the relayer submits and pays the gas.
  { path: 'PERMIT2_RELAYED', requires: [erc20, permit2, typedData, ['NO_RELAYER', (f) => f.relayer]], cost: (f) => permit2Cost(f, 1, 0) },
  // The same signature, submitted by the payer.
  { path: 'PERMIT2_SELF', requires: [erc20, permit2, typedData], cost: (f) => permit2Cost(f, 2, 1) },
  // One prompt per short approval, then the purchase. Always available for an ERC-20 that needs approval.
  { path: 'SEQUENTIAL', requires: [erc20, approvalsShort], cost: (f) => ({ prompts: f.approvals + 1, transactions: f.approvals + 1, notes: [] }) },
];

const invalid = (message: string) => new BagSdkError('INVALID_ARGUMENT', `selectExecutionPath: ${message}`);

function optionalFlag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalid(`${name} must be a boolean when given.`);
  return value;
}

function readFacts(facts: ExecutionPathFacts): Facts {
  if (!facts || typeof facts !== 'object') throw invalid('facts must be an object.');
  if (facts.payment !== 'native' && facts.payment !== 'erc20') throw invalid("payment must be 'native' or 'erc20'.");
  if (!Number.isSafeInteger(facts.approvalsNeeded) || facts.approvalsNeeded < 0) throw invalid('approvalsNeeded must be a non-negative integer.');
  if (facts.payment === 'native' && facts.approvalsNeeded !== 0) throw invalid('a native payment needs no approval.');
  if (!facts.wallet || typeof facts.wallet !== 'object') throw invalid('wallet must be an object.');
  if (typeof facts.wallet.atomicBatch !== 'boolean') throw invalid('wallet.atomicBatch must be a boolean.');
  return {
    native: facts.payment === 'native',
    approvals: facts.approvalsNeeded,
    atomicBatch: facts.wallet.atomicBatch,
    typedData: optionalFlag(facts.wallet.typedDataSigning, 'wallet.typedDataSigning'),
    permit2Approved: optionalFlag(facts.wallet.permit2Approved, 'wallet.permit2Approved'),
    permit2: optionalFlag(facts.executorAcceptsPermit2, 'executorAcceptsPermit2'),
    relayer: optionalFlag(facts.relayerAvailable, 'relayerAvailable'),
  };
}

/** Chooses how the wallet pays for a compiled purchase, with the reasons for every path. Throws BagSdkError INVALID_ARGUMENT on malformed facts. */
export function selectExecutionPath(facts: ExecutionPathFacts): ExecutionPathSelection {
  const f = readFacts(facts);
  const candidates: ExecutionPathCandidate[] = RULES.map((rule) => {
    const blockedBy = rule.requires.filter(([, holds]) => !holds(f)).map(([reason]) => reason);
    if (blockedBy.length > 0) return { path: rule.path, eligible: false, blockedBy, notes: [], walletPrompts: null, payerTransactions: null };
    const cost = rule.cost(f);
    return { path: rule.path, eligible: true, blockedBy: [], notes: cost.notes, walletPrompts: cost.prompts, payerTransactions: cost.transactions };
  });
  // Array.prototype.sort is stable: equal prompts keep rule order.
  const ranked = candidates.filter((c) => c.eligible).sort((a, b) => a.walletPrompts! - b.walletPrompts!);
  // Unreachable for valid facts: NATIVE covers native, DIRECT or SEQUENTIAL covers every ERC-20.
  if (ranked.length === 0) throw invalid('no path applies.');
  const best = ranked[0];
  return {
    path: best.path,
    walletPrompts: best.walletPrompts!,
    payerTransactions: best.payerTransactions!,
    notes: best.notes,
    ranked: ranked.map((c) => c.path),
    candidates,
  };
}

/**
 * Whether a `wallet_getCapabilities` result reports atomic batching for `chainId`: EIP-5792 v2 `atomic.status`
 * 'supported' or 'ready', or the older `atomicBatch.supported`. Entries for the chain (hex or decimal key) and for
 * all chains ('0x0') count. Anything malformed is false.
 */
export function hasAtomicBatchCapability(capabilities: unknown, chainId: number): boolean {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new BagSdkError('INVALID_ARGUMENT', 'hasAtomicBatchCapability: chainId must be a positive integer.');
  const keys = new Set([`0x${chainId.toString(16)}`, String(chainId), '0x0']);
  try {
    if (!capabilities || typeof capabilities !== 'object') return false;
    for (const [key, entry] of Object.entries(capabilities)) {
      if (!keys.has(key.toLowerCase()) || !entry || typeof entry !== 'object') continue;
      const { atomic, atomicBatch } = entry as { atomic?: { status?: unknown }; atomicBatch?: { supported?: unknown } };
      if (atomic?.status === 'supported' || atomic?.status === 'ready') return true;
      if (atomicBatch?.supported === true) return true;
    }
  } catch { /* Foreign objects can throw from getters. */ }
  return false;
}
