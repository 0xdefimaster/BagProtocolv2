import { createPublicClient, custom, encodeFunctionData, erc20Abi } from 'viem';
import { getEthereumProvider, type Eip1193Provider } from '@/lib/wallet/eth-provider';
import { describeWalletError } from './wallet-error';
import { ensureErc20AllowanceOnChain, getBrowserWalletClientForChain, sendComposerTransaction, simulateTransactionOnChain } from './lifi-wallet-client';

// -----------------------------------------------------------------------------
// Browser side of the wallet sweep (lib/server/wallet-holdings.ts): approve each
// token being sold (exact amounts, only when the allowance is short), dry-run
// the Composer transaction, send it, wait for its receipt. The server compiled
// the transaction; only the user's wallet signs.
//
// One confirmation when the wallet can (EIP-5792): if any approval is needed
// and the wallet reports ATOMIC batching for this chain (Rabby, MetaMask smart
// accounts, Coinbase Smart Wallet…), the exact-amount approvals and the sale
// are sent as one `wallet_sendCalls` batch with `atomicRequired: true`: one
// confirmation, and either everything lands or nothing does (a reverted sale
// also reverts its approvals, so no allowance is left behind). Same calls,
// same amounts, same spender as the sequential path; nothing is loosened.
// The sale cannot be dry-run before its approvals exist, so the batch relies
// on atomicity (and the wallet's own simulation) instead. A wallet without
// EIP-5792 or without atomic batching gets the sequential flow unchanged.
// -----------------------------------------------------------------------------

export interface SweepTransactionPlan {
  transaction: { to: string; data: string; value: string; chainId: number };
  approvals: { token: string; spender: string; amountRaw: string }[];
}

export type SweepProgress = 'approving' | 'batching' | 'simulating' | 'signing' | 'confirming';

type Hex = `0x${string}`;
type Call = { to: Hex; data: Hex; value: Hex };
type CallsStatus = { status?: number | string; atomic?: boolean; receipts?: { transactionHash?: string; status?: string }[] };

/** EIP-5792 / EIP-1193 codes meaning "this wallet cannot batch", not "the user said no". */
const BATCH_UNSUPPORTED_CODES = new Set([4200, 5700, 5710, 5750, -32601, -32602]);
const BATCH_POLL_MS = 1500;
const BATCH_TIMEOUT_MS = 10 * 60 * 1000;

const toHexChain = (chainId: number) => `0x${chainId.toString(16)}` as Hex;

/** Whether the wallet reports atomic batching for `chainId` (EIP-5792 v2 `atomic`, or the older `atomicBatch`). */
export async function walletSupportsAtomicBatch(provider: Eip1193Provider, walletAddress: string, chainId: number): Promise<boolean> {
  let caps: unknown;
  try {
    caps = await provider.request({ method: 'wallet_getCapabilities', params: [walletAddress, [toHexChain(chainId)]] });
  } catch {
    return false; // no EIP-5792 at all
  }
  if (!caps || typeof caps !== 'object') return false;
  const byChain = caps as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined>;
  for (const key of [toHexChain(chainId), String(chainId), '0x0']) {
    const c = byChain[key];
    if (!c) continue;
    if (c.atomic?.status === 'supported' || c.atomic?.status === 'ready') return true;
    if (c.atomicBatch?.supported === true) return true;
  }
  return false;
}

async function shortApprovals(provider: Eip1193Provider, walletAddress: string, plan: SweepTransactionPlan) {
  const publicClient = createPublicClient({ transport: custom(provider) });
  const short: SweepTransactionPlan['approvals'] = [];
  for (const a of plan.approvals) {
    const current = await publicClient.readContract({
      address: a.token as Hex,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [walletAddress as Hex, a.spender as Hex],
    });
    if (current < BigInt(a.amountRaw)) short.push(a);
  }
  return short;
}

/** Thrown when the wallet turned the batch down for lack of support: the caller falls back to the sequential flow. */
class BatchUnsupportedError extends Error {}

