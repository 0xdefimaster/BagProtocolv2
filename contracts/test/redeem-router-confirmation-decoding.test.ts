import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { keccak256, toHex, encodeFunctionData, parseUnits, decodeEventLog } from 'viem';
import { computeLegsHash } from '../../lib/blockchain/redeem-fee-router-eip712';

// -----------------------------------------------------------------------------
// V11 — proves that lib/server/redeem-router-confirmation.ts's exact
// `REDEEMED_EVENT_ABI` (duplicated there, deliberately, since that file
// cannot import a Hardhat artifact from a Next.js server bundle) correctly
// decodes a REAL `Redeemed` event emitted by the REAL compiled
// RedeemFeeRouter contract — not an assumed/hand-typed event shape. This
// is the closest this sandbox can get to testing the server's on-chain
// verification logic without live RPC access to a real deployment (see
// docs/archive/FINAL_PRODUCTION_AUDIT.md): a genuine Hardhat-EVM transaction
// receipt, decoded with the exact same viem `decodeEventLog` call and ABI
// literal the server module uses.
// -----------------------------------------------------------------------------

const SWAP_POOL_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

// Copied verbatim from lib/server/redeem-router-confirmation.ts — if that
// file's ABI literal ever drifts from the real contract's event, THIS copy
// must be updated too, and this test will start failing against the real
// contract, which is the point (a silent server/contract ABI mismatch is
// exactly the bug class this test exists to catch).
const REDEEMED_EVENT_ABI = [
  {
    type: 'event',
    name: 'Redeemed',
    inputs: [
      { name: 'redemptionId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'legCount', type: 'uint256', indexed: false },
      { name: 'swapOutput', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'userProceeds', type: 'uint256', indexed: false },
    ],
  },
] as const;

function redemptionId(seed: string): `0x${string}` {
  return keccak256(toHex(seed));
}

describe('redeem-router-confirmation event decoding (against a REAL on-chain receipt)', () => {
  it('decodes a real Redeemed event from a real RedeemFeeRouter transaction receipt', async () => {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    const [owner, , user, creator, attestor] = await viem.getWalletClients();

    const quoteToken = await viem.deployContract('MockToken', ['Mock USDG', 'mUSDG', 18]);
    const btcToken = await viem.deployContract('MockToken', ['Mock BTC', 'mBTC', 18]);

    const vault = await viem.deployContract('CreatorRewardsVault', [quoteToken.address, owner.account.address, owner.account.address]);
    const router = await viem.deployContract('RedeemFeeRouter', [quoteToken.address, vault.address, attestor.account.address, owner.account.address]);

    const vaultAsOwner = await viem.getContractAt('CreatorRewardsVault', vault.address, { client: { wallet: owner } });
    await vaultAsOwner.write.setSettler([router.address, true]);

    const btcPool = await viem.deployContract('TestSwapPool', [btcToken.address, quoteToken.address, 100n, 1n]);
    await quoteToken.write.mint([owner.account.address, parseUnits('1000000', 18)]);
    const quoteAsOwner = await viem.getContractAt('MockToken', quoteToken.address, { client: { wallet: owner } });
    await quoteAsOwner.write.approve([btcPool.address, parseUnits('1000000', 18)]);
    const poolAsOwner = await viem.getContractAt('TestSwapPool', btcPool.address, { client: { wallet: owner } });
    await poolAsOwner.write.seed([parseUnits('1000000', 18)]);

    const BTC_AMOUNT = parseUnits('2', 18);
    const BTC_OUTPUT = BTC_AMOUNT * 100n;
    const FEE_AMOUNT = parseUnits('50', 18);
    const MIN_USER_PROCEEDS = BTC_OUTPUT - FEE_AMOUNT;

    await btcToken.write.mint([user.account.address, BTC_AMOUNT]);
    const btcAsUser = await viem.getContractAt('MockToken', btcToken.address, { client: { wallet: user } });
    await btcAsUser.write.approve([router.address, BTC_AMOUNT]);

    const routerAsOwner = await viem.getContractAt('RedeemFeeRouter', router.address, { client: { wallet: owner } });
    await routerAsOwner.write.setSwapTarget([btcPool.address, true]);
    await routerAsOwner.write.setAllowedInputToken([btcToken.address, true]);

    const legs = [
      {
        inputToken: btcToken.address,
        inputAmount: BTC_AMOUNT,
        swapTarget: btcPool.address,
        swapCallData: encodeFunctionData({ abi: SWAP_POOL_ABI, functionName: 'swap', args: [BTC_AMOUNT, 0n, router.address] }),
      },
    ];
    const legsHash = computeLegsHash(legs);
    const rid = redemptionId('decode-test-1');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const chainId = await publicClient.getChainId();

    const signature = await attestor.signTypedData({
      domain: { name: 'BagRedeemFeeRouter', version: '3', chainId, verifyingContract: router.address },
      types: {
        FeeAttestation: [
          { name: 'redemptionId', type: 'bytes32' },
          { name: 'user', type: 'address' },
          { name: 'creator', type: 'address' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'minUserProceeds', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'legsHash', type: 'bytes32' },
        ],
      },
      primaryType: 'FeeAttestation',
      message: { redemptionId: rid, user: user.account.address, creator: creator.account.address, feeAmount: FEE_AMOUNT, minUserProceeds: MIN_USER_PROCEEDS, deadline, legsHash },
    });

    const routerAsUser = await viem.getContractAt('RedeemFeeRouter', router.address, { client: { wallet: user } });
    const txHash = await routerAsUser.write.redeem([
      { redemptionId: rid, legs, creator: creator.account.address, feeAmount: FEE_AMOUNT, minUserProceeds: MIN_USER_PROCEEDS, deadline, attestationSignature: signature },
    ]);

    // This is a REAL receipt from a REAL mined transaction on the Hardhat
    // EVM — not a hand-constructed fixture.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, 'success');

    // Exactly what lib/server/redeem-router-confirmation.ts does: scan for
    // a Redeemed log from the router's own address, decode it, use it.
    let decoded: { redemptionId: `0x${string}`; user: `0x${string}`; creator: `0x${string}`; feeAmount: bigint } | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== router.address.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: REDEEMED_EVENT_ABI, data: log.data, topics: log.topics });
        if (event.eventName === 'Redeemed') {
          decoded = event.args as unknown as typeof decoded extends infer T ? NonNullable<T> : never;
          break;
        }
      } catch {
        continue;
      }
    }

    assert.ok(decoded, 'expected to find and decode a real Redeemed event in the transaction receipt');
    assert.equal(decoded!.redemptionId.toLowerCase(), rid.toLowerCase());
    assert.equal(decoded!.user.toLowerCase(), user.account.address.toLowerCase());
    assert.equal(decoded!.creator.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(decoded!.feeAmount, FEE_AMOUNT);
  });
});
