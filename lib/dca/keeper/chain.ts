import { decodeErrorResult, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem';
import { RECURRING_EXECUTOR_ABI, type recurringAuthorizationTypedData, type RecurringAuthorization } from '../../../packages/bag-sdk/src/recurring';
import type { QuoteClient } from '../../../packages/bag-sdk/src/adapters/uniswap-v3';
import { withReceiptEvidence, type ReceiptEvidenceOptions } from '../../../packages/bag-sdk/src/adapters/receipt-rpc';
import type { PurchaseReceiptClient } from '../../../packages/bag-sdk/src/receipt';
import type { ChainExecutionState } from './types';

/** `execute` arguments, as the executor ABI takes them. */
export interface ExecuteCall {
  authorization: RecurringAuthorization;
  execution: { authorizationId: Hex; window: bigint; quoteDeadline: bigint; plan: unknown; planSignature: Hex };
  ownerSignature: Hex;
  fundingProof: Hex;
}

export interface ExecutionLog {
  window: bigint;
  executionIndex: bigint;
  hash: Hex;
  blockNumber: bigint;
}

/** Everything the keeper reads from or sends to the chain. One implementation per transport; tests can fake it. */
export interface KeeperChain {
  /** The keeper account that pays gas. */
  readonly keeper: Hex;
  readonly quoteClient: QuoteClient;
  /** Transaction, receipt and transaction-scoped balance reads for `verifyRecurringPurchase`. */
  readonly receiptClient: PurchaseReceiptClient;
  /** EOA or ERC-1271 (smart account) check of the owner's EIP-712 signature, through the chain. */
  verifyOwnerSignature(owner: Hex, typedData: ReturnType<typeof recurringAuthorizationTypedData>, signature: Hex): Promise<boolean>;
  latestTimestamp(): Promise<bigint>;
  latestBlock(): Promise<bigint>;
  getState(executor: Hex, owner: Hex, id: Hex): Promise<ChainExecutionState>;
  ownerFunds(auth: RecurringAuthorization, executor: Hex): Promise<{ balance: bigint; allowance: bigint }>;
  keeperBalance(): Promise<bigint>;
  /** Nonce of the keeper account: mined (`latest`) and including the mempool (`pending`). */
  nonces(): Promise<{ latest: number; pending: number }>;
  gasPrice(): Promise<bigint>;
  /** `PurchaseExecuted` logs of one authorization since `fromBlock`. */
  executions(executor: Hex, owner: Hex, id: Hex, fromBlock: bigint): Promise<ExecutionLog[]>;
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
  simulateExecute(executor: Hex, call: ExecuteCall): Promise<{ ok: true; gas: bigint } | { ok: false; reason: string }>;
  sendExecute(executor: Hex, call: ExecuteCall, nonce: number, gas: bigint): Promise<Hex>;
}

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/** Decoded revert name and arguments when the executor ABI knows the error; otherwise the short message. */
export function revertReasonOf(e: unknown): string {
  for (let x: any = e; x; x = x.cause) {
    if (x?.data?.errorName) return `${x.data.errorName}(${(x.data.args ?? []).map(String).join(',')})`;
    if (typeof x?.reason === 'string') return x.reason;
    const raw = typeof x?.data === 'string' ? x.data : typeof x?.data?.data === 'string' ? x.data.data : null;
    if (raw && /^0x[0-9a-fA-F]{8,}$/.test(raw)) {
      try {
        const d = decodeErrorResult({ abi: RECURRING_EXECUTOR_ABI, data: raw as Hex });
        return `${d.errorName}(${(d.args ?? []).map(String).join(',')})`;
      } catch {
        return raw.slice(0, 10);
      }
    }
  }
  return String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 200);
}

const isRevert = (e: unknown) => {
  for (let x: any = e; x; x = x.cause) if (x?.name === 'ContractFunctionRevertedError' || x?.name === 'ExecutionRevertedError') return true;
  return false;
};
const isTransportFailure = (e: unknown) => {
  for (let x: any = e; x; x = x.cause) if (['HttpRequestError', 'TimeoutError', 'WebSocketRequestError'].includes(x?.name)) return true;
  return false;
};

export class KeeperRpcError extends Error {
  constructor(readonly operation: string) {
    super(`RPC read failed: ${operation}`);
    this.name = 'KeeperRpcError';
  }
}

