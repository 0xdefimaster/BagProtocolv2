import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { network } from 'hardhat';
import { type Address, type Hex } from 'viem';

// -----------------------------------------------------------------------------
// CONTRACT TESTS (Hardhat in-process EVM) for contracts/settlement/BasketTypes.sol
// against the shared vectors (contracts/test/vectors/basket-settlement-v1.json),
// which lib/domain/settlement/__tests__/basket-types.test.ts checks off-chain.
// Same inputs, same hashes, same split on both sides. NOT real-chain tests.
// -----------------------------------------------------------------------------

const vectors = JSON.parse(readFileSync(new URL('./vectors/basket-settlement-v1.json', import.meta.url), 'utf8'));
const big = (v: string | number) => BigInt(v);
const router = vectors.domains[0].router as Address;

const intentArg = (i: Record<string, string | number>) => ({
  payer: i.payer as Address, recipient: i.recipient as Address, strategyId: i.strategyId as Hex, strategyVersion: Number(i.strategyVersion),
  definitionHash: i.definitionHash as Hex, compositionHash: i.compositionHash as Hex, inputToken: i.inputToken as Address,
  maxInput: big(i.maxInput), priceLimitsHash: i.priceLimitsHash as Hex, maxIntegratorFeeBps: Number(i.maxIntegratorFeeBps),
  maxProtocolFeeBps: Number(i.maxProtocolFeeBps), nonce: big(i.nonce), deadline: big(i.deadline),
});
const sellArg = (i: Record<string, string | number>) => ({
  seller: i.seller as Address, recipient: i.recipient as Address, strategyId: i.strategyId as Hex, strategyVersion: Number(i.strategyVersion),
  holdingsHash: i.holdingsHash as Hex, outputToken: i.outputToken as Address, minGrossOutput: big(i.minGrossOutput), nonce: big(i.nonce), deadline: big(i.deadline),
});
const planArg = (p: any) => ({
  intentHash: p.intentHash as Hex, expiry: big(p.expiry), inputAmount: big(p.inputAmount), integratorFeeRecipient: p.integratorFeeRecipient as Address,
  integratorFee: big(p.integratorFee), protocolFee: big(p.protocolFee),
  legs: p.legs.map((l: any) => ({ tokenOut: l.tokenOut as Address, amountIn: big(l.amountIn), minOut: big(l.minOut), adapter: l.adapter as Address, adapterData: l.adapterData as Hex })),
});

describe('BasketTypes (shared vectors)', async () => {
  const { viem } = await network.connect();
  const harness = await viem.deployContract('BasketTypesHarness');

  it('domain separators', async () => {
    for (const d of vectors.domains) assert.equal(await harness.read.domainSeparator([big(d.chainId), d.router]), d.separator);
  });

  it('BasketIntent struct hashes, digests and signatures', async () => {
    for (const v of vectors.intents) {
      const intent = intentArg(v.intent);
      assert.equal(await harness.read.hashIntent([intent]), v.structHash, v.name);
      for (const d of v.byDomain) {
        assert.equal(await harness.read.intentDigest([intent, big(d.chainId), router]), d.digest, `${v.name} @${d.chainId}`);
        assert.equal(await harness.read.isValidSignature([vectors.signer, d.digest, d.signature]), true);
      }
      // A signature made for one chain does not verify for the other chain's digest.
      assert.equal(await harness.read.isValidSignature([vectors.signer, v.byDomain[1].digest, v.byDomain[0].signature]), false);
    }
  });

  it('SellIntent struct hash, digest and signature', async () => {
    for (const v of vectors.sellIntents) {
      const intent = sellArg(v.intent);
      assert.equal(await harness.read.hashSellIntent([intent]), v.structHash);
      assert.equal(await harness.read.sellDigest([intent, 4663n, router]), v.digest);
      assert.equal(await harness.read.isValidSignature([vectors.signer, v.digest, v.signature]), true);
    }
  });

  it('price limit, holdings and plan hashes', async () => {
    for (const v of vectors.priceLimits) assert.equal(await harness.read.priceLimitsHash([v.maxPriceX18.map(big)]), v.hash);
    for (const v of vectors.holdings) assert.equal(await harness.read.holdingsHash([v.tokens, v.amounts.map(big)]), v.hash);
    for (const v of vectors.plans) assert.equal(await harness.read.planHash([planArg(v.plan)]), v.hash);
  });

  it('minOut from price limits; a zero limit reverts', async () => {
    for (const v of vectors.minOut) assert.equal(await harness.read.minOutFromPriceLimit([big(v.amountIn), big(v.maxPriceX18)]), big(v.minOut));
    await assert.rejects(harness.read.minOutFromPriceLimit([1n, 0n]));
  });

  it('target splits; bad weights revert', async () => {
    for (const v of vectors.splits) {
      assert.deepEqual((await harness.read.splitByWeight([big(v.amount), v.weightsBps])).map(String), v.parts, v.amount);
    }
    await assert.rejects(harness.read.splitByWeight([1n, [5000, 4999]]));
    await assert.rejects(harness.read.splitByWeight([1n, [10000, 0]]));
  });
});
