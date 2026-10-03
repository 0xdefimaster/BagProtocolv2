import { keccak256, encodeAbiParameters, concat, toHex } from 'viem';

// -----------------------------------------------------------------------------
// Single source of truth for RedeemFeeRouter's EIP-712 shape — imported by
// both the server-side signer (redeem-fee-attestation.ts) and anything that
// needs to independently recompute the same hash (tests, the client-side
// verification step in use-redeem-execution.ts). A hand-copied duplicate of
// this logic in two places is exactly how a silent domain/typehash mismatch
// (attestation always fails on-chain, or worse, always fails a certain way
// that gets "fixed" by loosening a check) would slip in — see
// contracts/RedeemFeeRouter.sol's `LEG_TYPEHASH`/`FEE_ATTESTATION_TYPEHASH`
// for the Solidity side these constants must stay byte-for-byte in sync with.
// -----------------------------------------------------------------------------

export const REDEEM_FEE_ROUTER_EIP712_DOMAIN_NAME = 'BagRedeemFeeRouter';
export const REDEEM_FEE_ROUTER_EIP712_DOMAIN_VERSION = '3';

export const FEE_ATTESTATION_TYPES = {
  FeeAttestation: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'user', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'minUserProceeds', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'legsHash', type: 'bytes32' },
  ],
} as const;

/** Matches `RedeemFeeRouter.sol`'s `LEG_TYPEHASH` constant exactly. */
export const LEG_TYPEHASH = keccak256(
  toHex('RedeemLegAttestation(address inputToken,uint256 inputAmount,address swapTarget,bytes32 swapCallDataHash)')
);

export interface AttestedLeg {
  inputToken: `0x${string}`;
  inputAmount: bigint;
  /** address(0) for a "no swap" leg. */
  swapTarget: `0x${string}`;
  /** `'0x'` for a "no swap" leg. */
  swapCallData: `0x${string}`;
}

/**
 * Mirrors `RedeemFeeRouter._verifyAttestation()`'s on-chain computation
 * EXACTLY: `keccak256(abi.encodePacked(leg1Hash, leg2Hash, ...))` where each
 * `legHash = keccak256(abi.encode(LEG_TYPEHASH, inputToken, inputAmount,
 * swapTarget, keccak256(swapCallData)))`.
 * Order-sensitive — the legs array passed to `redeem()` must be in the same
 * order this was computed from, or the attestation will not verify
 * on-chain (by design — see RedeemFeeRouter.sol's own test for this).
 */
export function computeLegsHash(legs: AttestedLeg[]): `0x${string}` {
  const legHashes = legs.map((leg) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
        [LEG_TYPEHASH, leg.inputToken, leg.inputAmount, leg.swapTarget, keccak256(leg.swapCallData)]
      )
    )
  );
  return keccak256(concat(legHashes));
}
