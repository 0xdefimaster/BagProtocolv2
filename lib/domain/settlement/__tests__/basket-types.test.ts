import { describe, expect, it } from 'vitest';
import { keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { splitByWeight as sdkSplitByWeight } from '../../../../packages/bag-sdk/src/split';
import vectors from '../../../../contracts/test/vectors/basket-settlement-v1.json';
import {
  domainSeparator, hashIntent, hashSellIntent, holdingsHash, intentDigest, minOutFromPriceLimit, planHash,
  priceLimitForMinOut, priceLimitsHash, sellDigest, settlementDomain, SETTLEMENT_TYPES, splitByWeight,
  type BasketIntent, type ExecutionPlan, type SellIntent,
} from '../basket-types';

// The shared vectors (contracts/test/vectors/basket-settlement-v1.json) recomputed off-chain. The Solidity side
// checks the same file in contracts/test/BasketTypes.test.ts.

const big = (v: string) => BigInt(v);
const toIntent = (i: Record<string, string | number>): BasketIntent => ({
  payer: i.payer as Address, recipient: i.recipient as Address, strategyId: i.strategyId as Hex, strategyVersion: Number(i.strategyVersion),
  definitionHash: i.definitionHash as Hex, compositionHash: i.compositionHash as Hex, inputToken: i.inputToken as Address,
  maxInput: big(String(i.maxInput)), priceLimitsHash: i.priceLimitsHash as Hex, maxIntegratorFeeBps: Number(i.maxIntegratorFeeBps),
  maxProtocolFeeBps: Number(i.maxProtocolFeeBps), nonce: big(String(i.nonce)), deadline: big(String(i.deadline)),
});
const toSell = (i: Record<string, string | number>): SellIntent => ({
  seller: i.seller as Address, recipient: i.recipient as Address, strategyId: i.strategyId as Hex, strategyVersion: Number(i.strategyVersion),
  holdingsHash: i.holdingsHash as Hex, outputToken: i.outputToken as Address, minGrossOutput: big(String(i.minGrossOutput)),
  nonce: big(String(i.nonce)), deadline: big(String(i.deadline)),
});
const toPlan = (p: (typeof vectors.plans)[number]['plan']): ExecutionPlan => ({
  intentHash: p.intentHash as Hex, expiry: big(p.expiry), inputAmount: big(p.inputAmount), integratorFeeRecipient: p.integratorFeeRecipient as Address,
  integratorFee: big(p.integratorFee), protocolFee: big(p.protocolFee),
  legs: p.legs.map((l) => ({ tokenOut: l.tokenOut as Address, amountIn: big(l.amountIn), minOut: big(l.minOut), adapter: l.adapter as Address, adapterData: l.adapterData as Hex })),
});
const router = vectors.domains[0].router as Address;

describe('basket settlement vectors (off-chain)', () => {
  it('signer is the documented throwaway key', () => {
    expect(privateKeyToAccount(keccak256(toHex(vectors.signerLabel))).address).toBe(vectors.signer);
  });

  it('domain separators', () => {
    for (const d of vectors.domains) expect(domainSeparator(d.chainId, d.router as Address)).toBe(d.separator);
  });

  it('BasketIntent struct hashes, digests and signatures', async () => {
    for (const v of vectors.intents) {
      const intent = toIntent(v.intent);
      expect(hashIntent(intent)).toBe(v.structHash);
      for (const d of v.byDomain) {
        expect(intentDigest(intent, d.chainId, router)).toBe(d.digest);
        const signer = await recoverTypedDataAddress({ domain: settlementDomain(d.chainId, router), types: SETTLEMENT_TYPES,
          primaryType: 'BasketIntent', message: intent, signature: d.signature as Hex });
        expect(signer).toBe(vectors.signer);
      }
      // The chain id is part of the domain: a signature for one chain is a different digest on another.
      expect(v.byDomain[0].digest).not.toBe(v.byDomain[1].digest);
    }
  });

  it('SellIntent struct hash, digest and signature', async () => {
    for (const v of vectors.sellIntents) {
      const intent = toSell(v.intent);
      expect(hashSellIntent(intent)).toBe(v.structHash);
      expect(sellDigest(intent, 4663, router)).toBe(v.digest);
      expect(await recoverTypedDataAddress({ domain: settlementDomain(4663, router), types: SETTLEMENT_TYPES, primaryType: 'SellIntent',
        message: intent, signature: v.signature as Hex })).toBe(vectors.signer);
    }
  });

  it('price limit, holdings and plan hashes', () => {
    for (const v of vectors.priceLimits) expect(priceLimitsHash(v.maxPriceX18.map(big))).toBe(v.hash);
    for (const v of vectors.holdings) expect(holdingsHash(v.tokens as Address[], v.amounts.map(big))).toBe(v.hash);
    for (const v of vectors.plans) expect(planHash(toPlan(v.plan))).toBe(v.hash);
    expect(vectors.plans[0].plan.intentHash).toBe(vectors.intents[0].structHash);
  });

  it('minOut from price limits, and the inverse used to build an intent', () => {
    for (const v of vectors.minOut) expect(minOutFromPriceLimit(big(v.amountIn), big(v.maxPriceX18)).toString()).toBe(v.minOut);
    expect(() => minOutFromPriceLimit(BigInt(1), BigInt(0))).toThrow();
    let seed = 5;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let c = 0; c < 2000; c++) {
      const amountIn = BigInt(1 + rand(2 ** 30)) * BigInt(1 + rand(1000));
      const minOut = BigInt(1 + rand(2 ** 30)) * BigInt(10) ** BigInt(rand(19));
      if (amountIn * BigInt(10) ** BigInt(18) < minOut) continue;
      const limit = priceLimitForMinOut(amountIn, minOut);
      // The derived minimum never falls below the requested one, and the next larger limit would.
      expect(minOutFromPriceLimit(amountIn, limit) >= minOut).toBe(true);
      expect(minOutFromPriceLimit(amountIn, limit + BigInt(1)) < minOut).toBe(true);
    }
    expect(() => priceLimitForMinOut(BigInt(1), BigInt(10) ** BigInt(19))).toThrow();
  });

  it('target splits', () => {
    for (const v of vectors.splits) expect(splitByWeight(big(v.amount), v.weightsBps).map(String)).toEqual(v.parts);
    expect(() => splitByWeight(BigInt(1), [5000, 4999])).toThrow();
    expect(() => splitByWeight(BigInt(1), [10_000, 0])).toThrow();
  });

  it('target split equals the SDK split for one chain (tokens in ascending order)', () => {
    let seed = 11;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let c = 0; c < 500; c++) {
      const n = 1 + rand(8);
      const cuts = Array.from({ length: n - 1 }, () => 1 + rand(9_999)).sort((a, b) => a - b);
      const weights = [...cuts, 10_000].map((x, i, a) => x - (i ? a[i - 1] : 0));
      if (weights.some((w) => w <= 0)) continue;
      const tokens = weights.map((_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
      const amount = BigInt(rand(2 ** 30)) * BigInt(1 + rand(1000));
      const sdk = sdkSplitByWeight(amount, { assets: tokens.map((address, i) => ({ chain: 'robinhood', address, decimals: 18, weightBps: weights[i] })) });
      expect(splitByWeight(amount, weights)).toEqual(tokens.map((t) => sdk.get(`robinhood:${t}`)));
    }
  });
});
