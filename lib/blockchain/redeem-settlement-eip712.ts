import { encodeAbiParameters, getAddress, keccak256, parseSignature, signatureToCompactSignature, toHex, zeroAddress, type Hex } from 'viem';
import { computeOnChainBagId } from '../domain/basket-protocol/onchain';

// -----------------------------------------------------------------------------
// Single source of truth for RedeemSettlement's EIP-712 shape and for the
// settlement context hash — imported by the server-side signer
// (lib/server/redeem-settlement-attestation.ts) and by tests. Must stay
// byte-for-byte in sync with contracts/RedeemSettlement.sol's
// SETTLEMENT_TYPEHASH and EIP712('BagRedeemSettlement', '2').
// -----------------------------------------------------------------------------

export const REDEEM_SETTLEMENT_EIP712_DOMAIN_NAME = 'BagRedeemSettlement';
/** '2': the fork royalty deployment (Settlement gained `rootCreator`). A '1' signature never verifies on it. */
export const REDEEM_SETTLEMENT_EIP712_DOMAIN_VERSION = '2';

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'user', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'rootCreator', type: 'address' },
    { name: 'executor', type: 'address' },
    { name: 'contextHash', type: 'bytes32' },
    { name: 'consumedBasis', type: 'uint256' },
    { name: 'lossCarry', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'minUserProceeds', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export interface SettlementMessage {
  redemptionId: Hex;
  user: `0x${string}`;
  creator: `0x${string}`;
  /** A fork's root creator (gets RedeemSettlement.FORK_ROYALTY_SHARE_BPS of the fee); zero address when not a fork. */
  rootCreator: `0x${string}`;
  executor: `0x${string}`;
  contextHash: Hex;
  consumedBasis: bigint;
  lossCarry: bigint;
  feeRateBps: bigint;
  minUserProceeds: bigint;
  deadline: bigint;
}

export function settlementDomain(chainId: number, verifyingContract: `0x${string}`) {
  return { name: REDEEM_SETTLEMENT_EIP712_DOMAIN_NAME, version: REDEEM_SETTLEMENT_EIP712_DOMAIN_VERSION, chainId, verifyingContract } as const;
}

/** EIP-2098 compact form (r, vs) that `RedeemSettlement.settleFlat` takes. */
export function toCompactSignature(signature: Hex): { r: Hex; vs: Hex } {
  const { r, yParityAndS } = signatureToCompactSignature(parseSignature(signature));
  return { r, vs: yParityAndS };
}

// ----------------------------- Settlement context -----------------------------
//
// The STATE the attestor checked, as one hash. Deliberately excludes anything
// that comes from a quote (minimum proceeds, executor): phase 2 recomputes this
// from fresh state and must get the same hash as phase 1, or nothing is signed.
//
// Canonical by construction: a fixed, versioned ABI schema of static types —
// no JSON, no key order, no optional fields. Addresses are normalized,
// amounts are integers, legs are sorted by token address and duplicates are
// refused. So one logical state has exactly one encoding.

export const SETTLEMENT_CONTEXT_SCHEMA = 'BAG_SETTLEMENT_CONTEXT_V2';

export interface SettlementContext {
  chainId: number;
  settlement: `0x${string}`;
  /** BAG's Bag UUID (mapped to the on-chain bytes32 id). */
  bagId: string;
  /** The Bag's deployed contract, or null when it has none. */
  bagContract: string | null;
  /** The strategy version being sold and its composition hash. */
  strategyVersion: number;
  compositionHash: string;
  /** The redeem intent UUID (→ redemptionId). */
  redeemIntentId: string;
  user: string;
  creator: string;
  /** The root creator of a fork's lineage, or null when the Bag is not a fork. */
  rootCreator: string | null;
  sharesRaw: string;
  /** What is sold: one entry per input token. */
  legs: { token: string; amountRaw: string }[];
  /** The position's ledger head the basis and carry were read at. */
  ledgerHeadSeq: string;
  ledgerEventCount: number;
  consumedBasisRaw: string;
  lossCarryRaw: string;
  feeRateBps: number;
}

const uint = (v: string | number, name: string): bigint => {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new Error(`settlement context: ${name} must be a non-negative integer, got "${s}"`);
  return BigInt(s);
};

export function canonicalSettlementLegs(legs: SettlementContext['legs']): { token: `0x${string}`; amount: bigint }[] {
  const out = legs.map((l) => ({ token: getAddress(l.token), amount: uint(l.amountRaw, 'leg amount') }));
  out.sort((a, b) => (a.token.toLowerCase() < b.token.toLowerCase() ? -1 : a.token.toLowerCase() > b.token.toLowerCase() ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    if (out[i].token.toLowerCase() === out[i - 1].token.toLowerCase()) throw new Error(`settlement context: token ${out[i].token} appears twice`);
  }
  return out;
}

export function computeSettlementContextHash(ctx: SettlementContext): Hex {
  const legs = canonicalSettlementLegs(ctx.legs);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // schema tag
        { type: 'uint256' }, // chainId
        { type: 'address' }, // settlement contract
        { type: 'bytes32' }, // bagId
        { type: 'address' }, // bag contract
        { type: 'uint256' }, // strategy version
        { type: 'bytes32' }, // keccak(compositionHash)
        { type: 'bytes32' }, // redemptionId
        { type: 'address' }, // user
        { type: 'address' }, // creator
        { type: 'address' }, // root creator (zero when not a fork)
        { type: 'uint256' }, // shares sold
        { type: 'tuple[]', components: [{ type: 'address', name: 'token' }, { type: 'uint256', name: 'amount' }] }, // legs, sorted
        { type: 'uint256' }, // ledger head seq
        { type: 'uint256' }, // ledger event count
        { type: 'uint256' }, // consumed basis
        { type: 'uint256' }, // loss carry
        { type: 'uint256' }, // fee rate
      ],
      [
        keccak256(toHex(SETTLEMENT_CONTEXT_SCHEMA)),
        uint(ctx.chainId, 'chainId'),
        getAddress(ctx.settlement),
        computeOnChainBagId(ctx.bagId),
        ctx.bagContract ? getAddress(ctx.bagContract) : zeroAddress,
        uint(ctx.strategyVersion, 'strategyVersion'),
        keccak256(toHex(ctx.compositionHash)),
        computeOnChainBagId(ctx.redeemIntentId),
        getAddress(ctx.user),
        getAddress(ctx.creator),
        ctx.rootCreator ? getAddress(ctx.rootCreator) : zeroAddress,
        uint(ctx.sharesRaw, 'sharesRaw'),
        legs,
        uint(ctx.ledgerHeadSeq, 'ledgerHeadSeq'),
        uint(ctx.ledgerEventCount, 'ledgerEventCount'),
        uint(ctx.consumedBasisRaw, 'consumedBasisRaw'),
        uint(ctx.lossCarryRaw, 'lossCarryRaw'),
        uint(ctx.feeRateBps, 'feeRateBps'),
      ]
    )
  );
}

/** RedeemSettlement.FORK_ROYALTY_SHARE_BPS: the root creator's share of a fork's fee. */
export const FORK_ROYALTY_SHARE_BPS = BigInt(2000);

/** RedeemSettlement.computeRoyalty, off-chain: the root creator's share of `fee`. */
export function computeSettlementRoyalty(fee: bigint, creator: string, rootCreator: string | null): bigint {
  if (!rootCreator || /^0x0{40}$/i.test(rootCreator) || rootCreator.toLowerCase() === creator.toLowerCase()) return BigInt(0);
  return (fee * FORK_ROYALTY_SHARE_BPS) / BigInt(10000);
}

/** settleFlat's packed last word: `deadline << 16 | feeRateBps` (RedeemSettlement.settleFlat). */
export function packFeeRateAndDeadline(feeRateBps: bigint, deadline: bigint): bigint {
  if (feeRateBps < BigInt(0) || feeRateBps > BigInt(0xffff)) throw new Error('feeRateBps does not fit 16 bits');
  return (deadline << BigInt(16)) | feeRateBps;
}
