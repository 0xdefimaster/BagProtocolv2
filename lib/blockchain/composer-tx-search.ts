import { parseAbiItem, type PublicClient } from 'viem';
import type { BagChain } from '@/lib/config/chains';
import { getChainPublicClient, hasRpcEndpoint } from '@/lib/blockchain/rpc/clients';
import { isWalletRoutedBatch } from '@/lib/blockchain/composer-status';

// -----------------------------------------------------------------------------
// "Did this wallet actually send the Composer transaction we built?" — for an
// intent whose SUBMITTED report never arrived (tab closed, report lost).
//
// A Composer sale pulls every sold token from the wallet (`transferFrom`), so
// the transaction necessarily emits an ERC-20 Transfer FROM the wallet for
// those tokens. Those logs, from the intent's creation onwards, give every
// candidate; a candidate counts only if it is exactly the built transaction:
// same sender, target, calldata and value (the same binding composer-status.ts
// verifies). Fail closed: any RPC problem, or a transaction from the wallet
// still pending, is UNKNOWN — the caller then keeps the intent as it is.
// -----------------------------------------------------------------------------

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Blocks searched after the intent's creation. A signed transaction is broadcast at once and mined within minutes; this covers far more. */
export const COMPOSER_SEARCH_MAX_BLOCKS = BigInt(200_000);
/** One eth_getLogs range (providers cap the range a single call may cover). */
export const COMPOSER_SEARCH_CHUNK_BLOCKS = BigInt(10_000);

export type ComposerTxSearchResult =
  | { kind: 'FOUND'; txHash: `0x${string}` }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNKNOWN'; reason: string };

type SearchClient = Pick<PublicClient, 'getBlockNumber' | 'getBlock' | 'getLogs' | 'getTransaction' | 'getTransactionCount'>;

export interface FindComposerTransactionInput {
  chain: BagChain;
  wallet: string;
  /** ERC-20s the transaction sells (each leaves the wallet in it). */
  soldTokens: string[];
  expected: { to: string; data: string; value: string };
  /** When the intent was created: nothing earlier can be its transaction. */
  since: Date;
  /** Injected in tests; defaults to the chain's server client. */
  client?: SearchClient;
}

const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** First block whose timestamp is at or after `timestamp` (binary search on block times). */
async function firstBlockAtOrAfter(client: SearchClient, timestamp: bigint, latest: bigint): Promise<bigint> {
  let lo = BigInt(0);
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / BigInt(2);
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < timestamp) lo = mid + BigInt(1);
    else hi = mid;
  }
  return lo;
}

type OutflowLog = { transactionHash: `0x${string}` | null; args: { value?: bigint } };
type OutflowScan = { kind: 'OK'; client: SearchClient; logs: OutflowLog[] } | { kind: 'UNKNOWN'; reason: string };

/** Every ERC-20 Transfer of `tokens` FROM the wallet since `since` (bounded), or UNKNOWN while anything is uncertain. */
async function scanWalletOutflows(input: { chain: BagChain; wallet: string; tokens: string[]; since: Date; client?: SearchClient }): Promise<OutflowScan> {
  if (!input.client && !hasRpcEndpoint(input.chain)) return { kind: 'UNKNOWN', reason: `no RPC endpoint for ${input.chain}` };
  if (input.tokens.length === 0) return { kind: 'UNKNOWN', reason: 'the intent sells no ERC-20 to search by' };
  const client = input.client ?? getChainPublicClient(input.chain);
  const wallet = input.wallet as `0x${string}`;
  // A transaction from the wallet still in the mempool could be this one: decide later.
  const [pending, mined] = await Promise.all([
    client.getTransactionCount({ address: wallet, blockTag: 'pending' }),
    client.getTransactionCount({ address: wallet, blockTag: 'latest' }),
  ]);
  if (pending > mined) return { kind: 'UNKNOWN', reason: 'a transaction from the wallet is still pending' };

  const latest = await client.getBlockNumber();
  const fromBlock = await firstBlockAtOrAfter(client, BigInt(Math.floor(input.since.getTime() / 1000)), latest);
  const lastBlock = fromBlock + COMPOSER_SEARCH_MAX_BLOCKS < latest ? fromBlock + COMPOSER_SEARCH_MAX_BLOCKS : latest;

  const logs: OutflowLog[] = [];
  for (let start = fromBlock; start <= lastBlock; start += COMPOSER_SEARCH_CHUNK_BLOCKS) {
    const end = start + COMPOSER_SEARCH_CHUNK_BLOCKS - BigInt(1) < lastBlock ? start + COMPOSER_SEARCH_CHUNK_BLOCKS - BigInt(1) : lastBlock;
    const chunk = await client.getLogs({
      address: input.tokens as `0x${string}`[],
      event: TRANSFER_EVENT,
      args: { from: wallet },
      fromBlock: start,
      toBlock: end,
    });
    logs.push(...chunk);
  }
  return { kind: 'OK', client, logs };
}

