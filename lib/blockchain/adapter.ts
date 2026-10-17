// -----------------------------------------------------------------------------
// Blockchain adapter interface.
//
// Nothing in this MVP touches a real chain — every write in the app goes
// through the domain services in `lib/services`, which persist to the local
// database stand-in (localStorage today, a real DB later). This interface is
// the seam where a real chain gets plugged in later without having to touch
// UI or domain logic: swap `mockAdapter` for a `RobinhoodChainAdapter` that
// implements the same shape.
// -----------------------------------------------------------------------------

export interface MintNFTParams {
  ownerAddress: string;
  bagNftId: string;
  metadataUri: string;
}

export interface TransferNFTParams {
  fromAddress: string;
  toAddress: string;
  tokenId: string;
}

// ----------------------------- Bag deployment (user-signed) ----------------------
//
// USER-SIGNED MODEL: the backend never holds a private key that can call
// `createBag()`. Deployment is a prepare/verify pair, deliberately NOT part
// of `BlockchainAdapter` (which is the NFT/mock surface) so that no mock can
// ever be selected for Bag deployment:
//
//   prepareBagCreation()  — pure calldata construction: no wallet, no network
//                           write, no DB write. The person's wallet might
//                           reject or the tab might close; there is nothing
//                           to roll back because nothing was written.
//   (the person's own wallet signs and broadcasts — this code never sees
//    the unsigned transaction leave the browser)
//   verifyBagCreation()   — server re-reads the chain itself and checks every
//                           invariant before the caller may persist anything.
// -----------------------------------------------------------------------------

export interface PrepareBagCreationParams {
  /**
   * bytes32 — `computeOnChainBagId(bags.id)`: the off-chain UUID encoded
   * directly (NOT hashed). Only HALF of the on-chain identity:
   * `BagFactory.createBag()` derives the final `bagId` as
   * `keccak256(abi.encode(msg.sender, offChainRef))` — there is no `bagId`
   * and no `creator` input, because `msg.sender` is whichever wallet signs.
   */
  offChainRef: `0x${string}`;
  /** bytes32 — computeOnChainCompositionHash() over the CURRENT bag version. */
  compositionHash: `0x${string}`;
  metadataURI: string;
  /** `bags.mutability === 'MUTABLE'` — recorded on-chain; an immutable Bag can never record a new version. */
  isMutable: boolean;
}

/** Unsigned transaction data for the person's own wallet to sign and send — never sent by this codebase. */
export interface PreparedBagCreationTx {
  /** The BagFactory address this transaction must be sent to. */
  to: string;
  /** ABI-encoded `createBag(offChainRef, compositionHash, metadataURI, isMutable)` calldata. */
  data: `0x${string}`;
  /** The numeric chain id the wallet must be connected to when sending this. */
  chainId: number;
  /**
   * The protocol creation fee in wei, read from the factory at prepare time,
   * sent as this transaction's `value`. `createBag` requires it EXACTLY, so a
   * fee changed after prepare makes the transaction revert rather than
   * charge a different amount. "0" when the fee is off.
   */
  value: string;
}

export interface VerifyBagCreationParams {
  /** Hash of a transaction the person's wallet claims to have sent — read from the chain, never trusted at face value. Any casing. */
  txHash: string;
  /** The BagFactory address the transaction must have been sent `to`. */
  expectedFactoryAddress: string;
  /** Must equal `BagCreated.offChainRef` exactly. */
  expectedOffChainRef: `0x${string}`;
  /** Must equal `BagCreated.compositionHash` — computed fresh from the CURRENT bag version at confirm time. */
  expectedCompositionHash: `0x${string}`;
  /**
   * The AUTHENTICATED SESSION's wallet address (never a request-body value).
   * Checked against `tx.from`, `BagCreated.creator` and `Bag.creator()`.
   */
  expectedCreator: `0x${string}`;
  /** Must equal `Bag.isMutable()` — the on-chain mutability must match `bags.mutability`. */
  expectedIsMutable: boolean;
}

export interface VerifiedBagCreation {
  contractAddress: string;
  /** Canonical lowercase tx hash. */
  txHash: string;
  blockNumber: number;
  /** The Bag's real on-chain id, READ FROM the `BagCreated` event (and re-derived + cross-checked) — never recomputed by the caller. Lowercase. */
  onChainBagId: `0x${string}`;
  /** `BagCreated.creator`, lowercase. */
  creatorAddress: `0x${string}`;
  offChainRef: `0x${string}`;
}

/** The transaction is not (yet) verifiable — not propagated, not mined within the bounded wait, or below the required confirmation depth. Retrying later is safe and expected. NOT a failure. */
export class BagCreationPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BagCreationPendingError';
  }
}

/** The transaction exists but is NOT a valid deployment for this Bag/wallet (wrong target/sender, reverted, missing/mismatched event, …). Never retry-able into success with the same hash. */
export class BagCreationVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BagCreationVerificationError';
  }
}

export interface BagDeploymentAdapter {
  readonly name: string;
  /** True only for an adapter that reads a real chain. */
  readonly isLive: boolean;
  /** The BagFactory address this adapter is configured for. */
  readonly factoryAddress: string;

  /** Builds the unsigned `createBag` calldata for the person's wallet to sign. Reads the current creation fee from the factory; never writes or signs anything. */
  prepareBagCreation(params: PrepareBagCreationParams): Promise<PreparedBagCreationTx>;

  /**
   * True if a Bag is already registered on-chain for (`creator`, `offChainRef`)
   * — read-only. Lets prepare refuse a doomed (`AlreadyDeployed`) transaction
   * before the person pays gas for it.
   */
  hasBagOnChain(creator: `0x${string}`, offChainRef: `0x${string}`): Promise<boolean>;

  /**
   * Read-only, best effort: the hash of the transaction in which the factory emitted
   * BagCreated for (`creator`, `offChainRef`), searched over a bounded recent block window.
   * `null` when it is not found in that window. Lets a Bag whose creation succeeded but was
   * never confirmed be recovered without the person digging up the hash; the hash still goes
   * through `verifyBagCreation` like any other.
   */
  findBagCreationTx?(creator: `0x${string}`, offChainRef: `0x${string}`): Promise<`0x${string}` | null>;

  /**
   * Re-reads `txHash` from the chain and verifies every invariant. Throws
   * `BagCreationPendingError` when it cannot be verified YET, and
   * `BagCreationVerificationError` when it is definitively not a valid
   * deployment. Never returns a partial result.
   */
  verifyBagCreation(params: VerifyBagCreationParams): Promise<VerifiedBagCreation>;
}

export interface BlockchainAdapter {
  readonly name: string;
  readonly isLive: boolean;

  mintNFT(params: MintNFTParams): Promise<string>;
  transferNFT(params: TransferNFTParams): Promise<string>;
  getBalance(address: string): Promise<string>;
}
