import { PublicClient } from 'viem';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { EvmChainConfig } from './config';

// -----------------------------------------------------------------------------
// READ-ONLY chain client for Bag deployment/version verification. Delegates to
// the resilient RPC layer (lib/blockchain/rpc/clients.ts): primary → secondary
// → public failover, timeouts, circuit breaker.
//
// There is intentionally NO wallet/signing client here. Bag deployment is
// user-signed: the person's own wallet signs `BagFactory.createBag()` in the
// browser, and this server only ever READS the chain to verify what happened.
// The previous `createEvmWalletClient()` (backed by `DEPLOYER_PRIVATE_KEY`)
// had no remaining callers and was removed so that no server-side Bag signing
// capability exists in the application tree. `DEPLOYER_PRIVATE_KEY` is now
// used ONLY by one-off operator scripts under scripts/ (deploying contracts).
// -----------------------------------------------------------------------------

export function createEvmPublicClient(config: EvmChainConfig): PublicClient {
  return getChainPublicClient(config.chain);
}
