import { decodeEventLog, encodeFunctionData, type Hex, type PublicClient } from 'viem';
import { deriveOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import {
  BagCreationPendingError,
  BagCreationVerificationError,
  BagDeploymentAdapter,
  PrepareBagCreationParams,
  PreparedBagCreationTx,
  VerifyBagCreationParams,
  VerifiedBagCreation,
} from '../adapter';
import { ChainId } from '@/types/basket-protocol';
import { EvmChainConfig, getEvmChainConfig } from './config';
import { createEvmPublicClient } from './client';
import { bagFactoryAbi } from './factory-abi';
import { bagAbi } from './bag-abi';
import { waitForConfirmedReceipt } from './receipt-confirmation';

// -----------------------------------------------------------------------------
// The ONLY production BagDeploymentAdapter: a real-chain, READ-ONLY verifier
// plus a pure calldata encoder.
//
// USER-SIGNED MODEL: this adapter never sends a transaction and has no wallet
// client at all (see client.ts). `prepareBagCreation()` reads the factory's
// current creation fee and encodes calldata;
// `verifyBagCreation()` only ever READS chain state for a transaction the
// person's own wallet already sent, and independently re-checks every
// invariant. Nothing the client says about a transaction is trusted.
//
// Verification checklist (every item is enforced; none may be weakened):
//   1. the transaction exists (else PENDING — not propagated yet)
//   2. it succeeded (mined, status=success, required confirmations reached)
//   3. it was sent TO the configured BagFactory
//   4. it was sent FROM the authenticated session wallet
//   5. exactly one BagCreated event exists
//   6. …emitted BY the configured factory (not a lookalike contract)
//   7. BagCreated.creator == authenticated session wallet
//   8. BagCreated.offChainRef == the expected (server-derived) value
//   9. BagCreated.compositionHash == the CURRENT composition hash
//  10. BagCreated.bagId == keccak256(abi.encode(creator, offChainRef))
//  11. factory.bagOf(bagId) == the emitted Bag address
//  12. Bag.creator() == authenticated session wallet
//  (+ Bag.factory()/offChainRef()/bagId() agree with the factory & event)
// -----------------------------------------------------------------------------

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** viem surfaces "no such tx" as a named error; treat that (and only that) as PENDING, never as a verification failure. */
function isPendingError(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'TransactionNotFoundError' || name === 'TransactionReceiptNotFoundError';
}

/**
 * One adapter instance per chain config. `client` is injectable so unit tests
 * can drive the verification logic with a mocked viem client and the local-EVM
 * integration test can point it at a real (local) JSON-RPC node.
 */
export function createEvmBagDeploymentAdapter(config: EvmChainConfig, client?: PublicClient): BagDeploymentAdapter {
  const publicClient = () => client ?? createEvmPublicClient(config);

  return {
    name: `evm:${config.chain}`,
    isLive: true,
    factoryAddress: config.factoryAddress,

    async prepareBagCreation(params: PrepareBagCreationParams): Promise<PreparedBagCreationTx> {
      // Read-only: the current creation fee becomes this transaction's
      // `value`. createBag requires it exactly, so a fee changed after
      // prepare reverts the tx (WrongCreationFee) instead of charging more.
      const fee = (await publicClient().readContract({
        address: config.factoryAddress,
        abi: bagFactoryAbi,
        functionName: 'creationFee',
      })) as bigint;
      const data = encodeFunctionData({
        abi: bagFactoryAbi,
        functionName: 'createBag',
        args: [params.offChainRef, params.compositionHash, params.metadataURI, params.isMutable],
      });
      return { to: config.factoryAddress, data, chainId: config.viemChain.id, value: fee.toString() };
    },

    async hasBagOnChain(creator: `0x${string}`, offChainRef: `0x${string}`): Promise<boolean> {
      const bagId = deriveOnChainBagId(creator, offChainRef);
      const existing = await publicClient().readContract({
        address: config.factoryAddress,
        abi: bagFactoryAbi,
        functionName: 'bagOf',
        args: [bagId],
      });
      return !same(existing as string, ZERO_ADDRESS);
    },

    async verifyBagCreation(params: VerifyBagCreationParams): Promise<VerifiedBagCreation> {
      const fail = (message: string): never => {
        throw new BagCreationVerificationError(message);
      };

      // Canonicalise once; every later comparison/storage uses this value.
      if (!TX_HASH_RE.test(params.txHash)) fail(`"${params.txHash}" is not a valid transaction hash.`);
      const txHash = params.txHash.toLowerCase() as Hex;
      const rpc = publicClient();

      // 1. Transaction exists. (Only a genuine "not found" is PENDING; an RPC outage propagates as-is.)
      let tx;
      try {
        tx = await rpc.getTransaction({ hash: txHash });
      } catch (err) {
        if (isPendingError(err)) {
          throw new BagCreationPendingError(`No transaction found for ${txHash} yet (not propagated, or it never existed).`);
        }
        throw err;
      }
      if (!tx) throw new BagCreationPendingError(`No transaction found for ${txHash} yet.`);

      // 3 & 4. Definitive even while still pending — refuse a contract creation / wrong sender immediately.
      // `tx.to` is NOT required to be the factory: a smart-account wallet (e.g. MetaMask's EIP-7702 account,
      // which routes through its DelegationManager) sends the person's call via another contract. What binds
      // the deployment is checked below from the receipt: exactly one BagCreated emitted BY the configured
      // factory whose `creator` (the factory's msg.sender) is this session wallet, plus the on-chain reads.
      if (!tx.to) fail(`Transaction ${txHash} is a contract creation, not a call that reaches the BagFactory ${params.expectedFactoryAddress}.`);
      if (!same(tx.from, params.expectedCreator)) {
        fail(
          `Transaction ${txHash} was sent from ${tx.from}, not the authenticated wallet ${params.expectedCreator}. ` +
            `A person can only confirm a deployment they themselves signed.`
        );
      }

      // 2. Mined + successful + required confirmation depth, within a BOUNDED wait.
      // Per-call polling, NOT viem's waitForTransactionReceipt — see receipt-confirmation.ts for the
      // concurrent-wait bug that made simultaneous confirms of one hash report a spurious PENDING.
      const confirmation = await waitForConfirmedReceipt(rpc, {
        hash: txHash,
        confirmations: config.confirmations,
        timeoutMs: config.receiptTimeoutMs,
      });
      if (confirmation.status === 'NOT_MINED') {
        throw new BagCreationPendingError(`Transaction ${txHash} is not yet mined — retry shortly.`);
      }
      if (confirmation.status === 'INSUFFICIENT_DEPTH') {
        throw new BagCreationPendingError(
          `Transaction ${txHash} has ${confirmation.depth} of ${config.confirmations} required confirmation(s) — retry shortly.`
        );
      }
      const { receipt } = confirmation;
      if (receipt.status !== 'success') fail(`Transaction ${txHash} reverted — refusing to record a deployment for it.`);

      // 5 & 6. Exactly one BagCreated, emitted BY the factory (a BagCreated-shaped log from any other contract is ignored).
      const factoryLower = config.factoryAddress.toLowerCase();
      const created = receipt.logs
        .filter((log) => log.address.toLowerCase() === factoryLower)
        .map((log) => {
          try {
            return decodeEventLog({ abi: bagFactoryAbi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .filter((decoded): decoded is NonNullable<typeof decoded> & { eventName: 'BagCreated' } => decoded?.eventName === 'BagCreated');

      if (created.length === 0) fail(`Transaction ${txHash} confirmed but no BagCreated event from the factory was found in its logs.`);
      if (created.length > 1) fail(`Transaction ${txHash} contains ${created.length} BagCreated events from the factory — ambiguous, refusing.`);
      const { bagId, creator, offChainRef, bag, compositionHash } = created[0].args;

      // 7, 8, 9. Event fields must equal what the SERVER expects — never what the client says.
      if (!same(creator, params.expectedCreator)) {
        fail(`BagCreated.creator ${creator} is not the authenticated wallet ${params.expectedCreator} (tx ${txHash}).`);
      }
      if (!same(offChainRef, params.expectedOffChainRef)) {
        fail(`BagCreated.offChainRef ${offChainRef} does not match the expected ${params.expectedOffChainRef} (tx ${txHash}).`);
      }
      if (!same(compositionHash, params.expectedCompositionHash)) {
        fail(
          `BagCreated.compositionHash ${compositionHash} does not match the bag's current composition hash ${params.expectedCompositionHash} ` +
            `(tx ${txHash}) — the recipe may have changed since this transaction was prepared.`
        );
      }

      // 10. bagId must be exactly the creator-bound derivation.
      const expectedBagId = deriveOnChainBagId(creator, offChainRef);
      if (!same(bagId, expectedBagId)) {
        fail(`BagCreated.bagId ${bagId} != keccak256(abi.encode(creator, offChainRef)) = ${expectedBagId} (tx ${txHash}).`);
      }

      // 11. The factory's own registry must resolve bagId back to the emitted Bag.
      const registeredBag = await rpc.readContract({
        address: config.factoryAddress,
        abi: bagFactoryAbi,
        functionName: 'bagOf',
        args: [bagId],
      });
      if (!same(registeredBag as string, bag)) {
        fail(`factory.bagOf(bagId) (${registeredBag}) does not match BagCreated.bag (${bag}) — tx ${txHash}.`);
      }

      // 12. The deployed Bag's own getters must agree (belt and braces against a spoofed/misdecoded event).
      const [bagCreatorOnChain, bagFactoryOnChain, bagOffChainRefOnChain, bagIdOnChain, bagIsMutableOnChain] = await Promise.all([
        rpc.readContract({ address: bag, abi: bagAbi, functionName: 'creator' }),
        rpc.readContract({ address: bag, abi: bagAbi, functionName: 'factory' }),
        rpc.readContract({ address: bag, abi: bagAbi, functionName: 'offChainRef' }),
        rpc.readContract({ address: bag, abi: bagAbi, functionName: 'bagId' }),
        rpc.readContract({ address: bag, abi: bagAbi, functionName: 'isMutable' }),
      ]);
      if (!same(bagCreatorOnChain as string, params.expectedCreator)) {
        fail(`Bag.creator() (${bagCreatorOnChain}) does not match the authenticated wallet ${params.expectedCreator} (tx ${txHash}).`);
      }
      if (!same(bagFactoryOnChain as string, config.factoryAddress)) {
        fail(`Bag.factory() (${bagFactoryOnChain}) is not the configured BagFactory ${config.factoryAddress} (tx ${txHash}).`);
      }
      if (!same(bagOffChainRefOnChain as string, params.expectedOffChainRef) || !same(bagIdOnChain as string, bagId)) {
        fail(`Bag.offChainRef()/bagId() disagree with BagCreated / the expected values (tx ${txHash}).`);
      }
      if (bagIsMutableOnChain !== params.expectedIsMutable) {
        fail(
          `Bag.isMutable() is ${bagIsMutableOnChain} but the Bag is ${params.expectedIsMutable ? 'MUTABLE' : 'IMMUTABLE'} — ` +
            `the on-chain mutability must match (tx ${txHash}).`
        );
      }

      return {
        contractAddress: bag.toLowerCase(),
        txHash,
        blockNumber: Number(receipt.blockNumber),
        onChainBagId: bagId.toLowerCase() as Hex,
        creatorAddress: creator.toLowerCase() as Hex,
        offChainRef: offChainRef.toLowerCase() as Hex,
      };
    },
  };
}

/** Production entry point: resolves the chain's env-driven config (throws `ChainNotConfiguredError` if unset — callers fail closed) and builds the real read-only adapter. */
export function createBagDeploymentAdapter(chain: ChainId): BagDeploymentAdapter {
  return createEvmBagDeploymentAdapter(getEvmChainConfig(chain));
}

/** Read-only: the factory's current creation fee (wei) on `chain`, for display before deploying. Throws `ChainNotConfiguredError` if the chain has no factory configured. */
export async function readFactoryCreationFee(chain: ChainId): Promise<{ amountWei: string }> {
  const config = getEvmChainConfig(chain);
  const fee = (await createEvmPublicClient(config).readContract({
    address: config.factoryAddress,
    abi: bagFactoryAbi,
    functionName: 'creationFee',
  })) as bigint;
  return { amountWei: fee.toString() };
}
