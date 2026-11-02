import { decodeErrorResult, parseAbi, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem';
import {
  DCA_ADAPTER_ABI,
  DCA_EXECUTOR_ABI,
  type DcaAuthorization,
  type DcaReceiptClient,
  type DcaRunState,
  type dcaAuthorizationTypedData,
} from '../../../packages/bag-sdk/src/dca';

/** `execute` arguments, as the executor ABI takes them. */
export interface ExecuteCall {
  authorization: DcaAuthorization;
  run: { authorizationId: Hex; window: bigint; deadline: bigint; fees: number[]; minOutFloors: bigint[] };
  ownerSignature: Hex;
}

export interface PurchaseLog {
  window: bigint;
  executionIndex: bigint;
  hash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

/** Everything the keeper reads from or sends to the chain. One implementation per transport; tests can fake it. */
export interface KeeperChain {
  /** The keeper account that pays gas (null in PAPER mode: nothing can be sent). */
  readonly keeper: Hex | null;
  readonly receiptClient: DcaReceiptClient;
  /** EOA or ERC-1271 check of the owner's EIP-712 signature, through the chain. */
  verifyOwnerSignature(owner: Hex, typedData: ReturnType<typeof dcaAuthorizationTypedData>, signature: Hex): Promise<boolean>;
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  getState(executor: Hex, owner: Hex, id: Hex): Promise<DcaRunState>;
  ownerFunds(auth: DcaAuthorization, executor: Hex): Promise<{ balance: bigint; allowance: bigint }>;
  keeperBalance(): Promise<bigint>;
  /** Keeper account nonce: mined (`latest`) and including the mempool (`pending`). */
  nonces(): Promise<{ latest: number; pending: number }>;
  gasPrice(): Promise<bigint>;
  /** `PurchaseExecuted` logs of one authorization since `fromBlock`. */
  purchases(executor: Hex, owner: Hex, id: Hex, fromBlock: bigint): Promise<PurchaseLog[]>;
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex } | null>;
  blockHashAt(blockNumber: bigint): Promise<Hex | null>;
  /** QuoterV2 exact-input single quote; null when the pool does not exist or cannot quote. */
  quote(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, fee: number): Promise<bigint | null>;
  simulateExecute(executor: Hex, call: ExecuteCall): Promise<{ ok: true; gas: bigint } | { ok: false; reason: string }>;
  sendExecute(executor: Hex, call: ExecuteCall, nonce: number, gas: bigint): Promise<Hex>;
}

export class KeeperRpcError extends Error {
  constructor(readonly operation: string) {
    super(`RPC read failed: ${operation}`);
    this.name = 'KeeperRpcError';
  }
}

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const QUOTER_V2 = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const FACTORY = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const ERRORS_ABI = [...DCA_EXECUTOR_ABI, ...DCA_ADAPTER_ABI];

/** Decoded revert (executor or adapter error) when known; otherwise a short message. Never includes URLs or keys. */
export function revertReasonOf(e: unknown): string {
  for (let x: any = e; x; x = x.cause) {
    if (x?.data?.errorName) return `${x.data.errorName}(${(x.data.args ?? []).map(String).join(',')})`;
    if (typeof x?.reason === 'string') return x.reason;
    const raw = typeof x?.data === 'string' ? x.data : typeof x?.data?.data === 'string' ? x.data.data : null;
    if (raw && /^0x[0-9a-fA-F]{8,}$/.test(raw)) {
      try {
        const d = decodeErrorResult({ abi: ERRORS_ABI, data: raw as Hex });
        return `${d.errorName}(${(d.args ?? []).map(String).join(',')})`;
      } catch {
        return raw.slice(0, 10);
      }
    }
  }
  return String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).split('\n')[0].replace(/https?:\/\/\S+/g, '<url>').slice(0, 300);
}

const isRevert = (e: unknown) => {
  for (let x: any = e; x; x = x.cause) if (x?.name === 'ContractFunctionRevertedError' || x?.name === 'ExecutionRevertedError') return true;
  return false;
};

/**
 * viem implementation. `walletClient` holds the KEEPER key only (never a user's); without it the chain is read-only
 * and `sendExecute` throws (PAPER mode). `logChunk` bounds eth_getLogs ranges (some providers refuse wide ranges).
 */
