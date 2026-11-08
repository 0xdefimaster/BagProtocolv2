// Executes only the five deployments reviewed for the 2026-11-08 rollout.
// Default is read-only. --send broadcasts; the journal prevents duplicate sends.
// Secrets and signed transaction bytes are never written to evidence or stdout.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { createPublicClient, encodeDeployData, getContractAddress, http, keccak256, formatEther, padHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, arbitrum } from 'viem/chains';
import { estimateL1Fee } from 'viem/op-stack';

const OWNER = '0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46';
const TREASURY = '0x5186f0cCAB569dE1655922213074D97914378cd8';
const FACTORY_ARGS = [OWNER, TREASURY, 150000000000000n, 10000000000000000n];
const RH_FACTORY = '0x7ce5a81df434755f38cb5f67ad49a8bb3c8e6f72';
const BASE_REGISTRY = '0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920';
class RolloutError extends Error {}
const requireThat = (ok, message) => { if (!ok) throw new RolloutError(message); };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n';
const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url), 'utf8'));

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, chain: { type: 'string' }, evidence: { type: 'string', default: 'evidence/three-chain-app' }, send: { type: 'boolean', default: false } } });
  requireThat(values['env-file'] && ['base', 'arbitrum'].includes(values.chain), 'Provide --env-file and --chain base|arbitrum');
  const env = parseEnv(readFileSync(resolve(values['env-file']), 'utf8'));
  const rpcFor = name => env[`${name.toUpperCase()}_RPC_URL`] || env[`RPC_URL_${name.toUpperCase()}`] ||
    (env.ALCHEMY_API_KEY ? `https://${{ base: 'base-mainnet', arbitrum: 'arb-mainnet', robinhood: 'robinhood-mainnet' }[name]}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` :
      { base: 'https://mainnet.base.org', arbitrum: 'https://arb1.arbitrum.io/rpc', robinhood: 'https://rpc.mainnet.chain.robinhood.com' }[name]);
  const chain = values.chain === 'base' ? base : arbitrum;
  const client = createPublicClient({ chain, transport: http(rpcFor(values.chain), { timeout: 20_000, retryCount: 0 }) });
  const reference = createPublicClient({ transport: http(rpcFor('robinhood'), { timeout: 20_000, retryCount: 0 }) });
  requireThat(await client.getChainId() === chain.id && await reference.getChainId() === 4663, 'RPC chain mismatch');
  const names = ['owner', 'treasury', 'creationFee', 'creationFeeCap'];
  const refBlock = await reference.getBlockNumber();
  const sourceArgs = await Promise.all(names.map(functionName => reference.readContract({ address: RH_FACTORY, abi: artifact('BagFactory').abi, functionName, blockNumber: refBlock })));
  requireThat(sourceArgs.every((v, i) => same(v, FACTORY_ARGS[i])), 'Reference settings changed since approval');

  const dir = resolve(values.evidence);
  const manifest = JSON.parse(readFileSync(join(dir, 'unsigned-deployments.json'), 'utf8'));
  const row = manifest.chains.find(c => c.chain === values.chain);
  requireThat(same(manifest.deployer, OWNER) && row?.chainId === chain.id, 'Manifest sender or chain mismatch');
  const expectedNames = values.chain === 'base' ? ['BagFactory', 'StrategyCompositions'] : ['StrategyRegistry', 'BagFactory', 'StrategyCompositions'];
  requireThat(JSON.stringify(row.transactions.map(t => t.contract)) === JSON.stringify(expectedNames), 'Unexpected deployment sequence');
  if (values.chain === 'base') {
    requireThat(same(row.registry.address, BASE_REGISTRY), 'Unexpected existing Base registry');
    requireThat(same(await client.getCode({ address: BASE_REGISTRY }), artifact('StrategyRegistry').deployedBytecode), 'Base registry runtime changed');
  } else {
    requireThat(same(row.registry.address, row.transactions[0].predictedAddress), 'Arbitrum registry prediction mismatch');
  }

  const journalFile = join(dir, `deployments-${values.chain}.json`);
  const journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : {
    schema: 'bag-app-rollout-execution/v1', chain: values.chain, chainId: chain.id, deployer: OWNER,
    sourceCommit: '6fd983a', sourceReference: { address: RH_FACTORY, block: String(refBlock), parameters: Object.fromEntries(names.map((n, i) => [n, String(FACTORY_ARGS[i])])) },
    existingRegistry: values.chain === 'base' ? BASE_REGISTRY : null, transactions: [],
  };
  requireThat(journal.chainId === chain.id && same(journal.deployer, OWNER), 'Journal identity mismatch');
  const save = () => { writeFileSync(journalFile + '.tmp', stringify(journal)); renameSync(journalFile + '.tmp', journalFile); };
  const verifyDeployment = async (item, receipt) => {
    requireThat(receipt.status === 'success' && same(receipt.contractAddress, item.predictedAddress), `${item.contract}: receipt failed or unexpected address`);
    const art = artifact(item.contract);
    let expected = art.deployedBytecode.toLowerCase();
    const refs = Object.values(art.immutableReferences ?? {});
    requireThat(refs.length === (item.contract === 'StrategyRegistry' ? 0 : 1), `${item.contract}: unexpected immutable layout`);
    const immutableValue = item.contract === 'BagFactory' ? padHex(toHex(FACTORY_ARGS[3]), { size: 32 }) : padHex(row.registry.address, { size: 32 });
    for (const locations of refs) for (const { start, length } of locations) {
      requireThat(length === 32, `${item.contract}: unexpected immutable width`);
      expected = expected.slice(0, 2 + start * 2) + immutableValue.slice(2).toLowerCase() + expected.slice(2 + (start + length) * 2);
    }
    const code = await client.getCode({ address: item.predictedAddress });
    requireThat(same(code, expected), `${item.contract}: exact runtime mismatch`);
    let settings = {};
    if (item.contract === 'BagFactory') {
      const actual = await Promise.all(names.map(functionName => client.readContract({ address: item.predictedAddress, abi: art.abi, functionName })));
      requireThat(actual.every((v, i) => same(v, FACTORY_ARGS[i])), 'Deployed factory settings mismatch');
      settings = Object.fromEntries(names.map((n, i) => [n, String(actual[i])]));
      requireThat(same(await client.readContract({ address: item.predictedAddress, abi: art.abi, functionName: 'pendingOwner' }), '0x0000000000000000000000000000000000000000'), 'Unexpected pending owner');
    } else if (item.contract === 'StrategyCompositions') {
      const registry = await client.readContract({ address: item.predictedAddress, abi: art.abi, functionName: 'registry' });
      requireThat(same(registry, row.registry.address), 'Deployed registry binding mismatch');
      settings = { registry };
    }
    return { runtime: 'EXACT_MATCH_WITH_CONSTRUCTOR_IMMUTABLES', runtimeCodeHash: keccak256(code), settings, checkedAt: new Date().toISOString() };
  };

  // Validate every byte before permitting a private key to be loaded.
  for (const [index, item] of row.transactions.entries()) {
    const args = item.contract === 'BagFactory' ? FACTORY_ARGS : item.contract === 'StrategyCompositions' ? [row.registry.address] : [];
    const art = artifact(item.contract);
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    requireThat(JSON.stringify(item.constructorArgs) === JSON.stringify(args.map(String)), 'Constructor inputs do not match approval');
    requireThat(item.transaction.nonce === row.startingNonce + index && same(item.transaction.from, OWNER) && item.transaction.chainId === chain.id && item.transaction.value === '0' && !item.transaction.to, 'Unexpected transaction envelope');
    requireThat(same(data, item.transaction.data) && same(keccak256(data), item.initCodeHash), 'Artifact or init code changed');
    requireThat(same(getContractAddress({ from: OWNER, nonce: BigInt(item.transaction.nonce) }), item.predictedAddress), 'CREATE address mismatch');
    const prior = journal.transactions.find(t => t.contract === item.contract);
    if (prior) {
      requireThat(same(prior.initCodeHash, item.initCodeHash) && prior.nonce === item.transaction.nonce, 'Existing journal differs from manifest');
      const receipt = await client.waitForTransactionReceipt({ hash: prior.hash, confirmations: 2, timeout: 120_000, pollingInterval: 1500 });
      prior.verification = await verifyDeployment(item, receipt);
      prior.status = 'VERIFIED';
      if (values.send) save();
    } else {
      const code = await client.getCode({ address: item.predictedAddress });
      requireThat(!code || code === '0x', 'Unexpected code at deployment address; inspect before proceeding');
    }
  }
  requireThat(journal.transactions.every(t => expectedNames.includes(t.contract)), 'Unknown transaction in journal');
  const remaining = row.transactions.filter(t => !journal.transactions.some(j => j.contract === t.contract));
  const [latest, pending, senderCode, balance] = await Promise.all([
    client.getTransactionCount({ address: OWNER, blockTag: 'latest' }), client.getTransactionCount({ address: OWNER, blockTag: 'pending' }),
    client.getCode({ address: OWNER }), client.getBalance({ address: OWNER }),
  ]);
  requireThat(latest === pending && latest === row.startingNonce + journal.transactions.length, 'Deployer nonce changed or pending transactions exist');
  requireThat(!senderCode || senderCode === '0x' || /^0xef0100[0-9a-fA-F]{40}$/.test(senderCode), 'Sender is not an EOA or EIP-7702 delegated EOA');
  const ready = [];
  let estimateCeiling = 0n;
  for (const item of remaining) {
    const gasEstimate = await client.estimateGas({ account: OWNER, data: item.transaction.data, value: 0n });
    const gas = (gasEstimate * 120n + 99n) / 100n;
    requireThat(gas < 5_000_000n, 'Gas limit unexpectedly high');
    const fees = await client.estimateFeesPerGas();
    const tx = { chainId: chain.id, type: 'eip1559', nonce: item.transaction.nonce, data: item.transaction.data, value: 0n, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    const l1Fee = values.chain === 'base' ? await estimateL1Fee(client, { ...tx, account: OWNER }) : 0n;
    // Arbitrum eth_estimateGas already accounts for the L1 posting component.
    const ceiling = gas * fees.maxFeePerGas + l1Fee * 2n;
    estimateCeiling += ceiling;
    ready.push({ item, tx, gasEstimate, l1Fee, ceiling });
  }
  const budget = values.chain === 'base' ? 80_000_000_000_000n : 200_000_000_000_000n;
  requireThat(estimateCeiling <= budget, 'Estimated fees exceed the bounded rollout budget');
  console.log(stringify({ phase: 'PREFLIGHT', chain: values.chain, remaining: ready.length, balanceETH: formatEther(balance), estimatedFeeCeilingETH: formatEther(estimateCeiling), hasFunds: balance >= estimateCeiling + (ready.length ? 1_000_000_000_000n : 0n), broadcast: values.send }));
  if (!values.send) return;
  requireThat(balance >= estimateCeiling + (ready.length ? 1_000_000_000_000n : 0n), 'Insufficient native gas balance');
  if (!ready.length) return;
  const key = env.DEPLOYER_PRIVATE_KEY?.trim();
  requireThat(!!key, 'Deployer credential is not configured');
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  requireThat(same(account.address, OWNER), 'Credential does not match approved deployer');
  for (const { item, tx, gasEstimate, l1Fee, ceiling } of ready) {
    requireThat(await client.getTransactionCount({ address: OWNER, blockTag: 'pending' }) === tx.nonce, 'Nonce changed before signing');
    const estimateNow = await client.estimateGas({ account: OWNER, data: tx.data, value: 0n });
    requireThat(estimateNow <= tx.gas, 'Gas estimate increased beyond prepared limit');
    const serializedTransaction = await account.signTransaction(tx);
    const hash = keccak256(serializedTransaction);
    const record = { contract: item.contract, address: item.predictedAddress, nonce: tx.nonce, initCodeHash: item.initCodeHash, hash, status: 'SIGNED_BROADCAST_NOT_CONFIRMED', signedAt: new Date().toISOString(), gasLimit: String(tx.gas), gasEstimate: String(gasEstimate), maxFeePerGas: String(tx.maxFeePerGas), maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas), l1FeeEstimate: String(l1Fee), estimatedFeeCeiling: String(ceiling) };
    journal.transactions.push(record);
    save(); // Persist the exact hash BEFORE any network send, including timeout ambiguity.
    const returnedHash = await client.sendRawTransaction({ serializedTransaction });
    requireThat(same(returnedHash, hash), 'RPC returned an unexpected transaction hash');
    record.status = 'BROADCAST'; save();
    console.log(stringify({ phase: 'BROADCAST', chain: values.chain, contract: item.contract, hash }));
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000, pollingInterval: 1500 });
    record.receipt = { status: receipt.status, contractAddress: receipt.contractAddress, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice), l1Fee: receipt.l1Fee === undefined ? null : String(receipt.l1Fee) };
    save();
    record.verification = await verifyDeployment(item, receipt);
    record.status = 'VERIFIED'; save();
    console.log(stringify({ phase: 'VERIFIED', chain: values.chain, contract: item.contract, address: item.predictedAddress, hash, block: record.receipt.blockNumber }));
  }
  journal.completedAt = new Date().toISOString(); save();
}

main().catch(e => {
  // Provider exception strings can contain authenticated RPC URLs. Print only
  // our controlled errors or the exception type, never message/cause/stack.
  console.error(JSON.stringify({ status: 'STOPPED', error: e instanceof RolloutError ? e.message : e.name }));
  process.exitCode = 1;
});
