import { readFile, writeFile } from 'node:fs/promises';
import { BagSdkError, getSdkErrorInfo, type Hex } from '@bagprotocol/sdk';
import { withReceiptEvidence, type ReceiptEvidenceOptions } from '@bagprotocol/sdk/evm';
import { createPublicClient, http } from 'viem';
import { createIntent, preparePurchase, restoreIntent, verifySubmitted, type PlanningClient } from './purchase.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BagSdkError('INVALID_ARGUMENT', 'Missing required environment configuration.');
  return value;
}
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const client = createPublicClient({ transport: http(required('RPC_URL'), { retryCount: 0, timeout: 30_000 }) });
  if (command === 'prepare') {
    const [file, inputToken, amountRaw, signer, minimaFile, output] = args;
    if (!file || !inputToken || !amountRaw || !signer || !minimaFile || !output) throw new BagSdkError('INVALID_ARGUMENT');
    const registryAddress = process.env.STRATEGY_REGISTRY;
    const expectedCreator = process.env.EXPECTED_CREATOR;
    if (Boolean(registryAddress) !== Boolean(expectedCreator)) throw new BagSdkError('INVALID_ARGUMENT');
    const result = await preparePurchase({ bagText: await readFile(file, 'utf8'), inputToken: inputToken as Hex, amountRaw: BigInt(amountRaw), signer: signer as Hex,
      client: client as unknown as PlanningClient, apiKey: required('LIFI_API_KEY'), composerUrl: process.env.COMPOSER_URL ?? 'https://composer.li.quest',
      deployment: { chainId: await client.getChainId(), factory: required('COMPOSER_FACTORY') as Hex, factoryCodeHash: required('COMPOSER_FACTORY_CODE_HASH') as Hex },
      registry: registryAddress && expectedCreator ? { address: registryAddress as Hex, expectedCreator: expectedCreator as Hex } : undefined });
    if (result.simulation.status !== 'OK' && result.simulation.status !== 'NEEDS_APPROVAL') throw new BagSdkError('INVALID_ARGUMENT', 'Simulation is not ready.');
    const minima = JSON.parse(await readFile(minimaFile, 'utf8')) as { token: Hex; amountRaw: string }[];
    const snapshot = createIntent(result.compiled, minima.map(item => ({ token: item.token, amountRaw: BigInt(item.amountRaw) })));
    await writeFile(output, snapshot.text, { flag: 'wx' });
    console.log(json({ status: 'UNSIGNED_INTENT_SAVED', intentHash: snapshot.integrityHash, simulation: result.simulation,
      registryVerification: result.provenance ? 'VERIFIED' : 'NOT_REQUESTED', warningCount: result.compiled.quote.warnings.length }));
    return;
  }
  if (command === 'verify') {
    const [file, trustedHash, transactionHash] = args;
    if (!file || !trustedHash || !transactionHash) throw new BagSdkError('INVALID_ARGUMENT');
    const text = await readFile(file, 'utf8');
    restoreIntent(text, trustedHash as Hex);
    const mode = process.env.RECEIPT_EVIDENCE_MODE ?? 'SINGLE_TRANSACTION_BLOCK';
    if (!['SINGLE_TRANSACTION_BLOCK', 'GETH_TRANSACTION_INDEX', 'ROBINHOOD_NITRO_TRANSACTION_INDEX'].includes(mode)) throw new BagSdkError('INVALID_ARGUMENT');
    const evidence = withReceiptEvidence(client, { balanceState: mode as ReceiptEvidenceOptions['balanceState'] });
    const result = await verifySubmitted({ snapshotText: text, trustedIntentHash: trustedHash as Hex, transactionHash: transactionHash as Hex, client: evidence });
    console.log(json(result));
    if (result.status !== 'VERIFIED') process.exitCode = 1;
    return;
  }
  throw new BagSdkError('INVALID_ARGUMENT', 'Use prepare or verify; see README.');
}
main().catch(error => { console.error(json(getSdkErrorInfo(error))); process.exitCode = 1; });