/**
 * viem implementation. The wallet client holds the KEEPER key only; it never holds a user's or the planSigner's key.
 * `evidence.balanceState` selects how purchase balances are read (default SINGLE_TRANSACTION_BLOCK: correct only when
 * the purchase is the block's only transaction touching those balances, otherwise INDETERMINATE). On Robinhood Chain
 * use ROBINHOOD_NITRO_TRANSACTION_INDEX with a qualified Nitro reader.
 */
export function createViemKeeperChain(params: { publicClient: PublicClient<Transport, Chain | undefined>; walletClient: WalletClient<Transport, Chain | undefined, Account>; evidence?: ReceiptEvidenceOptions }): KeeperChain {
  const { publicClient: pc, walletClient: wc } = params;
  const keeper = wc.account.address;
  const read = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw new KeeperRpcError(operation);
    }
  };
  const args = (c: ExecuteCall) => [c.authorization, c.execution, c.ownerSignature, c.fundingProof] as const;
  return {
    keeper,
    quoteClient: pc as unknown as QuoteClient,
    receiptClient: withReceiptEvidence(pc as unknown as Parameters<typeof withReceiptEvidence>[0], params.evidence),
    verifyOwnerSignature: (owner, typedData, signature) => read('verifyTypedData', () => pc.verifyTypedData({ address: owner, ...(typedData as any), signature })),
    latestTimestamp: () => read('getBlock', async () => (await pc.getBlock()).timestamp),
    latestBlock: () => read('getBlockNumber', () => pc.getBlockNumber()),
    getState: (executor, owner, id) =>
      read('getState', async () => {
        const s = (await pc.readContract({ address: executor, abi: RECURRING_EXECUTOR_ABI, functionName: 'getState', args: [owner, id] })) as any;
        return { executions: Number(s.executions), grossUsed: s.grossUsed, lastWindow: BigInt(s.lastWindow), lastExecutionAt: BigInt(s.lastExecutionAt), revoked: s.revoked };
      }),
    ownerFunds: (auth, executor) =>
      read('ownerFunds', async () => ({
        balance: (await pc.readContract({ address: auth.inputToken, abi: ERC20, functionName: 'balanceOf', args: [auth.sourceAccount] })) as bigint,
        allowance: (await pc.readContract({ address: auth.inputToken, abi: ERC20, functionName: 'allowance', args: [auth.sourceAccount, executor] })) as bigint,
      })),
    keeperBalance: () => read('getBalance', () => pc.getBalance({ address: keeper })),
    nonces: () =>
      read('getTransactionCount', async () => ({
        latest: await pc.getTransactionCount({ address: keeper, blockTag: 'latest' }),
        pending: await pc.getTransactionCount({ address: keeper, blockTag: 'pending' }),
      })),
    gasPrice: () => read('getGasPrice', () => pc.getGasPrice()),
    executions: (executor, owner, id, fromBlock) =>
      read('getLogs', async () => {
        const logs = await pc.getContractEvents({ address: executor, abi: RECURRING_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner, authorizationId: id }, fromBlock, toBlock: 'latest' });
        return logs.map((l: any) => ({ window: l.args.window as bigint, executionIndex: l.args.executionIndex as bigint, hash: l.transactionHash as Hex, blockNumber: l.blockNumber as bigint }));
      }),
    receipt: async (hash) => {
      try {
        const r = await pc.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (e) {
        if ((e as Error)?.name === 'TransactionReceiptNotFoundError') return null;
        throw new KeeperRpcError('getTransactionReceipt');
      }
    },
    simulateExecute: async (executor, call) => {
      try {
        await pc.simulateContract({ account: wc.account, address: executor, abi: RECURRING_EXECUTOR_ABI, functionName: 'execute', args: args(call) as any });
        const gas = await pc.estimateContractGas({ account: wc.account, address: executor, abi: RECURRING_EXECUTOR_ABI, functionName: 'execute', args: args(call) as any });
        return { ok: true, gas };
      } catch (e) {
        if (!isRevert(e) && isTransportFailure(e)) throw new KeeperRpcError('simulate execute');
        return { ok: false, reason: revertReasonOf(e) };
      }
    },
    sendExecute: (executor, call, nonce, gas) =>
      wc.writeContract({ account: wc.account, chain: wc.chain ?? null, address: executor, abi: RECURRING_EXECUTOR_ABI, functionName: 'execute', args: args(call) as any, nonce, gas }),
  };
}
