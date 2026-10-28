import { BagSdkError, chainIdOf, compileBag, hashBag, isNativeToken, parseBag, simulateBag, validateBag, verifyPurchaseReceipt, verifyRegistryCommitment,
  type CompiledPurchase, type Hex, type PurchaseReceiptClient, type RegistryClient, type SimulationClient } from '@bagprotocol/sdk';
import { readTokenDecimals } from '@bagprotocol/sdk/evm';
import { lifiComposer, resolveLifiComposerAccount, type ComposerDeployment, type ComposerAccountClient } from '@bagprotocol/sdk/lifi';
import { encodeFunctionData, keccak256, stringToHex, toHex } from 'viem';

export type PlanningClient = SimulationClient & RegistryClient & ComposerAccountClient;
export type Minimum = { token: Hex; amountRaw: bigint };
export interface PurchaseIntent {
  format: 'bag-sdk-consumer/intent/v1';
  compiled: CompiledPurchase;
  minimumReceived: Minimum[];
}
export interface Snapshot { text: string; integrityHash: Hex }
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DOMAIN = 'bag-sdk-consumer/intent/v1\n';
const approveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;

function invalid(message: string): never { throw new BagSdkError('INVALID_ARGUMENT', message); }

/** Caller owns the RPC, independently reviewed deployment, API credentials and optional provenance policy. */
export async function preparePurchase(options: {
  bagText: string; inputToken: Hex; amountRaw: bigint; signer: Hex; client: PlanningClient;
  deployment: ComposerDeployment; apiKey: string; composerUrl: string; maxQuoteAgeMs?: number;
  registry?: { address: Hex; expectedCreator: Hex };
}) {
  const parsed = parseBag(options.bagText);
  if (!parsed.ok) invalid('Invalid bag.json; inspect parseBag findings before preparing.');
  const bag = parsed.bag;
  const tokens = await readTokenDecimals(bag.definition, () => options.client);
  const validation = validateBag(bag, { tokens });
  if (!validation.valid) invalid('Invalid strategy; inspect validateBag findings before preparing.');
  const provenance = options.registry ? await verifyRegistryCommitment({ bag, client: options.client,
    registry: options.registry.address, expectedCreator: options.registry.expectedCreator }) : null;
  if (provenance && !provenance.verified) invalid('Requested registry verification failed.');
  const chainId = chainIdOf(bag.definition.chain);
  const account = await resolveLifiComposerAccount({ chainId, signer: options.signer, deployment: options.deployment, client: options.client });
  const inputTokenDecimals = isNativeToken(options.inputToken) ? 18 : Number(await options.client.readContract({
    address: options.inputToken, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals',
  }));
  const compiled = await compileBag(bag, { inputToken: options.inputToken, amountRaw: options.amountRaw, inputTokenDecimals, signer: options.signer, tokens }, {
    provider: lifiComposer({ apiKey: options.apiKey, baseUrl: options.composerUrl, account }), trust: account.trust,
  });
  const simulation = await simulateBag(compiled, { client: options.client, maxQuoteAgeMs: options.maxQuoteAgeMs ?? 30_000 });
  if (simulation.status === 'QUOTE_EXPIRED') throw new BagSdkError('QUOTE_EXPIRED');
  return { definitionHash: hashBag(bag), compiled, simulation, provenance };
}

function checkMinimums(compiled: CompiledPurchase, minimumReceived: readonly Minimum[]): void {
  const tokens = new Set(compiled.quote.plan.legs.map(leg => leg.token.toLowerCase()));
  const seen = new Set<string>();
  if (!Array.isArray(minimumReceived) || minimumReceived.length !== tokens.size) invalid('Choose a wallet minimum for every swap output.');
  for (const item of minimumReceived) {
    if (!item || !ADDRESS.test(item.token) || typeof item.amountRaw !== 'bigint' || item.amountRaw <= BigInt(0) ||
      item.amountRaw >= BigInt(2) ** BigInt(256) || !tokens.has(item.token.toLowerCase()) || seen.has(item.token.toLowerCase())) invalid('Invalid or duplicate wallet minimum.');
    seen.add(item.token.toLowerCase());
  }
}

/** Called after the wallet owner reviews the ORIGINAL compiled plan and explicitly chooses NET wallet minima. */
export function createIntent(compiled: CompiledPurchase, minimumReceived: readonly Minimum[]): Snapshot {
  checkMinimums(compiled, minimumReceived);
  const intent: PurchaseIntent = { format: 'bag-sdk-consumer/intent/v1', compiled, minimumReceived: [...minimumReceived] };
  const text = JSON.stringify(intent, (_key, value: unknown) => typeof value === 'bigint' ? { $bigint: value.toString() } : value, 2) + '\n';
  return { text, integrityHash: keccak256(stringToHex(DOMAIN + text)) };
}

/** trustedHash must come from separately retained trusted application state, not from the file being loaded. */
export function restoreIntent(text: string, trustedHash: Hex): PurchaseIntent {
  if (!HASH.test(trustedHash) || keccak256(stringToHex(DOMAIN + text)).toLowerCase() !== trustedHash.toLowerCase()) invalid('Original intent checksum does not match trusted application state.');
  const intent = JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && '$bigint' in value) {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || typeof record.$bigint !== 'string' || !/^\d+$/.test(record.$bigint)) invalid('Malformed intent amount.');
      return BigInt(record.$bigint);
    }
    return value;
  }) as PurchaseIntent;
  if (intent.format !== 'bag-sdk-consumer/intent/v1' || !intent.compiled?.quote?.plan ||
    intent.compiled.transaction.chainId !== intent.compiled.quote.plan.chainId ||
    !ADDRESS.test(intent.compiled.quote.plan.signer)) invalid('Unsupported or malformed intent.');
  checkMinimums(intent.compiled, intent.minimumReceived);
  return intent;
}

