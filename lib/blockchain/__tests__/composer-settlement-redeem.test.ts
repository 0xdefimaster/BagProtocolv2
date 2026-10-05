import { describe, expect, it } from 'vitest';
import { FlowSchema } from '@lifi/compose-spec';
import { Schema } from 'effect';
import { buildComposerSettlementRedeem, SETTLE_FLAT_SIGNATURE } from '../lifi-composer-adapter';

// The final flow of a fee-paying redemption (the push shape proven live in P1 SP2): every held token sold into
// USDG, a USDG holding going in as is, the outputs merged, the merged USDG transferred to the settlement contract,
// then settleFlat called with the attested values as flow inputs. Built against a stubbed Composer endpoint.

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const AMKR = '0xdd356aa38f40a7b7076755ac854b6fbb1f0d305b';
const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c';
const SETTLEMENT = '0x00000000000000000000000000000000000005e1';
const PROXY = '0xad834b4de0295622a4042a3caa62ce5b961578e7';

function stub(response: Record<string, unknown>) {
  const requests: { flow: { nodes: { id: string; op: string; bind: Record<string, { $ref: string }>; config: Record<string, unknown> }[] }; run: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: response }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const request = (fetchImpl: typeof fetch) => ({
  chain: 'robinhood' as const,
  inputs: [
    { address: AMKR, amountRaw: '20000000000000000', symbol: 'AMKR' },
    { address: SPY, amountRaw: '1700000000000000', symbol: 'SPY' },
    { address: USDG, amountRaw: '500000', symbol: 'USDG' },
  ],
  outputTokenAddress: USDG,
  settlementAddress: SETTLEMENT,
  settle: {
    redemptionId: `0x${'aa'.repeat(32)}` as const,
    user: '0xb193DE199EeB9bd1143607a11AD00999Ceb956b8' as const,
    creator: '0x00000000000000000000000000000000000000c1' as const,
    contextHash: `0x${'cc'.repeat(32)}` as const,
    consumedBasis: BigInt(2_000_000),
    lossCarry: BigInt(0),
    feeRateBps: BigInt(1000),
    minUserProceeds: BigInt(2_378_287),
    deadline: BigInt(1_791_221_521),
    r: `0x${'11'.repeat(32)}` as const,
    vs: `0x${'22'.repeat(32)}` as const,
  },
  signerAddress: '0xb193DE199EeB9bd1143607a11AD00999Ceb956b8',
  slippageBps: 100,
  apiKey: 'test',
  baseUrl: 'https://composer.test',
  fetchImpl,
});

const success = (approvals: unknown[] = []) => ({
  status: 'success',
  userProxy: PROXY,
  producedResources: {},
  approvals,
  transactionRequest: { to: PROXY, data: '0x1234', value: '0' },
});

describe('buildComposerSettlementRedeem', () => {
  it('builds swaps → merges → transfer to the settlement → settleFlat(attested inputs); the flow decodes against FlowSchema', async () => {
    const { requests, fetchImpl } = stub(success());
    const r = await buildComposerSettlementRedeem(request(fetchImpl));
    expect(r.userProxy).toBe(PROXY);
    const { flow, run } = requests[0];
    expect(Schema.decodeUnknownEither(FlowSchema)(flow)._tag).toBe('Right');
    expect(flow.nodes.map((n) => `${n.id}:${n.op}`)).toEqual(['sweep_0:lifi.swap', 'sweep_1:lifi.swap', 'merge_1:core.merge', 'merge_2:core.merge', 'push:core.transfer', 'settle:core.invoke']);
    // The USDG holding goes into the merge as is (no swap of USDG into USDG).
    expect(flow.nodes[3].bind.b.$ref).toBe('input.in_2');
    expect(flow.nodes[4].bind).toEqual({ amount: { $ref: 'merge_2.merged' }, recipient: { $ref: 'input.settlementAddress' } });
    expect(flow.nodes[5].config.target).toBe(SETTLEMENT);
    expect(flow.nodes[5].config.functionSignature).toBe(SETTLE_FLAT_SIGNATURE);
    expect((flow.nodes[5].config.args as { $ref: string }[]).map((a) => a.$ref)).toEqual(
      ['redemptionId', 'user', 'creator', 'contextHash', 'consumedBasis', 'lossCarry', 'feeRateBps', 'minUserProceeds', 'deadline', 'r', 'vs'].map((n) => `input.${n}`)
    );
    expect(run.inputs).toMatchObject({ settlementAddress: SETTLEMENT, feeRateBps: '1000', minUserProceeds: '2378287' });
    expect(run.sweepTo).toEqual({ $ref: 'context.sender' });
    // Push keeps Composer's own price-impact guard: no override is sent.
    expect(run).not.toHaveProperty('maxPriceImpactBps');
  });

  it('refuses an approval for a token not being sold or above the amount, and a transaction that spends ETH', async () => {
    await expect(buildComposerSettlementRedeem(request(stub(success([{ token: USDG, spender: PROXY, amount: '500001' }])).fetchImpl))).rejects.toThrow(/above what is being sold/);
    await expect(buildComposerSettlementRedeem(request(stub(success([{ token: '0x00000000000000000000000000000000000000ff', spender: PROXY, amount: '1' }])).fetchImpl))).rejects.toThrow(/not being sold/);
    await expect(buildComposerSettlementRedeem(request(stub({ ...success(), transactionRequest: { to: PROXY, data: '0x', value: '1' } }).fetchImpl))).rejects.toThrow(/native ETH/);
  });
});
