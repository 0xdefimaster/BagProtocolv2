/**
 * Deploys contracts/RedeemSettlement.sol to Robinhood Chain (4663), Base (8453) or Arbitrum (42161), then reads it back
 * and checks every value. The settlement token is the chain's (lib/config/settlement.ts): USDG on Robinhood Chain,
 * Circle USDC on Base and Arbitrum.
 * Runbook: docs/REDEEM_SETTLEMENT_DEPLOYMENT.md (Base: docs/chains/BASE_FEE_SETTLEMENT.md).
 *
 *   npx hardhat compile
 *   npx tsx scripts/deploy-redeem-settlement.ts                              # Robinhood Chain: deploy + verify
 *   npx tsx scripts/deploy-redeem-settlement.ts --chain=base                 # Base: deploy + verify
 *   npx tsx scripts/deploy-redeem-settlement.ts --chain=arbitrum             # Arbitrum: deploy + verify
 *   npx tsx scripts/deploy-redeem-settlement.ts [--chain=base] --verify 0x…  # verify an existing deployment (no key needed)
 *
 * Deploy refuses unless ALL are set (on your own machine, in .env.local, never committed):
 *   REDEEM_SETTLEMENT_DEPLOYER_PRIVATE_KEY   one-off key with a little ETH for gas; never printed or written
 *   REDEEM_SETTLEMENT_OWNER_ADDRESS          admin (setAttestor / setOwner) — an address, never a key
 *   REDEEM_SETTLEMENT_ATTESTOR_ADDRESS       the backend signer's ADDRESS — never its key
 *   REDEEM_SETTLEMENT_DEPLOY_CONFIRM         must equal I_UNDERSTAND_THIS_DEPLOYS_TO_ROBINHOOD_CHAIN
 *                                            (Base: I_UNDERSTAND_THIS_DEPLOYS_TO_BASE,
 *                                             Arbitrum: I_UNDERSTAND_THIS_DEPLOYS_TO_ARBITRUM)
 * Owner and attestor go straight into the constructor: the deployer keeps no power after the deploy.
 * Operational guards (not contract rules): deployer, owner and attestor must be three different addresses, and both
 * must be accounts (an EOA, or an EOA with an EIP-7702 delegation such as a MetaMask smart account). A contract owner
 * (a Safe) needs REDEEM_SETTLEMENT_OWNER_IS_CONTRACT=yes; a contract attestor is always refused (it cannot sign), and
 * an attestor with an EIP-7702 delegation needs REDEEM_SETTLEMENT_ATTESTOR_ALLOW_7702=yes (it should be a plain EOA).
 *
 * --verify also accepts REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY (the server secret) when it is in the environment: it
 * then checks that the key the backend will sign with belongs to the on-chain attestor. Only the match is printed.
 *
 * Writes no files. Prints addresses and transaction hashes only; never a key or the RPC URL.
 * Env: the chain's RPC (ROBINHOOD_RPC_URL / BASE_RPC_URL / ARBITRUM_RPC_URL, or ALCHEMY_API_KEY; never printed).
 */
import './load-env';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD_RPC_URL } from '../lib/config/robinhood-chain';
import { BAG_CHAINS, isBagChain, type BagChain } from '../lib/config/chains';
import { settlementTokenFor } from '../lib/config/settlement';
import { resolveRpcEndpoints } from '../lib/blockchain/rpc/endpoints';
import { redactRpcUrl } from '../lib/domain/basket-protocol/redeem/fee-router-executability';
import { accountKind, accountKindProblems, validateSettlementDeployConfig, verifySettlementDeployment, type DeploymentCheck } from '../lib/blockchain/redeem-settlement-deploy';

