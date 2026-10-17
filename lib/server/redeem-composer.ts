import { AssetIdentity, ExecutionStep } from '@/types/basket-protocol';
import { RedeemIntent, RedeemIntentStepRecord } from '@/types/redeem-intent';
import { buildComposerSweep, composerPortAmounts, sweepNodeId } from '@/lib/blockchain/lifi-composer-adapter';
import type { Outputs } from '@lifi/compose-spec';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';
import { ROBINHOOD_CHAIN_ID } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// One-transaction redemption: every SWAP leg of a redemption (each sells one of
// the depositor's own holdings into the chosen output token) compiled as ONE
// LI.FI Composer transaction, the same flow the wallet sweep uses
// (buildComposerSweep: per-swap slippage guard, Composer's price-impact limit,
// approvals only for the tokens being sold and never above the amount sold,
// no native ETH spent, output swept back to the signer).
//
// What does not change: the allocation (what is sold, how much) and its
// fingerprint, KEEP legs, the accounting (apply_redeem_execution debits each
// leg's `inputAmountRaw`), and the fee rule (prepareRedeemExecution still
// refuses this path for a Bag with a performance fee; those redeem through
// RedeemFeeRouter). Verification checks the reported hash IS this exact
// transaction (sender, target, calldata, value), that it succeeded, that each
// sold token left the wallet in full, and that the output token arrived.
//
// Never throws: returns null when Composer does not apply or refuses, and the
// caller keeps the per-asset LI.FI quotes.
// -----------------------------------------------------------------------------

export interface RedeemComposerBuild {
  steps: RedeemIntentStepRecord[];
  composerTransaction: NonNullable<RedeemIntent['composerTransaction']>;
}

export interface RedeemComposerRequest {
  steps: ExecutionStep[];
  walletAddress: string;
  outputAsset: AssetIdentity;
  outputDecimals: number;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function legAmounts(outputs: Outputs, legIndex: number) {
  const { expected, min } = composerPortAmounts(outputs, `${sweepNodeId(legIndex)}.amountOut`);
  return { out: expected, min };
}

export async function buildRedeemComposer(request: RedeemComposerRequest): Promise<RedeemComposerBuild | null> {
  const swaps = request.steps.filter((s) => s.action === 'SWAP');
  if (swaps.length === 0) return null;
  const chain = swaps[0].route.sourceChain;
  // Same-chain sales into the one output token only.
  const isOutput = (a: AssetIdentity) => a.chain === request.outputAsset.chain && a.address.toLowerCase() === request.outputAsset.address.toLowerCase();
  if (swaps.some((s) => s.route.sourceChain !== chain || s.route.destinationChain !== chain || !isOutput(s.route.outputAsset))) return null;

  let compiled;
  try {
    // The deadline is on the request itself (COMPOSER_COMPILE_TIMEOUT_MS in lifi-composer-adapter.ts).
    compiled = await buildComposerSweep({
      chain,
      inputs: swaps.map((s) => ({ address: s.route.inputAsset.address, amountRaw: s.route.inputAmountRaw, symbol: s.targetSymbol || s.route.inputAsset.address })),
      outputTokenAddress: request.outputAsset.address,
      signerAddress: request.walletAddress,
      slippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
      apiKey: request.apiKey,
      fetchImpl: request.fetchImpl,
    });
  } catch {
    return null;
  }

  const resources = compiled.outputs;
  const steps: RedeemIntentStepRecord[] = request.steps.map((step, stepIndex) => {
    const base = {
      stepIndex,
      targetSymbol: step.targetSymbol,
      inputAsset: step.route.inputAsset,
      outputAsset: step.route.outputAsset,
      sourceChain: step.route.sourceChain,
      destinationChain: step.route.destinationChain,
      inputAmountRaw: step.route.inputAmountRaw,
      targetValueRaw: step.route.targetValueRaw,
      route: null,
      lifiStep: null,
      approvalTxHash: null,
      txHash: null,
      providerSubstatus: null,
      failureCode: null,
    };
    if (step.action === 'KEEP') {
      return { ...base, action: 'KEEP', outputAmountRaw: null, outputDecimals: request.outputDecimals, minOutputRaw: null, status: 'NOT_NEEDED' };
    }
    const leg = legAmounts(resources, swaps.indexOf(step));
    return {
      ...base,
      action: 'SWAP',
      // Simulated, not guaranteed; replaced by the received amount at verification.
      outputAmountRaw: leg.out,
      outputDecimals: request.outputDecimals,
      minOutputRaw: null,
      providerEnforcedMinOutputRaw: leg.min,
      status: 'PENDING',
    };
  });

  return {
    steps,
    composerTransaction: {
      to: compiled.transactionRequest.to,
      data: compiled.transactionRequest.data,
      value: compiled.transactionRequest.value,
      chainId: compiled.transactionRequest.chainId ?? ROBINHOOD_CHAIN_ID,
      approvals: compiled.approvals,
    },
  };
}

/**
 * Splits what the wallet received in the one transaction across the SWAP legs, in proportion to each leg's
 * simulated output (equal shares when a simulation is missing); the last leg takes the rounding remainder.
 * Display only: redemption accounting debits each leg's input, never its output.
 */
export function splitReceivedAcrossLegs(received: bigint, simulated: (string | null)[]): string[] {
  if (simulated.length === 0) return [];
  const weights = simulated.every((v) => v !== null && BigInt(v) > BigInt(0)) ? simulated.map((v) => BigInt(v as string)) : simulated.map(() => BigInt(1));
  const total = weights.reduce((a, b) => a + b, BigInt(0));
  const parts = weights.map((w) => (received * w) / total);
  parts[parts.length - 1] = received - parts.slice(0, -1).reduce((a, b) => a + b, BigInt(0));
  return parts.map(String);
}
