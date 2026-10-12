'use client';

import { getEthereumProvider } from '@/lib/wallet/eth-provider';
import { createClient, SDKClient } from '@lifi/sdk';
import { EthereumProvider, EthereumSDKProvider } from '@lifi/sdk-provider-ethereum';
import { createPublicClient, createWalletClient, custom, erc20Abi, type Chain, type WalletClient } from 'viem';
import { BAG_CHAINS, bagChainByChainId } from '@/lib/config/chains';

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 1/4/6: THE ONLY place a real transaction gets built
// and signed. This module runs entirely in the browser ('use client'), talks
// only to `window.ethereum` (the same EIP-1193 provider lib/wallet-context.tsx
// already connects), and never imports anything server-only. No private
// key, seed phrase, or server-issued credential of any kind is read here —
// every signature comes from the wallet extension's own UI.
//
// Deliberately separate from lib/blockchain/lifi-config.ts (the SERVER's
// memoized `@lifi/sdk` client, used for quoting only) — that module is
// imported from API routes and must never see this file's browser-only
// EthereumProvider setup, and this file must never import that module's
// `LIFI_API_KEY`-reading `getLiFiClient()` (server-only secret).
// -----------------------------------------------------------------------------

// Mirrors lib/blockchain/lifi-config.ts's ChainId -> numeric mapping, but
// as a viem `Chain` object (id + native currency + a fallback RPC) rather
// than a bare number — needed here because viem's `WalletClient` uses this
// for signing-domain/typed-data validation. `custom(window.ethereum)` is
// what actually SENDS requests, so `rpcUrls` below is only ever a fallback
// viem itself may consult, never load-bearing for signing.
// Chain ids, names, public RPCs and explorers come from lib/config/chains.ts only.
const VIEM_CHAINS_BY_NUMERIC_ID: Record<number, Chain> = Object.fromEntries(Object.values(BAG_CHAINS).map((c) => [c.chainId, c.viemChain]));

function toHexChainId(numericChainId: number): `0x${string}` {
  return `0x${numericChainId.toString(16)}`;
}

/** Throws with a clear, UI-safe message rather than a `window.ethereum` `undefined` TypeError — this file is only ever called after `useWallet().isConnected`/`hasProvider` is already true, so hitting this is a real bug, not an expected path. */
function requireInjectedProvider(): NonNullable<Window['ethereum']> {
  if (!getEthereumProvider()) {
    throw new Error('No wallet extension found. Connect a wallet first.');
  }
  return getEthereumProvider()!;
}

/** Builds a fresh viem `WalletClient` for `walletAddress`, bound to whichever chain the wallet is CURRENTLY on (or `preferredNumericChainId` right after a chain switch, since some wallets fire `eth_chainId` slightly behind `wallet_switchEthereumChain` resolving). */
async function buildWalletClient(walletAddress: string, preferredNumericChainId?: number): Promise<WalletClient> {
  const provider = requireInjectedProvider();
  const numericChainId =
    preferredNumericChainId ?? parseInt((await provider.request({ method: 'eth_chainId' })) as string, 16);
  const chain = VIEM_CHAINS_BY_NUMERIC_ID[numericChainId];
  if (!chain) {
    throw new Error(`Your wallet is on an unsupported network (chain id ${numericChainId}). Switch networks and try again.`);
  }
  return createWalletClient({
    account: walletAddress as `0x${string}`,
    chain,
    transport: custom(provider),
  });
}

/**
 * EIP-3085 parameters to add `numericChainId` to a wallet that does not know it (Rabby and others do not ship
 * Robinhood Chain): the chain's PUBLIC RPC and explorer from lib/config, never a keyed server RPC. Null for a
 * chain BAG has no public RPC for (Ethereum mainnet: every wallet already knows it).
 */
export function addEthereumChainParams(numericChainId: number) {
  const c = bagChainByChainId(numericChainId);
  if (!c || c.publicRpcUrls.length === 0) return null;
  return {
    chainId: toHexChainId(numericChainId),
    chainName: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: [...c.publicRpcUrls],
    blockExplorerUrls: [c.explorerUrl],
  };
}

