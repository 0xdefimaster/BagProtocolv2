import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, parseAbiItem, type Hex } from 'viem';
import { METAMASK_EIP7702_STATELESS_DELEGATOR as MM, SELF_AUTHORIZED_PERMISSION_CONTEXT as EMPTY } from '@/packages/bag-sdk/src';

// -----------------------------------------------------------------------------
// F-01 in the DEFAULT binding (BAG_WALLET_BATCH_BINDING unset = off). The legacy binding accepted a transaction
// from the wallet whose calldata starts with the redeemDelegations selector and carries the built call's bytes,
// whatever contract it was sent to. A contract of the owner's choosing receives that calldata, never runs the
// Composer call, and transfers output tokens to the wallet itself: the purchase was booked although the built
// call never executed and the deposit never left. The calldata's presence is not proof that the call ran.
// -----------------------------------------------------------------------------

const client = { getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getCode: vi.fn(), getTransactionCount: vi.fn(), getBlock: vi.fn() };
vi.mock('@/lib/blockchain/rpc/clients', () => ({ hasRpcEndpoint: () => true, getChainPublicClient: () => client }));
const { trackComposerTransaction } = await import('../composer-status');

const WALLET = '0x1111111111111111111111111111111111111111' as Hex;
const COMPOSER = '0x4444444444444444444444444444444444444444' as Hex;
const ATTACKER = '0xa77ac4e5a77ac4e5a77ac4e5a77ac4e5a77ac4e5' as Hex;
const PROXY = '0x8888888888888888888888888888888888888888' as Hex;
const USDG = '0xcccccccccccccccccccccccccccccccccccccccc' as Hex;
const OUT = '0x3131313131313131313131313131313131313131' as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const CALLDATA = ('0x12345678' + 'cd'.repeat(120)) as Hex;

const REDEEM = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
const EXECUTE = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MODE_BATCH = pad('0x01', { dir: 'right', size: 32 });
const batch = (calls: [Hex, bigint, Hex][]) => encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }], [calls]);
const envelope = encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [[EMPTY], [MODE_BATCH], [batch([[COMPOSER, BigInt(0), CALLDATA]])]] });
const log = (token: Hex, from: Hex, to: Hex, value: bigint) => ({
  address: token, topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});

function mine(to: Hex, input: Hex, logs: ReturnType<typeof log>[]) {
  client.getTransaction.mockResolvedValue({ hash: TX_HASH, from: WALLET, to, input, value: BigInt(0), nonce: 3, type: 'eip1559' });
  client.getTransactionReceipt.mockResolvedValue({ status: 'success', logs, blockNumber: BigInt(100) });
}
const track = (chain: 'robinhood' | 'ethereum' = 'robinhood') =>
  trackComposerTransaction({ txHash: TX_HASH, chain, recipient: WALLET, expectedTransaction: { to: COMPOSER, data: CALLDATA, value: '0' }, flow: 'purchase' });

/** What the owner's contract does instead of the Composer call: hands over outputs it was funded with. */
const FORGED_LOGS = [log(OUT, ATTACKER, WALLET, BigInt(5000))];
/** What the real Composer call does: pulls the deposit, delivers the output through the user's proxy. */
const REAL_LOGS = [log(USDG, WALLET, PROXY, BigInt(10_000_000)), log(OUT, PROXY, WALLET, BigInt(5000))];

beforeEach(() => { for (const f of Object.values(client)) f.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe('F-01 (default binding): the redeemDelegations route needs the chain\'s pinned DelegationManager', () => {
  it('refuses the envelope sent to a contract that is not the pinned DelegationManager', async () => {
    mine(ATTACKER, envelope, FORGED_LOGS);
    expect(await track()).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
  });

  it('refuses the route on a chain where no DelegationManager is pinned', async () => {
    mine(MM.delegationManager, envelope, REAL_LOGS);
    expect(await track('ethereum')).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
  });

  it('keeps accepting the same envelope sent to the pinned DelegationManager (MetaMask EIP-7702)', async () => {
    mine(MM.delegationManager, envelope, REAL_LOGS);
    expect(await track()).toEqual({ kind: 'DONE', receivedAmountsByAddress: { [OUT]: '5000' }, sentAmountsByAddress: { [USDG]: '10000000' } });
  });

  it('keeps accepting the wallet\'s own batch (EIP-5792 over EIP-7702) and the direct call', async () => {
    mine(WALLET, encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [MODE_BATCH, batch([[COMPOSER, BigInt(0), CALLDATA]])] }), REAL_LOGS);
    expect((await track()).kind).toBe('DONE');
    mine(COMPOSER, CALLDATA, REAL_LOGS);
    expect((await track()).kind).toBe('DONE');
  });

  it('enforce refuses the forged envelope too (unchanged)', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine(ATTACKER, envelope, FORGED_LOGS);
    expect(await track()).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/UNSUPPORTED_ENVELOPE/) });
  });
});
