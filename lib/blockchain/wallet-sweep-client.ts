import { createPublicClient, custom } from 'viem';
import { getEthereumProvider } from '@/lib/wallet/eth-provider';
import { ensureErc20AllowanceOnChain, sendComposerTransaction, simulateTransactionOnChain } from './lifi-wallet-client';

// -----------------------------------------------------------------------------
// Browser side of the wallet sweep (lib/server/wallet-holdings.ts): approve each
// token being sold (exact amounts, only when the allowance is short), dry-run
// the Composer transaction, send it, wait for its receipt. The server compiled
// the transaction; only the user's wallet signs.
// -----------------------------------------------------------------------------

export interface SweepTransactionPlan {
  transaction: { to: string; data: string; value: string; chainId: number };
  approvals: { token: string; spender: string; amountRaw: string }[];
}

export type SweepProgress = 'approving' | 'simulating' | 'signing' | 'confirming';

export async function executeWalletSweep(
  walletAddress: string,
  plan: SweepTransactionPlan,
  onProgress: (step: SweepProgress) => void = () => {}
): Promise<`0x${string}`> {
  const { transaction } = plan;
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
