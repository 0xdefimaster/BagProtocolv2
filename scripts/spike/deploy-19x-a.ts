/**
 * PHASE 19.X-A — deploy + execute the composability spike on
 * Robinhood Chain Testnet (chain id 46630).
 *
 * WHY THIS SCRIPT EXISTS AND HASN'T BEEN RUN YET:
 * The sandbox that wrote this file has no network egress to
 * rpc.testnet.chain.robinhood.com (or any RPC endpoint) — only npm/PyPI/
 * GitHub registries are reachable there. `contracts/test/spike/
 * BagRouterSpike.test.ts` proves the atomicity/revert/fund-safety logic on
 * Hardhat's in-memory EVM, which is a genuine but *local* proof. This
 * script is what actually produces STEP 9's required testnet evidence
 * (deployed addresses, tx hash, chain id, block number) — but only once
 * *you* run it from a machine that can reach the testnet RPC.
 *
 * PREREQUISITES (fill in .env.local, do not commit):
 *   SPIKE_DEPLOYER_PRIVATE_KEY=0x...   a throwaway testnet-only key
 *   SPIKE_RPC_URL=https://rpc.testnet.chain.robinhood.com   (or your own
 *                                                             provider's
 *                                                             46630 endpoint)
 * Fund that address first from https://faucet.testnet.chain.robinhood.com
 * (0.1 test ETH/day per the public faucet). This never touches real funds —
 * testnet ETH has no value — but keep the private key testnet-only anyway.
 *
 * RUN:
 *   npx tsx scripts/spike/deploy-19x-a.ts
 *
 * WHAT IT DOES:
 *   1. Deploys MockToken x3 (SIN/SMID/SOUT), TestSwapPool x2, BagRouterSpike
 *   2. Seeds both pools
 *   3. Mints the deployer some SIN and runs executeComposed() through the
 *      router — one wallet signature, one transaction
 *   4. Prints every address + the tx hash + block number, and appends them
 *      to scripts/spike/19x-a-results.json so the Phase 19.X-A report can
 *      cite real testnet evidence instead of the local-only test run.
 *
 * This script does NOT touch LI.FI or mainnet in any way — that's Phase
 * 19.X-B, a separate script, gated on this one's results being reviewed.
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Minimal artifacts inlined here (rather than importing Hardhat's
// build-info JSON) so this script has no dependency on a prior
// `hardhat compile` having produced artifacts in this exact shape. If you
// already have contracts/artifacts/*, feel free to import those ABIs/
// bytecode instead — this is just the zero-assumption path.
import MockTokenArtifact from '../../artifacts/contracts/spike/MockToken.sol/MockToken.json' assert { type: 'json' };
import TestSwapPoolArtifact from '../../artifacts/contracts/spike/TestSwapPool.sol/TestSwapPool.json' assert { type: 'json' };
import BagRouterSpikeArtifact from '../../artifacts/contracts/spike/BagRouterSpike.sol/BagRouterSpike.json' assert {
  type: 'json',
};

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env.local (see the header comment in this file) before running the spike.`,
    );
  }
  return value;
}

async function main() {
  const rpcUrl = requireEnv('SPIKE_RPC_URL');
  const privateKey = requireEnv('SPIKE_DEPLOYER_PRIVATE_KEY') as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  const chain = {
    id: ROBINHOOD_TESTNET_CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(
      `SPIKE_RPC_URL reports chain id ${actualChainId}, expected ${ROBINHOOD_TESTNET_CHAIN_ID}. ` +
        `Refusing to proceed — STEP 9 requires we know exactly which chain we're on.`,
    );
  }

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer ${account.address} — balance ${formatUnits(balance, 18)} ETH on chain ${actualChainId}`);
  if (balance === 0n) {
    throw new Error(`Deployer has 0 ETH. Fund it from https://faucet.testnet.chain.robinhood.com first.`);
  }

  async function deploy(artifact: { abi: unknown; bytecode: string }, args: unknown[] = []) {
    const hash = await walletClient.deployContract({
      abi: artifact.abi as any,
      bytecode: artifact.bytecode as `0x${string}`,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`Deployment tx ${hash} produced no contractAddress`);
    return { address: receipt.contractAddress, deployTxHash: hash, blockNumber: receipt.blockNumber };
  }

  console.log('Deploying tokens...');
  const tokenIn = await deploy(MockTokenArtifact, ['Spike In', 'SIN', 18]);
  const tokenMid = await deploy(MockTokenArtifact, ['Spike Mid', 'SMID', 18]);
  const tokenOut = await deploy(MockTokenArtifact, ['Spike Out', 'SOUT', 18]);

  console.log('Deploying pools...');
  const poolA = await deploy(TestSwapPoolArtifact, [tokenIn.address, tokenMid.address, 2n, 1n]);
  const poolB = await deploy(TestSwapPoolArtifact, [tokenMid.address, tokenOut.address, 1n, 1n]);

  console.log('Deploying BagRouterSpike...');
  const router = await deploy(BagRouterSpikeArtifact);

  async function write(address: `0x${string}`, abi: unknown, functionName: string, args: unknown[]) {
    const hash = await walletClient.writeContract({ address, abi: abi as any, functionName, args });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  console.log('Seeding pools...');
  const seedMid = parseUnits('1000', 18);
  const seedOut = parseUnits('1000', 18);
  await write(tokenMid.address, MockTokenArtifact.abi, 'mint', [account.address, seedMid]);
  await write(tokenMid.address, MockTokenArtifact.abi, 'approve', [poolA.address, seedMid]);
  await write(poolA.address, TestSwapPoolArtifact.abi, 'seed', [seedMid]);

  await write(tokenOut.address, MockTokenArtifact.abi, 'mint', [account.address, seedOut]);
  await write(tokenOut.address, MockTokenArtifact.abi, 'approve', [poolB.address, seedOut]);
  await write(poolB.address, TestSwapPoolArtifact.abi, 'seed', [seedOut]);

  console.log('Minting spike input + approving router (this is the pre-approval, see one-signature note below)...');
  const amountIn = parseUnits('10', 18);
  await write(tokenIn.address, MockTokenArtifact.abi, 'mint', [account.address, amountIn]);
  const approveTxReceipt = await write(tokenIn.address, MockTokenArtifact.abi, 'approve', [router.address, amountIn]);

  const expectedMid = amountIn * 2n;
  const expectedOut = expectedMid;

  const legA = {
    target: poolA.address,
    callData: encodeFunctionData({
      abi: TestSwapPoolArtifact.abi as any,
      functionName: 'swap',
      args: [amountIn, expectedMid, router.address],
    }),
    value: 0n,
    approveToken: tokenIn.address,
    approveAmount: amountIn,
  };
  const legB = {
    target: poolB.address,
    callData: encodeFunctionData({
      abi: TestSwapPoolArtifact.abi as any,
      functionName: 'swap',
      args: [expectedMid, expectedOut, router.address],
    }),
    value: 0n,
    approveToken: tokenMid.address,
    approveAmount: expectedMid,
  };

  console.log('Submitting the ONE composed transaction (executeComposed)...');
  const composedHash = await walletClient.writeContract({
    address: router.address,
    abi: BagRouterSpikeArtifact.abi as any,
    functionName: 'executeComposed',
    args: [tokenIn.address, amountIn, legA, legB, tokenOut.address, expectedOut],
  });
  const composedReceipt = await publicClient.waitForTransactionReceipt({ hash: composedHash });

  const userOutBalance = await publicClient.readContract({
    address: tokenOut.address,
    abi: MockTokenArtifact.abi as any,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const results = {
    chainId: actualChainId,
    deployer: account.address,
    contracts: { tokenIn, tokenMid, tokenOut, poolA, poolB, router },
    approveTxHash: approveTxReceipt.transactionHash,
    approveBlockNumber: approveTxReceipt.blockNumber.toString(),
    composedTxHash: composedHash,
    composedBlockNumber: composedReceipt.blockNumber.toString(),
    composedStatus: composedReceipt.status,
    resultingOutputBalance: (userOutBalance as bigint).toString(),
    oneSignatureResult:
      'NO — a prior approve() transaction (see approveTxHash) was required before executeComposed(). ' +
      'This spike does not implement Permit2/EIP-2612; see the Phase 19.X-A report for the analysis of ' +
      'whether it could.',
    note: 'Both legs here are BAG-controlled TestSwapPool instances, not any third-party or LI.FI route. See Phase 19.X-B for the LI.FI leg, which is separately gated and untouched by this script.',
  };

  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '19x-a-results.json');
  writeFileSync(outPath, JSON.stringify(results, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  console.log('\n=== PHASE 19.X-A RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nWritten to ${outPath}`);
  console.log(`Explorer: https://explorer.testnet.chain.robinhood.com/tx/${composedHash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
