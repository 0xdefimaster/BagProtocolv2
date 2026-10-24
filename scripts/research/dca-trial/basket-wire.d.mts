import type { Address, Hex } from 'viem';
import type { CompiledPurchase } from '../../../packages/bag-sdk/src/execution';
import type { PurchasePlan } from '../../../packages/bag-sdk/src/purchase';
import type { BagDefinition } from '../../../packages/bag-sdk/src/types';
export type VmInstruction = [bigint, Hex];
export interface VmProgram { instructions: VmInstruction[]; state: Hex[]; wrapped: boolean }
export interface SwapData { callTo: Address; approveTo: Address; sendingAssetId: Address; receivingAssetId: Address; fromAmount: bigint; callData: Hex; requiresDeposit: boolean }
export type SwapArgs = [Hex, string, string, Address, bigint, SwapData[]];
export interface BasketLeg { token: string; weightBps: bigint; input: bigint; net: bigint; minimum: bigint; slot: bigint; feeHash: Hex }
export interface BasketProfile { instructions: VmInstruction[]; state: Hex[]; contextSlot: bigint; amountSlot: bigint; legs: BasketLeg[]; commandsHash: Hex }
export interface BasketWire {
  decode(data: Hex): VmProgram;
  encode(program: VmProgram): Hex;
  swap(data: Hex): SwapArgs;
  swapBody(args: SwapArgs): Hex;
  body(data: Hex): Hex;
  mutate(data: Hex, change: (program: VmProgram) => void): Hex;
  mutateSwap(data: Hex, slot: number, change: (args: SwapArgs) => void): Hex;
  profile(compiled: CompiledPurchase, plan: PurchasePlan, amounts: readonly bigint[], definition: BagDefinition): BasketProfile;
  normalize(data: Hex, context: Hex, deployed: boolean, profile: BasketProfile): Hex;
}
export function basketWire(viem: typeof import('viem')): BasketWire;