/** Sends approvals + sale as one atomic EIP-5792 batch and returns the sale's transaction hash. */
export async function sendSweepBatch(
  provider: Eip1193Provider,
  walletAddress: string,
  plan: SweepTransactionPlan,
  approvals: SweepTransactionPlan['approvals'],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Hex> {
  const { transaction } = plan;
  const calls: Call[] = [
    ...approvals.map((a) => ({
      to: a.token as Hex,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender as Hex, BigInt(a.amountRaw)] }),
      value: '0x0' as Hex,
    })),
    { to: transaction.to as Hex, data: transaction.data as Hex, value: `0x${BigInt(transaction.value).toString(16)}` as Hex },
  ];

  let sent: unknown;
  try {
    sent = await provider.request({
      method: 'wallet_sendCalls',
      params: [{ version: '2.0.0', chainId: toHexChain(transaction.chainId), from: walletAddress, atomicRequired: true, calls }],
    });
  } catch (err) {
    const { code, rejected } = describeWalletError(err);
    if (!rejected && BATCH_UNSUPPORTED_CODES.has(Number(code))) throw new BatchUnsupportedError();
    throw err;
  }
  const id = typeof sent === 'string' ? sent : (sent as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new Error('Your wallet did not return an id for the sale.');

  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  for (;;) {
    let status = null as CallsStatus | null;
    try {
      status = (await provider.request({ method: 'wallet_getCallsStatus', params: [id] })) as CallsStatus | null;
    } catch {
      // The wallet may not know the id for a moment right after sending; keep polling until the deadline.
    }
    const s = status?.status;
    const done = s === 200 || s === 'CONFIRMED';
    const failed = typeof s === 'number' ? s >= 400 : s === 'FAILED';
    if (failed) throw new Error('The sale reverted on-chain. Nothing was sold and no approval was left behind.');
    if (done) {
      const receipts = status?.receipts ?? [];
      const last = receipts[receipts.length - 1];
      if (!last?.transactionHash) throw new Error('Your wallet confirmed the sale but did not report its transaction.');
      if (receipts.some((r) => r.status !== undefined && r.status !== '0x1' && r.status !== 'success')) {
        throw new Error('The sale transaction reverted on-chain. Your tokens were not sold.');
      }
      return last.transactionHash as Hex;
    }
    if (Date.now() > deadline) throw new Error('The sale is still pending in your wallet. Check your wallet activity before trying again.');
    await sleep(BATCH_POLL_MS);
  }
}

export async function executeWalletSweep(
  walletAddress: string,
  plan: SweepTransactionPlan,
  onProgress: (step: SweepProgress) => void = () => {}
): Promise<Hex> {
  const { transaction } = plan;

  if (plan.approvals.length > 0) {
    await getBrowserWalletClientForChain(walletAddress, transaction.chainId); // switch network first
    const provider = getEthereumProvider();
    if (provider) {
      const needed = await shortApprovals(provider, walletAddress, plan);
      if (needed.length > 0 && (await walletSupportsAtomicBatch(provider, walletAddress, transaction.chainId))) {
        onProgress('batching');
        try {
          return await sendSweepBatch(provider, walletAddress, plan, needed);
        } catch (err) {
          if (!(err instanceof BatchUnsupportedError)) throw err;
          // Wallet advertised batching but refused it: fall through to one approval at a time.
        }
      }
    }
  }

  if (plan.approvals.length > 0) onProgress('approving');
  for (const approval of plan.approvals) {
    await ensureErc20AllowanceOnChain(walletAddress, transaction.chainId, approval.token, approval.spender, approval.amountRaw);
  }
  onProgress('simulating');
  await simulateTransactionOnChain(walletAddress, transaction.chainId, transaction, 'sale');
  onProgress('signing');
  const hash = await sendComposerTransaction(walletAddress, transaction);
  onProgress('confirming');
  const provider = getEthereumProvider();
  if (!provider) throw new Error('Wallet disconnected before the sale confirmed.');
  const receipt = await createPublicClient({ transport: custom(provider) }).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The sale transaction reverted on-chain. Your tokens were not sold.');
  return hash;
}