function refuse(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

const chainArg = process.argv.find((a) => a.startsWith('--chain='))?.slice('--chain='.length) ?? 'robinhood';
if (!isBagChain(chainArg) || !settlementTokenFor(chainArg)) refuse(`--chain=${chainArg}: fee settlement is supported on robinhood, base and arbitrum only.`);
const target: BagChain = chainArg;
const TOKEN = settlementTokenFor(target)!;
const CHAIN_ID = BAG_CHAINS[target].chainId;
const CONFIRM_PHRASE = target === 'robinhood' ? 'I_UNDERSTAND_THIS_DEPLOYS_TO_ROBINHOOD_CHAIN' : `I_UNDERSTAND_THIS_DEPLOYS_TO_${target.toUpperCase()}`;

function envAddress(name: string): `0x${string}` {
  const v = process.env[name];
  if (!v) refuse(`set ${name}.`);
  if (!isAddress(v, { strict: false })) refuse(`${name} is not an address.`);
  return getAddress(v);
}

function printChecks(checks: DeploymentCheck[]): boolean {
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.actual}${c.ok ? '' : ` (expected ${c.expected})`}`);
  return checks.every((c) => c.ok);
}

const rpcUrl = target === 'robinhood' ? ROBINHOOD_RPC_URL : resolveRpcEndpoints(target)[0]?.url ?? refuse(`no RPC for ${target} (${target.toUpperCase()}_RPC_URL or ALCHEMY_API_KEY).`);
const chain = defineChain({
  id: CHAIN_ID,
  name: BAG_CHAINS[target].viemChain.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

async function connectedChainId(pub: PublicClient): Promise<number> {
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) refuse(`WRONG_CHAIN: ${redactRpcUrl(rpcUrl)} reports ${chainId}, expected ${CHAIN_ID}.`);
  return chainId;
}

async function verify(pub: PublicClient, address: `0x${string}`, owner: `0x${string}`, attestor: `0x${string}`): Promise<boolean> {
  const checks = await verifySettlementDeployment(pub, address, {
    chainId: CHAIN_ID,
    usdg: TOKEN.address,
    owner,
    attestor,
    allowContractOwner: process.env.REDEEM_SETTLEMENT_OWNER_IS_CONTRACT === 'yes',
    allow7702Attestor: process.env.REDEEM_SETTLEMENT_ATTESTOR_ALLOW_7702 === 'yes',
  });
  let ok = printChecks(checks);
  const serverKey = process.env.REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY as Hex | undefined;
  if (serverKey) {
    const signer = privateKeyToAccount(serverKey).address;
    const matches = signer.toLowerCase() === attestor.toLowerCase();
    console.log(`${matches ? 'OK  ' : 'FAIL'} backend signing key belongs to the attestor: ${matches ? 'yes' : `no (key is for ${signer})`}`);
    ok = ok && matches;
  } else {
    console.log('SKIP backend signing key check (REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY not in this environment)');
  }
  return ok;
}

async function main() {
  const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const owner = envAddress('REDEEM_SETTLEMENT_OWNER_ADDRESS');
  const attestor = envAddress('REDEEM_SETTLEMENT_ATTESTOR_ADDRESS');

  const verifyIdx = process.argv.indexOf('--verify');
  if (verifyIdx !== -1) {
    const target = process.argv[verifyIdx + 1];
    if (!target || !isAddress(target, { strict: false })) refuse('--verify needs the deployed RedeemSettlement address.');
    await connectedChainId(pub);
    const ok = await verify(pub, getAddress(target), owner, attestor);
    console.log(ok ? 'VERIFIED' : 'NOT VERIFIED');
    process.exit(ok ? 0 : 1);
  }

  const key = process.env.REDEEM_SETTLEMENT_DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!key) refuse('set REDEEM_SETTLEMENT_DEPLOYER_PRIVATE_KEY (a one-off deploy key).');
  if (process.env.REDEEM_SETTLEMENT_DEPLOY_CONFIRM !== CONFIRM_PHRASE) refuse(`set REDEEM_SETTLEMENT_DEPLOY_CONFIRM=${CONFIRM_PHRASE}.`);
  const account = privateKeyToAccount(key);

  const chainId = await connectedChainId(pub);
  const problems = validateSettlementDeployConfig({
    chainId,
    expectedChainId: CHAIN_ID,
    usdg: TOKEN.address,
    deployer: account.address,
    owner,
    attestor,
  });
  if (problems.length > 0) refuse(problems.join('; '));
  const kinds = { owner: await accountKind(pub, owner), attestor: await accountKind(pub, attestor) };
  const kindProblems = accountKindProblems(
    kinds,
    process.env.REDEEM_SETTLEMENT_OWNER_IS_CONTRACT === 'yes',
    process.env.REDEEM_SETTLEMENT_ATTESTOR_ALLOW_7702 === 'yes'
  );
  if (kindProblems.length > 0) refuse(kindProblems.join('; '));

  // The settlement token must be the real stablecoin here: it is immutable in the contract.
  const usdgCode = await pub.getCode({ address: TOKEN.address });
  if (!usdgCode || usdgCode === '0x') refuse(`no contract at ${TOKEN.symbol} ${TOKEN.address}.`);
  const decimals = await pub.readContract({
    address: TOKEN.address,
    abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const,
    functionName: 'decimals',
  });
  if (decimals !== TOKEN.decimals) refuse(`${TOKEN.symbol} reports ${decimals} decimals, expected ${TOKEN.decimals}.`);
  if ((await pub.getBalance({ address: account.address })) === BigInt(0)) refuse(`deployer ${account.address} has no ETH for gas.`);

  const artifactPath = resolve(process.cwd(), 'artifacts/contracts/RedeemSettlement.sol/RedeemSettlement.json');
  let artifact: { abi: unknown[]; bytecode: Hex };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    refuse('artifact missing: run `npx hardhat compile` first.');
  }

  console.log(`${target} · deployer ${account.address} · owner ${owner} · attestor ${attestor} · ${TOKEN.symbol} ${TOKEN.address}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [TOKEN.address, attestor, owner] });
  console.log(`deploy tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error(`DEPLOY_FAILED: ${hash}`);
    process.exit(1);
  }
  console.log(`RedeemSettlement: ${receipt.contractAddress} (block ${receipt.blockNumber})`);

  const ok = await verify(pub, receipt.contractAddress, owner, attestor);
  if (!ok) {
    console.error('NOT VERIFIED — do not configure this address anywhere.');
    process.exit(1);
  }
  console.log('VERIFIED');
  if (target === 'robinhood') {
    console.log('Next (only when ready for the live test): set REDEEM_SETTLEMENT_ADDRESS and NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS');
    console.log('to this address and REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY as a server secret. Then remove the deployer key.');
  } else {
    console.log(`Next (only when ready for the live test): set REDEEM_SETTLEMENT_ADDRESS_${target.toUpperCase()} to this address.`);
    console.log('The attestor key (REDEEM_SETTLEMENT_ATTESTOR_PRIVATE_KEY) is shared; the EIP-712 domain binds each signature to its chain.');
    console.log('Then redeploy the site and remove the deployer key.');
  }
}

main().catch((e) => {
  console.error((e as Error).message.split(rpcUrl).join(redactRpcUrl(rpcUrl)).split('\n')[0]);
  process.exit(2);
});
