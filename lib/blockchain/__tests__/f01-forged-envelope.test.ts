import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, parseAbiItem, type Hex } from 'viem';

// -----------------------------------------------------------------------------
// F-01. The default binding accepted a transaction from the wallet whose calldata starts with the
// redeemDelegations selector and carries the built call's bytes, whatever contract it was sent to. A contract of
// the owner's choosing receives that calldata, never runs the Composer call, and transfers output tokens to the
// wallet itself: the purchase was booked although the built call never executed and the deposit never left.
// The calldata's presence is not proof that the call ran.
// -----------------------------------------------------------------------------

const client = { getTransaction: vi.fn(), getTransactionReceipt: vi.fn() };
vi.mock('@/lib/blockchain/rpc/clients', () => ({ hasRpcEndpoint: () => true, getChainPublicClient: () => client }));
const { trackComposerTransaction, trustedDelegationManagers } = await import('../composer-status');

const WALLET = '0x1111111111111111111111111111111111111111' as Hex;
const COMPOSER = '0x4444444444444444444444444444444444444444' as Hex;
const ATTACKER = '0xa77ac4e5a77ac4e5a77ac4e5a77ac4e5a77ac4e5' as Hex;
const PROXY = '0x8888888888888888888888888888888888888888' as Hex;
const USDG = '0xcccccccccccccccccccccccccccccccccccccccc' as Hex;
const OUT = '0x3131313131313131313131313131313131313131' as Hex;
const DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3' as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const CALLDATA = ('0x12345678' + 'cd'.repeat(120)) as Hex;

const REDEEM = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
const EXECUTE = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MODE_BATCH = pad('0x01', { dir: 'right', size: 32 });
/** abi.encode(new Delegation[](0)): the self-authorized permission context a successful redeemDelegations needs. */
const SELF_CONTEXT = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(32), BigInt(0)]);
const batch = (calls: [Hex, bigint, Hex][]) => encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }], [calls]);
const envelope = encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [[SELF_CONTEXT], [MODE_BATCH], [batch([[COMPOSER, BigInt(0), CALLDATA]])]] });
const log = (token: Hex, from: Hex, to: Hex, value: bigint) => ({
  address: token, topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});

function mine(to: Hex, input: Hex, logs: ReturnType<typeof log>[]) {
  client.getTransaction.mockResolvedValue({ hash: TX_HASH, from: WALLET, to, input, value: BigInt(0) });
  client.getTransactionReceipt.mockResolvedValue({ status: 'success', logs, blockNumber: BigInt(100) });
}
const track = (chain: 'robinhood' | 'ethereum' = 'robinhood') =>
  trackComposerTransaction({ txHash: TX_HASH, chain, recipient: WALLET, expectedTransaction: { to: COMPOSER, data: CALLDATA, value: '0' } });

/** What the owner's contract does instead of the Composer call: hands over outputs it was funded with. */
const FORGED_LOGS = [log(OUT, ATTACKER, WALLET, BigInt(5000))];
/** What the real Composer call does: pulls the deposit, delivers the output through the user's proxy. */
const REAL_LOGS = [log(USDG, WALLET, PROXY, BigInt(10_000_000)), log(OUT, PROXY, WALLET, BigInt(5000))];

beforeEach(() => { client.getTransaction.mockReset(); client.getTransactionReceipt.mockReset(); });

describe('F-01: the redeemDelegations route needs the chain\'s pinned DelegationManager', () => {
  it('refuses the envelope sent to a contract that is not the pinned DelegationManager', async () => {
    mine(ATTACKER, envelope, FORGED_LOGS);
    expect(await track()).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
  });

  it('refuses the route on a chain where no DelegationManager is pinned', async () => {
    mine(DELEGATION_MANAGER, envelope, REAL_LOGS);
    expect(await track('ethereum')).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    expect(trustedDelegationManagers('ethereum')).toEqual([]);
  });

  it('keeps accepting the same envelope sent to the pinned DelegationManager (MetaMask EIP-7702)', async () => {
    mine(DELEGATION_MANAGER, envelope, REAL_LOGS);
    expect(await track()).toEqual({ kind: 'DONE', receivedAmountsByAddress: { [OUT]: '5000' }, sentAmountsByAddress: { [USDG]: '10000000' } });
  });

  it("keeps accepting the wallet's own batch (EIP-5792 over EIP-7702) and the direct call from an EOA", async () => {
    mine(WALLET, encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [MODE_BATCH, batch([[COMPOSER, BigInt(0), CALLDATA]])] }), REAL_LOGS);
    expect((await track()).kind).toBe('DONE');
    mine(COMPOSER, CALLDATA, REAL_LOGS);
    expect((await track()).kind).toBe('DONE');
  });

  it('pins the same MetaMask DelegationManager on Robinhood, Base and Arbitrum', () => {
    for (const chain of ['robinhood', 'base', 'arbitrum'] as const) expect(trustedDelegationManagers(chain)).toEqual([DELEGATION_MANAGER]);
  });
});