/** The wallet does not know the chain (EIP-3326 code 4902; some wallets answer -32603 with a message instead). */
export function isUnknownChainError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? Number((err as { code: unknown }).code) : undefined;
  const nested = err && typeof err === 'object' && 'data' in err ? (err as { data?: { originalError?: { code?: unknown } } }).data?.originalError?.code : undefined;
  if (code === 4902 || Number(nested) === 4902) return true;
  const message = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  return /unrecognized chain|unknown chain|chain .*not (been )?added|not added|try adding the chain/i.test(message);
}

/** Requests the wallet switch to `targetNumericChainId` (EIP-3326) and returns a fresh `WalletClient` bound to it — passed to `@lifi/sdk-provider-ethereum` as its `switchChain` hook, so LI.FI's own `executeRoute()` drives "Switch Network" prompts itself rather than this app pre-guessing which chain a route needs. */
async function switchChainAndRebuildClient(walletAddress: string, targetNumericChainId: number): Promise<WalletClient> {
  const provider = requireInjectedProvider();
  const rejected = (err: unknown) => err && typeof err === 'object' && 'code' in err && Number((err as { code: unknown }).code) === 4001;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: toHexChainId(targetNumericChainId) }],
    });
  } catch (err) {
    if (rejected(err)) throw new Error('Network switch was rejected.');
    const params = isUnknownChainError(err) ? addEthereumChainParams(targetNumericChainId) : null;
    if (!params) throw err instanceof Error ? err : new Error('Could not switch networks.');
    // The wallet does not know the chain yet: offer to add it (most wallets switch to it on approval), then switch.
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [params] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] });
    } catch (addErr) {
      if (rejected(addErr)) throw new Error(`Adding ${params.chainName} to your wallet was rejected.`);
      throw addErr instanceof Error ? addErr : new Error(`Could not add ${params.chainName} to your wallet.`);
    }
  }
  return buildWalletClient(walletAddress, targetNumericChainId);
}

/**
 * Public counterpart to `getBrowserLiFiClient()` for the ONE thing that
 * needs a raw viem `WalletClient` instead of a LI.FI SDK client: sending
 * an already-compiled LI.FI Composer transaction
 * (lib/blockchain/lifi-composer-adapter.ts's `transactionRequest` —
 * plain `{to, data, value}` calldata, not a `LiFiStep`/`Route` LI.FI's own
 * `executeRoute()` knows how to drive). Switches chain first if the
 * wallet isn't already on `numericChainId` — same EIP-3326 path
 * `switchChainAndRebuildClient()` already uses for LI.FI route execution,
 * reused here rather than duplicated.
 */
export async function getBrowserWalletClientForChain(walletAddress: string, numericChainId: number): Promise<WalletClient> {
  const provider = requireInjectedProvider();
  const currentChainId = parseInt((await provider.request({ method: 'eth_chainId' })) as string, 16);
  if (currentChainId === numericChainId) {
    return buildWalletClient(walletAddress, numericChainId);
  }
  return switchChainAndRebuildClient(walletAddress, numericChainId);
}

let cachedSdkClient: SDKClient | null = null;
let cachedEvmProvider: EthereumSDKProvider | null = null;
let cachedForAddress: string | null = null;

/**
 * Returns the browser-side LI.FI SDK client, configured to sign/send with
 * `walletAddress`'s CURRENT wallet client. Memoized per address — a
 * changed `walletAddress` (account switch — lib/wallet-context.tsx's
 * `accountsChanged` listener) rebuilds the provider's `getWalletClient`
 * hook rather than reusing a stale one bound to the previous account.
 */
export function getBrowserLiFiClient(walletAddress: string): SDKClient {
  if (cachedEvmProvider && cachedForAddress === walletAddress) {
    return cachedSdkClient as SDKClient;
  }

  const evmProvider = EthereumProvider({
    getWalletClient: () => buildWalletClient(walletAddress),
    switchChain: (chainId) => switchChainAndRebuildClient(walletAddress, chainId),
  });

  if (!cachedSdkClient) {
    cachedSdkClient = createClient({
      integrator: process.env.NEXT_PUBLIC_LIFI_INTEGRATOR ?? 'bag-protocol',
      providers: [evmProvider],
    });
  } else {
    cachedSdkClient.setProviders([evmProvider]);
  }

  cachedEvmProvider = evmProvider;
  cachedForAddress = walletAddress;
  return cachedSdkClient;
}