export async function findComposerTransactionFromWallet(input: FindComposerTransactionInput): Promise<ComposerTxSearchResult> {
  try {
    const scan = await scanWalletOutflows({ chain: input.chain, wallet: input.wallet, tokens: input.soldTokens, since: input.since, client: input.client });
    if (scan.kind === 'UNKNOWN') return scan;
    const candidates = new Set(scan.logs.map((log) => log.transactionHash).filter((h): h is `0x${string}` => !!h));

    for (const hash of candidates) {
      const tx = await scan.client.getTransaction({ hash });
      const direct = same(tx.to, input.expected.to) && same(tx.input, input.expected.data) && tx.value === BigInt(input.expected.value || '0');
      // A wallet batch (EIP-5792 / EIP-7702): the wallet calls itself, or a DelegationManager (MetaMask smart account),
      // and the exact Composer call is one of the batched calls.
      const walletBatch = isWalletRoutedBatch(tx, input.wallet, input.expected, input.chain);
      if (same(tx.from, input.wallet) && (direct || walletBatch)) {
        return { kind: 'FOUND', txHash: hash };
      }
    }
    return { kind: 'NOT_FOUND' };
  } catch (err) {
    return { kind: 'UNKNOWN', reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface FindTokenSaleInput {
  chain: BagChain;
  wallet: string;
  /** The ERC-20 one per-asset swap sells, and exactly how much of it. */
  token: string;
  amountRaw: string;
  since: Date;
  /** Hashes already attributed to something else (e.g. another step of the same sale). */
  exclude?: string[];
  client?: SearchClient;
}

/**
 * "Did the wallet send this per-asset swap?" — for a per-asset sale whose SUBMITTED report never arrived. The LI.FI
 * SDK re-quotes at execution, so the calldata is not known in advance; the swap is found by what it must do: a
 * transaction sent BY the wallet that moves exactly `amountRaw` of `token` out of it, after the sale was created.
 * This only proposes a hash; the caller still verifies it through the provider (trackStepStatus) and claims it once.
 */
export async function findTokenSaleTransactionFromWallet(input: FindTokenSaleInput): Promise<ComposerTxSearchResult> {
  try {
    const scan = await scanWalletOutflows({ chain: input.chain, wallet: input.wallet, tokens: [input.token], since: input.since, client: input.client });
    if (scan.kind === 'UNKNOWN') return scan;
    const amount = BigInt(input.amountRaw);
    const excluded = new Set((input.exclude ?? []).map((h) => h.toLowerCase()));
    for (const log of scan.logs) {
      if (!log.transactionHash || log.args.value !== amount || excluded.has(log.transactionHash.toLowerCase())) continue;
      const tx = await scan.client.getTransaction({ hash: log.transactionHash });
      if (same(tx.from, input.wallet)) return { kind: 'FOUND', txHash: log.transactionHash };
    }
    return { kind: 'NOT_FOUND' };
  } catch (err) {
    return { kind: 'UNKNOWN', reason: err instanceof Error ? err.message : String(err) };
  }
}
