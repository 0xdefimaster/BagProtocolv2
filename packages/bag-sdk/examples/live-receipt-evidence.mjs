// Read-only reader qualification, not verification against an original purchase intent.
// Build the SDK first, then set RPC_URL and run with <txHash> <owner> <token> [token...].
// No credential is printed; no transaction is signed or submitted.
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { withReceiptEvidence } from '../dist/adapters/evm.js';

export async function readRobinhoodReceiptEvidence(client, transactionHash, owner, tokens) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash) || !/^0x[0-9a-fA-F]{40}$/.test(owner) ||
      tokens.length === 0 || tokens.some(token => !/^0x[0-9a-fA-F]{40}$/.test(token) || /^0x0{40}$/.test(token)) ||
      new Set(tokens.map(token => token.toLowerCase())).size !== tokens.length) throw new Error('Invalid evidence arguments');
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash: transactionHash }), client.getTransactionReceipt({ hash: transactionHash })]);
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!same(transaction.hash, transactionHash) || !same(receipt.transactionHash, transactionHash) || receipt.status !== 'success' ||
      !same(transaction.blockHash, receipt.blockHash) || transaction.blockNumber !== receipt.blockNumber ||
      !same(receipt.from, transaction.from) || !same(receipt.to, transaction.to ?? '')) throw new Error('Inconsistent mined transaction');
  const reader = withReceiptEvidence(client, { balanceState: 'ROBINHOOD_NITRO_TRANSACTION_INDEX' });
  const context = { transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, owner };
  const [callEvidence, balances] = await Promise.all([
    reader.tracePurchaseCall(context), reader.getPurchaseBalanceChanges({ ...context, tokens }),
  ]);
  const call = callEvidence.call;
  if (!call || call.type !== 'CALL' || call.error || !same(call.from, transaction.from) || !same(call.to, transaction.to ?? '') ||
      !same(call.input, transaction.input) || typeof call.value !== 'string' || BigInt(call.value) !== transaction.value) throw new Error('Trace does not match the mined transaction');
  const [block, finalReceipt] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransactionReceipt({ hash: transactionHash })]);
  if (!same(block.hash, receipt.blockHash) || !same(finalReceipt.blockHash, receipt.blockHash) || finalReceipt.blockNumber !== receipt.blockNumber || finalReceipt.status !== 'success') throw new Error('Canonical inclusion changed');
  return {
    status: 'OBSERVED_RECEIPT_EVIDENCE', purchaseVerification: 'NOT_PERFORMED',
    transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), scope: balances.scope,
    traceBoundToMinedTransaction: true,
    balances: balances.balances.map(entry => ({ token: entry.token, beforeRaw: entry.beforeRaw.toString(), afterRaw: entry.afterRaw.toString(), deltaRaw: (entry.afterRaw - entry.beforeRaw).toString() })),
  };
}

async function main() {
  const [hash, owner, ...tokens] = process.argv.slice(2);
  const endpoint = process.env.RPC_URL;
  if (!endpoint || !hash || !owner || tokens.length === 0) {
    console.error('Usage: RPC_URL=<endpoint> node packages/bag-sdk/examples/live-receipt-evidence.mjs <txHash> <owner> <token> [token...]');
    process.exitCode = 2; return;
  }
  try {
    const client = createPublicClient({ transport: http(endpoint, { retryCount: 0, timeout: 30_000 }) });
    console.log(JSON.stringify(await readRobinhoodReceiptEvidence(client, hash, owner, tokens), null, 2));
  } catch {
    // Transport exceptions can contain the complete private endpoint URL.
    console.error('INDETERMINATE: receipt evidence could not be collected or bound. Check reader capabilities, arguments and canonical inclusion.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
