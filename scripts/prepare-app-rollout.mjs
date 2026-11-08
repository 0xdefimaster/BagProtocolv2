// Read-only preparation: emits unsigned deployment data. Never loads a private key,
// creates a wallet client, signs, sends a transaction, or changes environment files.
// node scripts/prepare-app-rollout.mjs --env-file <file> --deployer <address> --out <directory>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { createPublicClient, encodeDeployData, getContractAddress, http, isAddress, keccak256 } from 'viem';

const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, deployer: { type: 'string' }, out: { type: 'string' } } });
if (!values['env-file'] || !values.out || !isAddress(values.deployer ?? '')) throw Error('Provide --env-file, --deployer (public address), and --out');
const env = parseEnv(readFileSync(resolve(values['env-file']), 'utf8'));
const deployer = values.deployer;
const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
const rpcFor = chain => env[`${chain.toUpperCase()}_RPC_URL`] || env[`RPC_URL_${chain.toUpperCase()}`] ||
  (env.ALCHEMY_API_KEY ? `https://${{ base: 'base-mainnet', arbitrum: 'arb-mainnet', robinhood: 'robinhood-mainnet' }[chain]}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` :
    { base: 'https://mainnet.base.org', arbitrum: 'https://arb1.arbitrum.io/rpc', robinhood: 'https://rpc.mainnet.chain.robinhood.com' }[chain]);
const clientFor = chain => createPublicClient({ transport: http(rpcFor(chain), { timeout: 20_000, retryCount: 0 }) });
const configured = value => isAddress(value ?? '') && !/^0x0{40}$/i.test(value);
const factoryArtifact = artifact('BagFactory');
const reference = clientFor('robinhood');
if (await reference.getChainId() !== 4663 || !configured(env.FACTORY_ADDRESS_ROBINHOOD)) throw Error('Invalid reference factory configuration');
const referenceBlock = await reference.getBlockNumber();
const names = ['owner', 'treasury', 'creationFee', 'creationFeeCap'];
const args = await Promise.all(names.map(functionName => reference.readContract({ address: env.FACTORY_ADDRESS_ROBINHOOD, abi: factoryArtifact.abi, functionName, blockNumber: referenceBlock })));
const report = { schema: 'bag-app-rollout-review/v1', createdAt: new Date().toISOString(), unsignedOnly: true, deployer,
  reference: { chainId: 4663, factory: env.FACTORY_ADDRESS_ROBINHOOD, block: referenceBlock.toString(), parameters: Object.fromEntries(names.map((n, i) => [n, String(args[i])])) },
  notes: ['Proposed factory settings copy the existing Robinhood factory; review them before signing.',
    'Nonce and predicted addresses are a snapshot. Regenerate if any deployer nonce changes.',
    'Gas estimates exclude additional L1 data fees; no final fee quote is claimed.',
    'After deployment verify bytecode and registry binding before configuring the app. These are not live deployments.'], chains: [] };
for (const [chain, chainId] of [['base', 8453], ['arbitrum', 42161]]) {
  const client = clientFor(chain);
  if (await client.getChainId() !== chainId) throw Error(`${chain}: RPC chain mismatch`);
  if (configured(env[`FACTORY_ADDRESS_${chain.toUpperCase()}`])) throw Error(`${chain}: factory already configured; inspect it before proposing a replacement`);
  const [nonce, pendingNonce, gasPrice, code] = await Promise.all([
    client.getTransactionCount({ address: deployer, blockTag: 'latest' }), client.getTransactionCount({ address: deployer, blockTag: 'pending' }),
    client.getGasPrice(), client.getCode({ address: deployer }),
  ]);
  // EIP-7702 transaction-origination rule: an EOA with exactly a delegation
  // designator may still send an ordinary creation transaction. We neither
  // set nor change that delegation. https://eips.ethereum.org/EIPS/eip-7702
  if (nonce !== pendingNonce || (code && code !== '0x' && !/^0xef0100[0-9a-fA-F]{40}$/.test(code))) throw Error(`${chain}: preparation requires an EOA without pending transactions`);
  const row = { chain, chainId, startingNonce: nonce, senderCode: code ?? '0x', gasPriceWei: gasPrice.toString(), registry: null, transactions: [] };
  const add = async (name, constructorArgs) => {
    const art = artifact(name);
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: constructorArgs });
    const txNonce = nonce + row.transactions.length;
    const address = getContractAddress({ from: deployer, nonce: BigInt(txNonce) });
    const existingCode = await client.getCode({ address });
    if (existingCode && existingCode !== '0x') throw Error(`${chain}: predicted address already contains code`);
    let gasEstimate = null;
    try { gasEstimate = (await client.estimateGas({ account: deployer, data, value: BigInt(0) })).toString(); } catch { /* no false successful simulation */ }
    row.transactions.push({ contract: name, constructorArgs: constructorArgs.map(String), predictedAddress: address, initCodeHash: keccak256(data), gasEstimate,
      transaction: { from: deployer, chainId, nonce: txNonce, data, value: '0' } });
    return address;
  };
  // This known Base deployment is checked against the local compiled registry;
  // an address in a document alone is never accepted as deployment evidence.
  const existing = env[`STRATEGY_REGISTRY_ADDRESS_${chain.toUpperCase()}`] || (chain === 'base' ? '0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920' : null);
  if (configured(existing)) {
    const deployed = await client.getCode({ address: existing });
    if (deployed?.toLowerCase() !== artifact('StrategyRegistry').deployedBytecode.toLowerCase()) throw Error(`${chain}: registry runtime mismatch`);
    row.registry = { address: existing, status: 'EXISTING_EXACT_RUNTIME_MATCH' };
  } else {
    row.registry = { address: await add('StrategyRegistry', []), status: 'PREDICTED_NOT_DEPLOYED' };
  }
  await add('BagFactory', args);
  await add('StrategyCompositions', [row.registry.address]);
  report.chains.push(row);
}
mkdirSync(resolve(values.out), { recursive: true });
const destination = join(resolve(values.out), 'unsigned-deployments.json');
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ file: destination, unsignedOnly: true, chains: report.chains.map(c => ({ chain: c.chain, transactions: c.transactions.map(t => ({ contract: t.contract, nonce: t.transaction.nonce, predictedAddress: t.predictedAddress, gasEstimate: t.gasEstimate })) })) }, null, 2));
