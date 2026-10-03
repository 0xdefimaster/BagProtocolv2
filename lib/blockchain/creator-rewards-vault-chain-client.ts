import { createWalletClient, decodeErrorResult } from 'viem';
import { getChainPublicClient, getChainTransport } from '@/lib/blockchain/rpc/clients';
import { BAG_CHAINS } from '@/lib/config/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_REWARD_TOKEN,
  DEPLOYED_CONTRACTS,
  assertRobinhoodChainMainnetLike,
} from '@/lib/config/robinhood-chain';
import { VaultChainClient } from '@/lib/server/creator-rewards-settlement';
import { VaultReadClient } from '@/lib/server/creator-rewards-reconciliation';

// -----------------------------------------------------------------------------
// Server-only. Real viem-backed implementations of VaultChainClient (used by
// the settlement worker to actually submit settleReward transactions) and
// VaultReadClient (used by the reconciliation job for read-only checks).
// Neither of these existed before — see docs/CREATOR_REWARDS_SETTLEMENT.md's
// "not yet done" list. Never imported from client code: this file reads
// CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY, a server-only secret.
//
// Minimal hand-written ABI fragment (not the full compiled Hardhat
// artifact) — same reasoning lib/blockchain/creator-rewards-vault-client.ts
// already documents: avoids a build-time dependency on artifacts/
// (gitignored, only present after `hardhat compile`) in the normal
// `next build`/runtime path.
// -----------------------------------------------------------------------------

const VAULT_ABI = [
  {
    type: 'function',
    name: 'settleReward',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'refId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refUsed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'totalOutstanding',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  { type: 'error', name: 'RefAlreadyUsed', inputs: [{ name: 'refId', type: 'bytes32' }] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'NotSettler', inputs: [] },
  {
    type: 'error',
    name: 'UnexpectedTransferAmount',
    inputs: [
      { name: 'expected', type: 'uint256' },
      { name: 'actualReceived', type: 'uint256' },
    ],
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const robinhoodChain = BAG_CHAINS.robinhood.viemChain;

function requireVaultAddress(): `0x${string}` {
  const address = DEPLOYED_CONTRACTS.creatorRewardsVault;
  if (!address) {
    throw new Error('CREATOR_REWARDS_VAULT_ADDRESS is not set — CreatorRewardsVault has not been deployed/configured yet.');
  }
  return address;
}

/**
 * Real `VaultChainClient` for `runSettlementBatch()` (lib/server/
 * creator-rewards-settlement.ts). Signs with `CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY`
 * — the settlement worker's own wallet, added as a vault settler at deploy
 * time (see scripts/deploy-creator-rewards.ts), which must separately hold
 * an ERC-20 approval on the reward token to the vault (settleReward pulls
 * funds via `safeTransferFrom`, see CreatorRewardsVault.sol's NatSpec).
 *
 * On a `RefAlreadyUsed` revert, throws an Error whose message contains
 * `"RefAlreadyUsed"` — this is NOT incidental: runSettlementBatch()'s
 * `isRefAlreadyUsedError()` string-matches exactly this to treat a retried
 * settlement as "already confirmed" rather than a real failure. If viem's
 * error-message format for a decoded custom error ever changes upstream,
 * that string match (and this comment) is the thing to update together.
 */
export function createVaultChainClient(): VaultChainClient {
  assertRobinhoodChainMainnetLike(ROBINHOOD_CHAIN_ID);
  const privateKey = process.env.CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY is not set — cannot sign settlement transactions.');
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  // The resilient transport broadcasts eth_sendRawTransaction hash-first: after
  // an ambiguous failure it looks the hash up before trying another endpoint.
  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: getChainTransport('robinhood') });
  const publicClient = getChainPublicClient('robinhood');
  const vaultAddress = requireVaultAddress();

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    async settleReward({ creator, amountRaw, refId }) {
      const txHash = await walletClient.writeContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'settleReward',
        args: [creator, amountRaw, refId],
        chain: robinhoodChain,
        account,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        // Decode the revert reason so a genuine RefAlreadyUsed (worker
        // retrying after a prior submission actually landed) is
        // distinguishable from every other revert — see this function's
        // own doc above for why the exact substring match matters.
        const reason = await decodeRevertReason(publicClient, { to: vaultAddress, txHash });
        throw new Error(`settleReward reverted (tx ${txHash}): ${reason}`);
      }

      return { txHash };
    },
    async isRefUsed(refId) {
      return publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'refUsed', args: [refId] });
    },
  };
}

/**
 * Read-only `VaultReadClient` for `runReconciliation()` (lib/server/
 * creator-rewards-reconciliation.ts). No private key needed — every call
 * here is a plain `eth_call`.
 */
export function createVaultReadClient(): VaultReadClient {
  assertRobinhoodChainMainnetLike(ROBINHOOD_CHAIN_ID);
  const publicClient = getChainPublicClient('robinhood');
  const vaultAddress = requireVaultAddress();

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    async isRefUsed(refId) {
      return publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'refUsed', args: [refId] });
    },
    async getSolvency() {
      const [totalOutstanding, vaultTokenBalance] = await Promise.all([
        publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'totalOutstanding' }),
        publicClient.readContract({
          address: ROBINHOOD_REWARD_TOKEN.address as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [vaultAddress],
        }),
      ]);
      return { totalOutstanding, vaultTokenBalance };
    },
  };
}

/** Best-effort revert-reason decode for a failed tx — falls back to a generic message rather than throwing a secondary error if decoding itself fails (e.g. an out-of-gas revert with no return data). */
async function decodeRevertReason(
  publicClient: ReturnType<typeof getChainPublicClient>,
  args: { to: `0x${string}`; txHash: `0x${string}` }
): Promise<string> {
  try {
    const tx = await publicClient.getTransaction({ hash: args.txHash });
    await publicClient.call({ to: args.to, data: tx.input, blockNumber: tx.blockNumber ?? undefined });
    return 'unknown (call succeeded on re-simulation — possibly an out-of-gas revert)';
  } catch (err) {
    if (err && typeof err === 'object' && 'data' in err && (err as { data?: `0x${string}` }).data) {
      try {
        const decoded = decodeErrorResult({ abi: VAULT_ABI, data: (err as { data: `0x${string}` }).data });
        return `${decoded.errorName}(${decoded.args?.join(', ') ?? ''})`;
      } catch {
        // Fall through to the raw message below.
      }
    }
    return String(err);
  }
}