/** Test-only: drop every memoized client/provider — mirrors lib/blockchain/lifi-config.ts's `resetLiFiClientForTests()`. */
export function resetBrowserLiFiClientForTests(): void {
  cachedSdkClient = null;
  cachedEvmProvider = null;
  cachedForAddress = null;
}

/**
 * Sends ONE already-compiled transaction as-is — the Composer counterpart
 * to `getBrowserLiFiClient()` + `executeRoute()` above. Composer
 * (lib/blockchain/lifi-composer-adapter.ts) returns plain `{to, data,
 * value}` calldata, not a LI.FI `LiFiStep`/route, so there is nothing for
 * `@lifi/sdk`'s `executeRoute()` to do here — this just signs and
 * broadcasts exactly what the server already compiled, the same "one
 * place a real transaction gets built and signed" boundary this file's
 * header comment describes, extended to a second kind of transaction
 * rather than bypassed by building one somewhere else.
 *
 * Switches the wallet to `tx.chainId` first if it isn't already there
 * (same `wallet_switchEthereumChain` flow `executeRoute()` itself drives
 * for a LI.FI route, via `switchChainAndRebuildClient` above) — a
 * same-chain Composer flow still needs the wallet ON that chain to sign
 * correctly, this just isn't automatic the way it is inside
 * `executeRoute()`.
 */
export async function sendComposerTransaction(
  walletAddress: string,
  tx: { to: string; data: string; value: string; chainId: number }
): Promise<`0x${string}`> {
  const provider = requireInjectedProvider();
  const currentChainId = parseInt((await provider.request({ method: 'eth_chainId' })) as string, 16);
  const client =
    currentChainId === tx.chainId
      ? await buildWalletClient(walletAddress, tx.chainId)
      : await switchChainAndRebuildClient(walletAddress, tx.chainId);

  if (!client.chain) {
    throw new Error(`Your wallet is on an unsupported network. Switch to chain id ${tx.chainId} and try again.`);
  }

  return client.sendTransaction({
    account: walletAddress as `0x${string}`,
    chain: client.chain,
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value),
  });
}

/**
 * Makes sure `spender` may pull `amountRaw` of `token` from the wallet on
 * `numericChainId`, sending an exact-amount `approve` and waiting for its
 * receipt when the current allowance is short. Reads and waits through the
 * wallet's own provider, so it works on whichever chain the wallet is on.
 * Returns the approval tx hash, or null when no approval was needed.
 */
export async function ensureErc20AllowanceOnChain(
  walletAddress: string,
  numericChainId: number,
  token: string,
  spender: string,
  amountRaw: string
): Promise<`0x${string}` | null> {
  const walletClient = await getBrowserWalletClientForChain(walletAddress, numericChainId);
  const publicClient = createPublicClient({ chain: walletClient.chain, transport: custom(requireInjectedProvider()) });
  const owner = walletAddress as `0x${string}`;
  const required = BigInt(amountRaw);
  const current = await publicClient.readContract({
    address: token as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender as `0x${string}`],
  });
  if (current >= required) return null;
  const hash = await walletClient.writeContract({
    account: owner,
    chain: walletClient.chain,
    address: token as `0x${string}`,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as `0x${string}`, required],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The token approval transaction failed.');
  return hash;
}

/**
 * Dry-runs a transaction through the wallet's own provider (`eth_call` from
 * the wallet's address) so a transaction that would revert is caught before
 * the user signs it and pays gas. Throws with the node's revert reason.
 */
export async function simulateTransactionOnChain(
  walletAddress: string,
  numericChainId: number,
  tx: { to: string; data: string; value: string },
  what = 'purchase'
): Promise<void> {
  const walletClient = await getBrowserWalletClientForChain(walletAddress, numericChainId);
  const publicClient = createPublicClient({ chain: walletClient.chain, transport: custom(requireInjectedProvider()) });
  try {
    await publicClient.call({
      account: walletAddress as `0x${string}`,
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: BigInt(tx.value),
    });
  } catch (err) {
    const short = err && typeof err === 'object' && 'shortMessage' in err ? String((err as { shortMessage: unknown }).shortMessage) : null;
    throw new Error(`This ${what} would fail on-chain, so it was not sent (no gas spent). ${short ?? (err instanceof Error ? err.message : String(err))}`);
  }
}
