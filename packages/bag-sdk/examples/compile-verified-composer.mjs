// Build the SDK, then run with the caller's LIFI_API_KEY, RPC_URL,
// COMPOSER_FACTORY and COMPOSER_FACTORY_CODE_HASH. No signing or submission.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { chainIdOf, compileBag, getSdkErrorInfo, isNativeToken, parseBag, simulateBag } from '../dist/index.js';
import { readTokenDecimals } from '../dist/adapters/evm.js';
import { lifiComposer, resolveLifiComposerAccount } from '../dist/adapters/lifi.js';

async function main() {
  const [file, inputToken, amountRaw, signer] = process.argv.slice(2);
  const { LIFI_API_KEY: apiKey, RPC_URL: rpcUrl, COMPOSER_FACTORY: factory, COMPOSER_FACTORY_CODE_HASH: factoryCodeHash, COMPOSER_URL: baseUrl } = process.env;
  if (!file || !inputToken || !amountRaw || !signer || !apiKey || !rpcUrl || !factory || !factoryCodeHash) {
    console.error('Set LIFI_API_KEY, RPC_URL, COMPOSER_FACTORY and COMPOSER_FACTORY_CODE_HASH; run node packages/bag-sdk/examples/compile-verified-composer.mjs <bag.json> <inputToken> <amountRaw> <signer>');
    process.exitCode = 2; return;
  }
  try {
    const parsed = parseBag(readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error('Invalid bag.json');
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30000, retryCount: 0 }) });
    const chainId = chainIdOf(parsed.bag.definition.chain);
    const account = await resolveLifiComposerAccount({ chainId, signer, client, deployment: { chainId, factory, factoryCodeHash } });
    const tokens = await readTokenDecimals(parsed.bag.definition, () => client);
    const inputTokenDecimals = isNativeToken(inputToken) ? 18 : Number(await client.readContract({ address: inputToken,
      abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' }));
    const compiled = await compileBag(parsed.bag, { inputToken, amountRaw: BigInt(amountRaw), signer, inputTokenDecimals, tokens }, {
      provider: lifiComposer({ apiKey, baseUrl: baseUrl ?? 'https://composer.li.quest', account }), trust: account.trust,
    });
    const simulation = await simulateBag(compiled, { client });
    console.log(JSON.stringify({ status: 'UNSIGNED_COMPILED_PURCHASE',
      account: { proxy: account.proxy, proxyDeployed: account.proxyDeployed, factory: account.factory, blockNumber: account.blockNumber },
      transaction: compiled.transaction, approvals: compiled.approvals, quote: compiled.quote, simulation,
    }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch (error) {
    // Fixed summaries never echo an upstream URL, credential, stack or abort reason.
    console.error(JSON.stringify({ status: 'COMPILE_NOT_COMPLETED', ...getSdkErrorInfo(error) }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
