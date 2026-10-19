import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { network } from 'hardhat';
import { concatHex, encodePacked, type Hex, type PublicClient } from 'viem';

// F-01 regression (found in the Phase 1 evidence run). END TO END against a REAL local EVM (Hardhat in-process) and a REAL PostgreSQL:
// the wallet sends one transaction that NEVER calls Composer. Its calldata starts with the redeemDelegations
// selector and carries the packed (to ‖ value ‖ data) of the Composer call BAG built for the intent; the called
// contract ignores it and pays 1 raw unit of each output token back to the wallet. verifyExecution must refuse it.
// Only the RPC client is redirected to the local chain; the matcher, the receipt reading, the tx-hash claim and the
// accounting RPC are the production code.

const chain = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/blockchain/rpc/clients', () => ({
  hasRpcEndpoint: () => true,
  getChainPublicClient: () => chain.client,
  getChainTransport: () => {
    throw new Error('not used');
  },
  getChainRpc: () => {
    throw new Error('not used');
  },
  __resetChainClientsForTests: () => undefined,
}));

import { createDraftBag, createTestDatabase, type TestDatabase } from './pg-harness';
import { verifyExecution } from '@/lib/server/purchase-execution';

let db: TestDatabase;
let publicClient: PublicClient;
let viem: Awaited<ReturnType<typeof network.connect>>['viem'];

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  const conn = await network.connect();
  viem = conn.viem;
  publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
  chain.client = publicClient;
});
afterAll(async () => {
  await db?.drop();
});

const COMPOSER_TO = '0x' + 'c0'.repeat(20);
const COMPOSER_DATA = ('0x12345678' + 'ab'.repeat(300)) as Hex; // stands in for the compiled Composer flow
const REDEEM_DELEGATIONS_SELECTOR = '0xcef6d209';
const SHARES = '1000000000000000000000'; // 1,000 shares quoted for the deposit
const DEPOSIT = '1000'; // quote-currency cost basis of the deposit

describe('F-01: a transaction that never runs the Composer call is not booked as the purchase', () => {
  it('refuses it (VERIFICATION_FAILED) and books nothing', async () => {
    const [wallet] = await viem.getWalletClients();
    const walletAddress = wallet.account.address.toLowerCase();
    const tokenA = await viem.deployContract('MockToken', ['Stock A', 'A', 18]);
    const tokenB = await viem.deployContract('MockToken', ['Stock B', 'B', 18]);
    const forged = await viem.deployContract('ForgedBatchTarget', [[tokenA.address, tokenB.address]]);
    await tokenA.write.mint([forged.address, BigInt(10)]);
    await tokenB.write.mint([forged.address, BigInt(10)]);

    const userId = (await db.admin.query('insert into users (wallet_address) values ($1) returning id', [walletAddress])).rows[0].id as string;
    const { bag } = await createDraftBag(db, userId);

    // The wallet's ONLY call: to the forged target, data = selector ‖ packed(Composer to ‖ value ‖ data).
    const input = concatHex([REDEEM_DELEGATIONS_SELECTOR, encodePacked(['address', 'uint256', 'bytes'], [COMPOSER_TO as Hex, BigInt(0), COMPOSER_DATA])]);
    const txHash = await wallet.sendTransaction({ to: forged.address, data: input });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const step = (i: number, token: string) => ({
      stepIndex: i, action: 'SWAP', targetSymbol: i ? 'B' : 'A',
      inputAsset: { chain: 'robinhood', address: '0x00000000000000000000000000000000000000c0' },
      outputAsset: { chain: 'robinhood', address: token.toLowerCase() },
      sourceChain: 'robinhood', destinationChain: 'robinhood',
      inputAmountRaw: '500000000', targetValueRaw: '500000000',
      outputAmountRaw: '5000000000000000000', outputDecimals: 18,
      minOutputRaw: null, providerEnforcedMinOutputRaw: '4950000000000000000',
      route: null, lifiStep: null, status: 'SUBMITTED', approvalTxHash: null, txHash, providerSubstatus: null, failureCode: null,
    });
    const intentId = (
      await db.admin.query(
        `insert into purchase_intents (user_id, wallet_address, bag_id, input_asset_chain, input_asset_address, input_amount_raw, shares_raw,
           route_fingerprint, recipe_version, composition_hash, nav_gross, nav_quote_currency, nav_as_of, steps, composer_transaction,
           status, expires_at, deposit_amount)
         values ($1, $2, $3, 'robinhood', '0x00000000000000000000000000000000000000c0', '1000000000', $4, 'fp', 1, 'h', '0', 'USD', now(),
           $5::jsonb, $6::jsonb, 'SUBMITTED', now() + interval '1 hour', $7) returning id`,
        [userId, walletAddress, bag.id, SHARES, JSON.stringify([step(0, tokenA.address), step(1, tokenB.address)]),
         JSON.stringify({ to: COMPOSER_TO, data: COMPOSER_DATA, value: '0', chainId: 31337, userProxy: '0x' + '9'.repeat(40) }), DEPOSIT]
      )
    ).rows[0].id as string;

    const r = await verifyExecution(db.client, { userId, walletAddress }, intentId);
    expect(r.ok).toBe(true);

    const row = (await db.admin.query('select status, failure_code, accounting_applied_at from purchase_intents where id = $1', [intentId])).rows[0];
    const position = (await db.admin.query('select shares_raw, cost_basis_quote from bag_investor_positions where user_id = $1 and bag_id = $2', [userId, bag.id])).rows[0];
    const held = (await db.admin.query('select address, quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2 order by address', [userId, bag.id])).rows;
    // Printed so a regression shows what the code booked.
    console.log('F-01 observed:', JSON.stringify({ status: row.status, failure: row.failure_code, position, held }));

    expect(row.status).toBe('FAILED');
    expect(row.failure_code).toBe('VERIFICATION_FAILED');
    expect(position).toBeUndefined();
  });
});
