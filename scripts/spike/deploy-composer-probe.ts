/**
 * P1 — deploy contracts/spike/ComposerSettlementProbe.sol to Robinhood Chain (4663). SPIKE ONLY.
 * The probe holds nothing and forwards every token to the recipient in the same call; deploying it costs gas only.
 *
 *   npx hardhat compile        # produces artifacts/contracts/spike/ComposerSettlementProbe.sol/…
 *   npx tsx scripts/spike/deploy-composer-probe.ts
 *
 * Refuses unless ALL are set (on your own machine, in .env.local, never committed):
 *   PROBE_PRIVATE_KEY   disposable key with a little ETH for gas (env only; never printed or written)
 *   PROBE_CONFIRM       must equal I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS
 * Env: ROBINHOOD_RPC_URL / RPC_URL_ROBINHOOD (optional; never printed).
 */
import '../load-env';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, ROBINHOOD_RPC_URL } from '../../lib/config/robinhood-chain';
import { redactRpcUrl } from '../../lib/domain/basket-protocol/redeem/fee-router-executability';

const CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS';

async function main() {
  const key = process.env.PROBE_PRIVATE_KEY as Hex | undefined;
  if (!key || process.env.PROBE_CONFIRM !== CONFIRM_PHRASE) {
    console.error(`REFUSED: set PROBE_PRIVATE_KEY (disposable) and PROBE_CONFIRM=${CONFIRM_PHRASE}.`);
    process.exit(2);
  }
  const artifactPath = resolve(process.cwd(), 'artifacts/contracts/spike/ComposerSettlementProbe.sol/ComposerSettlementProbe.json');
  let artifact: { abi: unknown[]; bytecode: Hex };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    console.error('Artifact missing: run `npx hardhat compile` first.');
    process.exit(2);
  }

  const rpcUrl = ROBINHOOD_RPC_URL;
  const chain = defineChain({ id: ROBINHOOD_CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    console.error(`WRONG_CHAIN: ${redactRpcUrl(rpcUrl)} reports ${chainId}, expected ${ROBINHOOD_CHAIN_ID}.`);
    process.exit(2);
  }
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [ROBINHOOD_REWARD_TOKEN.address] });
  console.log(`deploy tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error(`DEPLOY_FAILED: ${hash}`);
    process.exit(1);
  }
  const token = await pub.readContract({
    address: receipt.contractAddress,
    abi: [{ type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const,
    functionName: 'token',
  });
  console.log(`ComposerSettlementProbe: ${receipt.contractAddress} (block ${receipt.blockNumber}, deployer ${account.address}, token ${token})`);
  console.log(`Next: npx tsx scripts/spike/composer-settlement-probe.ts --signer ${account.address} --probe ${receipt.contractAddress}`);
}

main().catch((e) => {
  console.error((e as Error).message.split(ROBINHOOD_RPC_URL).join(redactRpcUrl(ROBINHOOD_RPC_URL)).split('\n')[0]);
  process.exit(2);
});
