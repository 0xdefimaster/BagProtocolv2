import { erc20Abi, type PublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from '@/lib/server/wallet-holdings';

// Fail-closed ERC-20 balance reads at one block, shared by wallet reconciliation (A2) and position value (A4).

/** balanceOf for each asset at `blockNumber`; null where the read failed (never a guessed 0). */
export async function readBalancesAtBlock(client: PublicClient, owner: string, assets: { address: string }[], blockNumber: bigint): Promise<(bigint | null)[]> {
  if (assets.length === 0) return [];
  const contracts = assets.map((a) => ({ address: a.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner as `0x${string}`] as const }));
  try {
    const results = await client.multicall({ multicallAddress: MULTICALL3_ADDRESS, allowFailure: true, contracts, blockNumber });
    return results.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
  } catch {
    return Promise.all(
      contracts.map((c) =>
        client
          .readContract({ ...c, blockNumber })
          .then((v) => v as bigint)
          .catch(() => null)
      )
    );
  }
}
