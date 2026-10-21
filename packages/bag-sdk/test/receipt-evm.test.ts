import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHardhatRuntimeEnvironment } from 'hardhat/hre';
import type { NetworkConnection } from 'hardhat/types/network';
import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, type Address, type Abi, type Hex, type PublicClient } from 'viem';
import { compileBag, parseBag, verifyPurchaseReceipt, NATIVE_TOKEN } from '../src';
import { withReceiptEvidence } from '../src/adapters/evm';
import { externalBag } from './helpers';

// Real in-process EVM, no external network or database. The deliberately dishonest
// token proves that an event amount does not replace an actual balance read.
const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string };
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { 'ReceiptToken.sol': { content: `
    pragma solidity ^0.8.24;
    contract ReceiptToken {
      mapping(address => uint256) public balanceOf;
      event Transfer(address indexed from, address indexed to, uint256 value);
      function buy(address recipient, uint256 actual, uint256 reported) external payable {
        require(actual != 777, "deliberate revert");
        balanceOf[recipient] += actual;
        emit Transfer(address(this), recipient, reported);
      }
    }
    contract ReceiptWallet {
      function execute(address target, uint256 value, bytes calldata data) external payable {
        (bool ok,) = target.call{value:value}(data); require(ok);
      }
      function attemptAndCall(address target, uint256 value, bytes calldata first, bytes calldata second) external payable {
        (bool ignored,) = target.call{value:value}(first); ignored;
        (bool ok,) = target.call{value:value}(second); require(ok);
      }
    }
  ` } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const artifact = output.contracts['ReceiptToken.sol'].ReceiptToken;
const abi = artifact.abi as Abi;
const walletArtifact = output.contracts['ReceiptToken.sol'].ReceiptWallet;
const walletAbi = walletArtifact.abi as Abi;
let connection: NetworkConnection;
let client: PublicClient;
const chain = defineChain({ id: 4663, name: 'SDK local EVM', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const transport = () => custom({ request: args => connection.provider.request(args) });
const localWallet = (account: Address) => createWalletClient({ account, chain, transport: transport() });
let wallet: ReturnType<typeof localWallet>;
let token: Hex;
let smartWallet: Hex;

beforeAll(async () => {
  // Minimal local runtime: no root-config plugins, user keystore or global wallet state.
  const runtime = await createHardhatRuntimeEnvironment({ networks: { sdk: { type: 'edr-simulated', chainId: 4663 } } });
  connection = await runtime.network.connect('sdk');
  client = createPublicClient({ chain, transport: transport() }) as PublicClient;
  const accounts = await connection.provider.request({ method: 'eth_accounts' }) as Address[];
  wallet = localWallet(accounts[0]);
  const hash = await wallet.deployContract({ abi, bytecode: ('0x' + artifact.evm.bytecode.object) as Hex });
  const receipt = await client.waitForTransactionReceipt({ hash });
  token = receipt.contractAddress!;
  const walletHash = await wallet.deployContract({ abi: walletAbi, bytecode: ('0x' + walletArtifact.evm.bytecode.object) as Hex });
  smartWallet = (await client.waitForTransactionReceipt({ hash: walletHash })).contractAddress!;
}, 60_000);
afterAll(async () => { await connection?.close(); });

async function purchase(actual: bigint, reported: bigint, recipient = wallet.account.address, signer = wallet.account.address) {
  const raw = externalBag();
  raw.definition.assets = [{ chain: 'robinhood', address: token, decimals: 18, weightBps: 10000 }];
  raw.definition.rules.weightBounds = { minBps: 100, maxBps: 10000 };
  raw.definition.rules.minInvestment = null;
  delete raw.metadata; delete raw.definitionHash;
  const parsed = parseBag(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const data = encodeFunctionData({ abi, functionName: 'buy', args: [recipient, actual, reported] });
  const compiled = await compileBag(parsed.bag, {
    inputToken: NATIVE_TOKEN, amountRaw: BigInt(10000), signer,
  }, {
    provider: { name: 'local-evm', async compile(request) {
      return { transaction: { to: token, data, value: request.amountRaw.toString(), chainId: 4663 },
        executor: null, approvals: [], legs: [{ token, expectedOutRaw: '1000', minOutRaw: '900' }], priceImpactBps: 0, gasLimit: null, fees: [] };
    } },
    trust: { chainId: 4663, allowedTransactionTargets: [token], allowedApprovalSpenders: [] },
  });
  return { compiled, data, options: { client: withReceiptEvidence(client), minimumReceived: [{ token, amountRaw: BigInt(900) }] } };
}

describe('SDK receipt verification against actual local EVM state', () => {
  it('verifies an actual signed local purchase using canonical historical balance reads', async () => {
    const f = await purchase(BigInt(1000), BigInt(1000));
    const hash = await wallet.sendTransaction({ to: token, data: f.data, value: f.compiled.transaction.value });
    await client.waitForTransactionReceipt({ hash });
    const result = await verifyPurchaseReceipt(f.compiled, { ...f.options, transactionHash: hash });
    expect(result.issues).toEqual([]);
    expect(result.status).toBe('VERIFIED');
    expect(result.balanceScope).toBe('SINGLE_TRANSACTION_BLOCK');
    expect(result.outputs[0].balanceDeltaRaw).toBe(BigInt(1000));
  });

  it('rejects a token that reports 1000 units in logs but credits only 10 units', async () => {
    const f = await purchase(BigInt(10), BigInt(1000));
    const hash = await wallet.sendTransaction({ to: token, data: f.data, value: f.compiled.transaction.value });
    await client.waitForTransactionReceipt({ hash });
    const result = await verifyPurchaseReceipt(f.compiled, { ...f.options, transactionHash: hash });
    expect(result.status).toBe('FAILED');
    expect(result.outputs[0]).toMatchObject({ netReceivedRaw: BigInt(1000), balanceDeltaRaw: BigInt(10) });
  });

  it('verifies a relayed smart-wallet call using the actual execution trace and actual balances', async () => {
    const f = await purchase(BigInt(1000), BigInt(1000), smartWallet, smartWallet);
    const data = encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: [token, f.compiled.transaction.value, f.data] });
    const hash = await wallet.sendTransaction({ to: smartWallet, data, value: f.compiled.transaction.value });
    await client.waitForTransactionReceipt({ hash });
    const result = await verifyPurchaseReceipt(f.compiled, { ...f.options, transactionHash: hash });
    expect(result.issues).toEqual([]);
    expect(result.status).toBe('VERIFIED');
    expect(result.transactionBinding).toBe('CALL_TRACE');
    expect(result.outputs[0].balanceDeltaRaw).toBe(BigInt(1000));
  });

  it('does not accept a reverted inner call even when another call supplies enough tokens', async () => {
    const f = await purchase(BigInt(777), BigInt(1000), smartWallet, smartWallet);
    const donation = encodeFunctionData({ abi, functionName: 'buy', args: [smartWallet, BigInt(1000), BigInt(1000)] });
    const data = encodeFunctionData({ abi: walletAbi, functionName: 'attemptAndCall', args: [token, f.compiled.transaction.value, f.data, donation] });
    const hash = await wallet.sendTransaction({ to: smartWallet, data, value: f.compiled.transaction.value * BigInt(2) });
    await client.waitForTransactionReceipt({ hash });
    const result = await verifyPurchaseReceipt(f.compiled, { ...f.options, transactionHash: hash });
    expect(result.status).toBe('FAILED');
    expect(result.issues[0].code).toBe('COMPILED_CALL_NOT_EXECUTED');
  });

  it('refuses to attribute all balance changes in a busy block to the first purchase', async () => {
    const f = await purchase(BigInt(1000), BigInt(1000));
    const nonce = await client.getTransactionCount({ address: wallet.account.address });
    await connection.provider.request({ method: 'evm_setAutomine', params: [false] });
    let first: Hex;
    try {
      first = await wallet.sendTransaction({ to: token, data: f.data, value: f.compiled.transaction.value, gas: BigInt(200000), nonce });
      await wallet.sendTransaction({ to: token, data: f.data, value: f.compiled.transaction.value, gas: BigInt(200000), nonce: nonce + 1 });
      await connection.provider.request({ method: 'evm_mine', params: [] });
    } finally { await connection.provider.request({ method: 'evm_setAutomine', params: [true] }); }
    const result = await verifyPurchaseReceipt(f.compiled, { ...f.options, transactionHash: first! });
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('BALANCE_EVIDENCE_UNAVAILABLE');
    // EDR accepts a traceCall config but ignores txIndex. Unknown implementations
    // must be refused instead of presenting block-wide data as transaction state.
    const indexed = await verifyPurchaseReceipt(f.compiled, {
      ...f.options, client: withReceiptEvidence(client, { balanceState: 'GETH_TRANSACTION_INDEX' }), transactionHash: first!,
    });
    expect(indexed.status).toBe('INDETERMINATE');
    expect(indexed.issues[0].code).toBe('BALANCE_EVIDENCE_UNAVAILABLE');
  });
});