export function createViemKeeperChain(params: {
  publicClient: PublicClient<Transport, Chain | undefined>;
  walletClient?: WalletClient<Transport, Chain | undefined, Account> | null;
  quoter: Hex;
  v3Factory: Hex;
  logChunk?: bigint;
}): KeeperChain {
  const { publicClient: pc, walletClient: wc } = params;
  const chunk = params.logChunk ?? BigInt(10_000);
  const read = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw new KeeperRpcError(operation);
    }
  };
  const args = (c: ExecuteCall) => [c.authorization, c.run, c.ownerSignature] as const;
  const account = wc?.account ?? null;
  return {
    keeper: account?.address ?? null,
    receiptClient: pc as unknown as DcaReceiptClient,
    verifyOwnerSignature: (owner, typedData, signature) => read('verifyTypedData', () => pc.verifyTypedData({ address: owner, ...(typedData as any), signature })),
    head: () => read('getBlock', async () => {
      const b = await pc.getBlock({ blockTag: 'latest' });
      return { number: b.number!, timestamp: b.timestamp };
    }),
    getState: (executor, owner, id) =>
      read('getState', async () => {
        const s = (await pc.readContract({ address: executor, abi: DCA_EXECUTOR_ABI, functionName: 'getState', args: [owner, id] })) as any;
        return { runs: Number(s.runs), spent: s.spent, lastWindow: BigInt(s.lastWindow), lastRunAt: BigInt(s.lastRunAt), revoked: s.revoked };
      }),
    ownerFunds: (auth, executor) =>
      read('ownerFunds', async () => ({
        balance: (await pc.readContract({ address: auth.inputToken, abi: ERC20, functionName: 'balanceOf', args: [auth.owner] })) as bigint,
        allowance: (await pc.readContract({ address: auth.inputToken, abi: ERC20, functionName: 'allowance', args: [auth.owner, executor] })) as bigint,
      })),
    keeperBalance: () => read('getBalance', async () => (account ? pc.getBalance({ address: account.address }) : BigInt(0))),
    nonces: () =>
      read('getTransactionCount', async () => {
        if (!account) return { latest: 0, pending: 0 };
        return {
          latest: await pc.getTransactionCount({ address: account.address, blockTag: 'latest' }),
          pending: await pc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        };
      }),
    gasPrice: () => read('getGasPrice', () => pc.getGasPrice()),
    purchases: (executor, owner, id, fromBlock) =>
      read('getLogs', async () => {
        const head = await pc.getBlockNumber();
        const out = [];
        for (let from = fromBlock; from <= head; from += chunk) {
          const to = from + chunk - BigInt(1) < head ? from + chunk - BigInt(1) : head;
          const logs = await pc.getContractEvents({ address: executor, abi: DCA_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner, authorizationId: id }, fromBlock: from, toBlock: to });
          for (const l of logs as any[]) out.push({ window: l.args.window as bigint, executionIndex: l.args.executionIndex as bigint, hash: l.transactionHash as Hex, blockNumber: l.blockNumber as bigint, blockHash: l.blockHash as Hex });
        }
        return out;
      }),
    receipt: async (hash) => {
      try {
        const r = await pc.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash };
      } catch (e) {
        if ((e as Error)?.name === 'TransactionReceiptNotFoundError') return null;
        throw new KeeperRpcError('getTransactionReceipt');
      }
    },
    blockHashAt: (n) => read('getBlock', async () => (await pc.getBlock({ blockNumber: n })).hash ?? null),
    quote: async (tokenIn, tokenOut, amountIn, fee) => {
      const pool = await read('getPool', () => pc.readContract({ address: params.v3Factory, abi: FACTORY, functionName: 'getPool', args: [tokenIn, tokenOut, fee] }));
      if (/^0x0{40}$/i.test(pool as string)) return null;
      try {
        const { result } = await pc.simulateContract({ address: params.quoter, abi: QUOTER_V2, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: BigInt(0) }] });
        return result[0];
      } catch (e) {
        if (isRevert(e)) return null; // no liquidity in range
        throw new KeeperRpcError('quote');
      }
    },
    simulateExecute: async (executor, call) => {
      try {
        await pc.simulateContract({ account: account ?? undefined, address: executor, abi: DCA_EXECUTOR_ABI, functionName: 'execute', args: args(call) as any });
        const gas = await pc.estimateContractGas({ account: account ?? undefined, address: executor, abi: DCA_EXECUTOR_ABI, functionName: 'execute', args: args(call) as any } as any);
        return { ok: true, gas };
      } catch (e) {
        if (!isRevert(e) && ['HttpRequestError', 'TimeoutError', 'WebSocketRequestError'].some((n) => { for (let x: any = e; x; x = x.cause) if (x?.name === n) return true; return false; })) throw new KeeperRpcError('simulate execute');
        return { ok: false, reason: revertReasonOf(e) };
      }
    },
    sendExecute: async (executor, call, nonce, gas) => {
      if (!wc || !account) throw new Error('sendExecute: no keeper wallet (PAPER mode)');
      return wc.writeContract({ account, chain: wc.chain ?? null, address: executor, abi: DCA_EXECUTOR_ABI, functionName: 'execute', args: args(call) as any, nonce, gas });
    },
  };
}
