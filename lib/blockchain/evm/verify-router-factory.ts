import type { Hex, PublicClient } from 'viem';

// -----------------------------------------------------------------------------
// lib/blockchain/evm/verify-router-factory.ts
//
// WHY. `BagExecutionRouter.bagFactory` is immutable (contracts/BagExecutionRouter.sol)
// — set once at construction and never repointable. `DEPLOYED_CONTRACTS.bagExecutionRouter`
// (lib/config/robinhood-chain.ts) and `FACTORY_ADDRESS_<CHAIN>` (lib/blockchain/evm/config.ts)
// are two SEPARATE env vars, read independently, with nothing in the application wiring
// them together. If an operator redeploys `BagFactory` (a new registry — see
// scripts/deploy-bag-factory.ts's own warning) and updates `FACTORY_ADDRESS_ROBINHOOD`
// but forgets to also redeploy/re-point `BagExecutionRouter` (scripts/deploy-bag-execution-router.ts),
// every Bag Router purchase would revert at `bagFactory.bagOf(plan.bagId)` with `UnknownBag` —
// not a fund-safety hole (the router's own trust boundary prevents any loss), but a silent,
// total availability failure for every purchase that route was expected to serve, that nothing
// today would catch before a real user hits it.
//
// This is DELIBERATELY NOT a per-request runtime check: reading `bagFactory()` on every purchase
// would add an RPC round trip to the hot path for a value that only ever changes at deploy time.
// Instead this is a preflight / deploy-time check — see scripts/verify-bag-router-factory.ts,
// meant to run as part of the deploy checklist (dependency graph in deploy-bag.ts's module
// doc / the spec's item 12) whenever either `BAG_EXECUTION_ROUTER_ADDRESS` or
// `FACTORY_ADDRESS_<CHAIN>` changes, before traffic is pointed at the new config.
// -----------------------------------------------------------------------------

/** Minimal read-only ABI slice: just the auto-generated getter for the `bagFactory` immutable. */
export const BAG_EXECUTION_ROUTER_FACTORY_GETTER_ABI = [
  {
    type: 'function',
    name: 'bagFactory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export class RouterFactoryMismatchError extends Error {
  constructor(
    public readonly routerAddress: string,
    public readonly routerBagFactory: string,
    public readonly configuredFactoryAddress: string
  ) {
    super(
      `BagExecutionRouter ${routerAddress} is immutably bound to BagFactory ${routerBagFactory}, but the ` +
        `application is configured with FACTORY_ADDRESS=${configuredFactoryAddress}. Every Bag Router purchase ` +
        `would revert with UnknownBag. Either redeploy BagExecutionRouter against the CURRENT factory ` +
        `(scripts/deploy-bag-execution-router.ts) or fix FACTORY_ADDRESS/BAG_EXECUTION_ROUTER_ADDRESS so both ` +
        `point at the same deployment.`
    );
    this.name = 'RouterFactoryMismatchError';
  }
}

/** Pure comparison — no network call, so trivially unit-testable independent of `readRouterBagFactory()`. */
export function assertRouterFactoryMatches(
  routerAddress: string,
  routerBagFactory: string,
  configuredFactoryAddress: string
): void {
  if (routerBagFactory.toLowerCase() !== configuredFactoryAddress.toLowerCase()) {
    throw new RouterFactoryMismatchError(routerAddress, routerBagFactory, configuredFactoryAddress);
  }
}

/** Reads the router's immutable `bagFactory` straight off-chain. Read-only; never used on the purchase hot path (see module doc). */
export async function readRouterBagFactory(client: PublicClient, routerAddress: Hex): Promise<Hex> {
  const result = await client.readContract({
    address: routerAddress,
    abi: BAG_EXECUTION_ROUTER_FACTORY_GETTER_ABI,
    functionName: 'bagFactory',
  });
  return result as Hex;
}

/** Composes the two above: reads the router's on-chain factory and asserts it matches the configured one. Throws `RouterFactoryMismatchError` on mismatch. */
export async function verifyRouterFactoryMatchesConfig(
  client: PublicClient,
  routerAddress: Hex,
  configuredFactoryAddress: string
): Promise<void> {
  const routerBagFactory = await readRouterBagFactory(client, routerAddress);
  assertRouterFactoryMatches(routerAddress, routerBagFactory, configuredFactoryAddress);
}