export interface WalletAdapter {
  getChainId(): Promise<number>;
  getAddresses(): Promise<readonly Hex[]>;
  /** Must request the owner's wallet confirmation. Never auto-retry a potentially submitted transaction. */
  requestTransaction(tx: { chainId: number; from: Hex; to: Hex; data: Hex; value: bigint }): Promise<Hex>;
}

/** Host calls this from an explicit user action, using the independently retained intent hash. */
export async function submitWithWallet(options: {
  snapshotText: string; trustedIntentHash: Hex; wallet: WalletAdapter;
  client: SimulationClient & { waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }> };
  maxQuoteAgeMs?: number;
}): Promise<{ intentHash: Hex; transactionHash: Hex }> {
  const intent = restoreIntent(options.snapshotText, options.trustedIntentHash);
  const compiled = intent.compiled;
  const signer = compiled.quote.plan.signer as Hex;
  const checkWallet = async () => {
    if (await options.wallet.getChainId() !== compiled.transaction.chainId) throw new BagSdkError('CHAIN_MISMATCH');
    if (!(await options.wallet.getAddresses()).some(address => address.toLowerCase() === signer.toLowerCase())) invalid('The connected wallet differs from the reviewed signer.');
  };
  await checkWallet();
  const simulationOptions = { client: options.client, maxQuoteAgeMs: options.maxQuoteAgeMs ?? 30_000 };
  const before = await simulateBag(compiled, simulationOptions);
  if (before.status === 'QUOTE_EXPIRED') throw new BagSdkError('QUOTE_EXPIRED');
  if (before.status !== 'OK' && before.status !== 'NEEDS_APPROVAL') invalid('Purchase simulation is not ready.');
  if (before.status === 'NEEDS_APPROVAL') {
    for (const approval of before.missing) {
      await checkWallet();
      const fresh = await simulateBag(compiled, simulationOptions);
      if (fresh.status === 'QUOTE_EXPIRED') throw new BagSdkError('QUOTE_EXPIRED');
      if (fresh.status !== 'OK' && fresh.status !== 'NEEDS_APPROVAL') invalid('Purchase simulation is no longer ready.');
      if (fresh.status === 'OK') break;
      if (!fresh.missing.some(item => item.token.toLowerCase() === approval.token.toLowerCase() && item.spender.toLowerCase() === approval.spender.toLowerCase())) continue;
      const hash = await options.wallet.requestTransaction({ chainId: compiled.transaction.chainId, from: signer, to: approval.token, value: BigInt(0),
        data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [approval.spender, approval.amountRaw] }) });
      if (!HASH.test(hash)) invalid('Wallet did not return a transaction hash.');
      if ((await options.client.waitForTransactionReceipt({ hash })).status !== 'success') invalid('The approval transaction reverted.');
    }
  }
  await checkWallet();
  const ready = await simulateBag(compiled, simulationOptions);
  if (ready.status === 'QUOTE_EXPIRED') throw new BagSdkError('QUOTE_EXPIRED');
  if (ready.status !== 'OK') invalid('Purchase simulation must succeed after approvals.');
  const transactionHash = await options.wallet.requestTransaction({ ...compiled.transaction, from: signer });
  if (!HASH.test(transactionHash)) invalid('Wallet did not return a transaction hash.');
  // Return immediately so the host can persist the hash BEFORE waiting for receipt evidence.
  return { intentHash: options.trustedIntentHash, transactionHash };
}

/** Separate from submission: incomplete evidence must never trigger an automatic second purchase. */
export async function verifySubmitted(options: {
  snapshotText: string; trustedIntentHash: Hex; transactionHash: Hex; client: PurchaseReceiptClient; confirmations?: number;
}) {
  const intent = restoreIntent(options.snapshotText, options.trustedIntentHash);
  return verifyPurchaseReceipt(intent.compiled, { client: options.client, transactionHash: options.transactionHash,
    confirmations: options.confirmations ?? 3, minimumReceived: intent.minimumReceived });
}

export interface EthereumProvider { request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> }
/** Browser bridge. Invoke only from an explicit user action; API keys/RPC secrets stay on the host server. */
export function walletFromEthereum(ethereum: EthereumProvider): WalletAdapter {
  return {
    async getChainId() {
      const id = await ethereum.request({ method: 'eth_chainId' });
      if (typeof id !== 'string' || !/^0x[0-9a-fA-F]+$/.test(id) || !Number.isSafeInteger(Number(id))) invalid('Wallet returned an invalid chain.');
      return Number(id);
    },
    async getAddresses() {
      const addresses = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string' || !ADDRESS.test(address))) invalid('Wallet returned invalid accounts.');
      return addresses as Hex[];
    },
    async requestTransaction(tx) {
      const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{ chainId: toHex(tx.chainId), from: tx.from, to: tx.to, data: tx.data, value: toHex(tx.value) }] });
      if (typeof hash !== 'string' || !HASH.test(hash)) invalid('Wallet returned an invalid transaction hash.');
      return hash as Hex;
    },
  };
}
