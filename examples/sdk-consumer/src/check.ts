// Read-only configuration, token and funding check. No Composer request and no signing.
import { readFile } from 'node:fs/promises';
import { BagSdkError, chainIdOf, getSdkErrorInfo, hashBag, isNativeToken, parseBag, validateBag, type Hex } from '@bagprotocol/sdk';
import { readTokenDecimals } from '@bagprotocol/sdk/evm';
import { resolveLifiComposerAccount } from '@bagprotocol/sdk/lifi';
import { createPublicClient, formatUnits, http } from 'viem';
import type { PlanningClient } from './purchase.js';

const tokenAbi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

async function main() {
  const [file, rawAmount, signer] = process.argv.slice(2);
  if (!file || !/^[1-9]\d*$/.test(rawAmount ?? '') || !/^0x[\da-fA-F]{40}$/.test(signer ?? '')) throw new BagSdkError('INVALID_ARGUMENT');
  const required = (name: string) => { const v = process.env[name]?.trim(); if (!v) throw new BagSdkError('INVALID_ARGUMENT'); return v; };
  const parsed = parseBag(await readFile(file, 'utf8'));
  if (!parsed.ok) throw new BagSdkError('PURCHASE_PLAN_INVALID');
  const client = createPublicClient({ transport: http(required('RPC_URL'), { retryCount: 0, timeout: 20_000 }) });
  const chainId = chainIdOf(parsed.bag.definition.chain);
  if (await client.getChainId() !== chainId) throw new BagSdkError('CHAIN_MISMATCH');
  const tokens = await readTokenDecimals(parsed.bag.definition, () => client as unknown as PlanningClient);
  if (!validateBag(parsed.bag, { tokens }).valid) throw new BagSdkError('PURCHASE_PLAN_INVALID');
  const account = await resolveLifiComposerAccount({ chainId, signer: signer as Hex, client: client as unknown as PlanningClient,
    deployment: { chainId, factory: required('COMPOSER_FACTORY') as Hex, factoryCodeHash: required('COMPOSER_FACTORY_CODE_HASH') as Hex } });
  const token = required('INPUT_TOKEN') as Hex;
  if (!/^0x[\da-fA-F]{40}$/.test(token)) throw new BagSdkError('INVALID_ARGUMENT');
  const nativeBalance = await client.getBalance({ address: signer as Hex });
  const native = isNativeToken(token);
  const decimals = native ? 18 : await client.readContract({ address: token, abi: tokenAbi, functionName: 'decimals' });
  const balance = native ? nativeBalance : await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [signer as Hex] });
  const fundingAvailable = balance >= BigInt(rawAmount) && nativeBalance > (native ? BigInt(rawAmount) : 0n);
  console.log(JSON.stringify({ status: fundingAvailable ? 'READ_ONLY_CHECKS_PASS' : 'NEEDS_FUNDING', chainId,
    definitionHash: hashBag(parsed.bag), tokenDecimalsChecked: true, deploymentPinChecked: true, signer,
    input: { token, decimals, amountRaw: rawAmount, amount: formatUnits(BigInt(rawAmount), decimals), balanceRaw: String(balance), balance: formatUnits(balance, decimals) },
    nativeBalanceETH: formatUnits(nativeBalance, 18), gasSufficiency: 'NOT_ESTIMATED',
    apiKeyConfigured: Boolean(process.env.LIFI_API_KEY?.trim()), deliveryProofEnabled: process.env.DELIVERY_PROOF === '1',
    receiptEvidenceMode: process.env.RECEIPT_EVIDENCE_MODE || 'NOT_SET', accountVerified: Boolean(account.trust),
    provenance: 'NOT_CHECKED', applicationAccounting: 'NOT_BAG_ACCOUNTED', signedOrSubmitted: false }, null, 2));
  if (!fundingAvailable) process.exitCode = 4;
}
main().catch(error => { console.error(JSON.stringify(getSdkErrorInfo(error))); process.exitCode = 1; });
