import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, verifyTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DCA_EXECUTOR_ABI,
  dcaAuthorizationId,
  dcaAuthorizationTypedData,
  dcaCeilingMinimums,
  dcaCompositionHash,
  dcaLegAmounts,
  dcaRunDue,
  type DcaAuthorization,
  type DcaReceiptClient,
  type DcaRunState,
} from '../../../packages/bag-sdk/src/dca';
import { KeeperRpcError, type ExecuteCall, type KeeperChain, type PurchaseLog } from '../keeper/chain';

// Test helper: an in-memory chain that applies BagDcaExecutor's rules (SDK dcaRunDue, window, deadline,
// ceilings/floors) when a block is mined, with real EIP-712 signatures and real event encoding. Not a node.

export const owner = privateKeyToAccount(keccak256(toHex('dca-keeper-test-owner')));
export const KEEPER = '0x00000000000000000000000000000000000000ee' as Hex;
export const EXECUTOR = '0x00000000000000000000000000000000000000e1' as Hex;
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Hex;
export const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d' as Hex;
export const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as Hex;
export const DEP = { chainId: 4663, executor: EXECUTOR };
export const DAY = BigInt(86_400);
export const START = BigInt(1_800_000_000);
export const B = BigInt;

export function makeAuth(nonce = B(1)): DcaAuthorization {
  const assets = [
    { asset: NVDA, symbol: 'NVDA', weightBps: 5000, decimals: 18, maxPriceRaw: B(210_000_000) },
    { asset: TSLA, symbol: 'TSLA', weightBps: 5000, decimals: 18, maxPriceRaw: B(420_000_000) },
  ];
  return {
    owner: owner.address.toLowerCase() as Hex,
    recipient: owner.address.toLowerCase() as Hex,
    inputToken: USDG,
    bag: { bagId: `0x${'ab'.repeat(32)}`, bagVersion: B(1), compositionHash: dcaCompositionHash('robinhood', assets), definitionHash: `0x${'cd'.repeat(32)}`, strategyId: `0x${'00'.repeat(32)}`, strategyVersion: 0 },
    assets,
    schedule: { amountPerRun: B(10_000_000), totalBudget: B(50_000_000), maxRuns: 5, startsAt: START, periodSeconds: DAY, expiresAt: START + B(5) * DAY },
    route: { adapter: '0x00000000000000000000000000000000000000ad', swapRouter: '0xcaf681a66d020601342297493863e78c959e5cb2', allowedFees: [500, 3000] },
    nonce,
  };
}
export const signAuth = (a: DcaAuthorization) => owner.signTypedData(dcaAuthorizationTypedData(a, DEP) as any);

type Tx = { hash: Hex; nonce: number; call: ExecuteCall };
type Mined = { status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: any[]; window?: bigint; id?: Hex };

/** An in-memory executor + chain. Applies BagDcaExecutor's rules when a block is mined. */
export class FakeChain implements KeeperChain {
  keeper: Hex | null = KEEPER;
  time = START - B(100);
  blockNumber = B(100);
  blockHashes = new Map<bigint, Hex>([[B(100), keccak256(toHex('b100'))]]);
  blockTimes = new Map<bigint, bigint>([[B(100), START - B(100)]]);
  states = new Map<string, DcaRunState>();
  auths = new Map<string, DcaAuthorization>();
  mempool: Tx[] = [];
  mined = new Map<string, Mined>();
  minedNonce = 0;
  sent: Tx[] = [];
  logs: (PurchaseLog & { id: Hex })[] = [];
  /** USDG raw per whole token. */
  prices = new Map<string, bigint>([[NVDA, B(200_000_000)], [TSLA, B(400_000_000)]]);
  balance = B(1_000_000_000);
  allowance = B(50_000_000);
  keeperWei = B(10) ** B(18);
  pendingLag = false;
  failOp: string | null = null;
  sendMode: 'ok' | 'throwBeforeBroadcast' | 'broadcastThenThrow' = 'ok';
  recipientBal = new Map<string, bigint>();

  private rpc(op: string) {
    if (this.failOp === op) throw new KeeperRpcError(op);
  }
  receiptClient: DcaReceiptClient = {
    getChainId: async () => 4663,
    getTransactionReceipt: async ({ hash }) => {
      const m = this.mined.get(hash.toLowerCase());
      if (!m) throw Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' });
      return { transactionHash: hash, blockHash: m.blockHash, blockNumber: m.blockNumber, status: m.status, logs: m.logs };
    },
    getBlock: async ({ blockNumber }) => ({ hash: this.blockHashes.get(blockNumber) ?? null, timestamp: this.blockTimes.get(blockNumber) ?? B(0) }),
    getBlockNumber: async () => this.blockNumber,
  };
  async verifyOwnerSignature(o: Hex, td: any, sig: Hex) {
    return verifyTypedData({ address: o, ...td, signature: sig });
  }
  async head() {
    this.rpc('head');
    return { number: this.blockNumber, timestamp: this.time };
  }
  async getState(_e: Hex, _o: Hex, id: Hex) {
    this.rpc('getState');
    return { ...(this.states.get(id.toLowerCase()) ?? { runs: 0, spent: B(0), lastWindow: B(0), lastRunAt: B(0), revoked: false }) };
  }
  async ownerFunds() {
    return { balance: this.balance, allowance: this.allowance };
  }
  async keeperBalance() {
    return this.keeperWei;
  }
  async nonces() {
    return { latest: this.minedNonce, pending: this.pendingLag ? this.minedNonce : this.minedNonce + this.mempool.length };
  }
  async gasPrice() {
    return B(1_000_000_000);
  }
  async purchases(_e: Hex, _o: Hex, id: Hex) {
    this.rpc('purchases');
    return this.logs.filter((l) => l.id === id.toLowerCase() && this.blockHashes.get(l.blockNumber) === l.blockHash).map(({ id: _id, ...l }) => l);
  }
  async receipt(hash: Hex) {
    const m = this.mined.get(hash.toLowerCase());
    return m ? { status: m.status, blockNumber: m.blockNumber, blockHash: m.blockHash } : null;
  }
  async blockHashAt(n: bigint) {
    return this.blockHashes.get(n) ?? null;
  }
  async quote(_in: Hex, out: Hex, amountIn: bigint, fee: number) {
    this.rpc('quote');
    if (fee !== 3000) return null; // only the 0.3 % pools exist
    return (amountIn * B(10) ** B(18)) / this.prices.get(out)!;
  }
  /** Why the executor would refuse this call now (null = it would run). */
  private refusal(call: ExecuteCall): string | null {
    const id = dcaAuthorizationId(call.authorization, DEP).toLowerCase();
    if (call.run.authorizationId.toLowerCase() !== id) return 'AuthorizationMismatch';
    const st = this.states.get(id) ?? { runs: 0, spent: B(0), lastWindow: B(0), lastRunAt: B(0), revoked: false };
    const due = dcaRunDue(call.authorization, st, this.time);
    if (due.state !== 'DUE') return due.state === 'REVOKED' ? 'RevokedAuthorization' : 'NotDue';
    if (due.window !== call.run.window) return 'WrongWindow';
    if (this.time > call.run.deadline) return 'RunDeadlinePassed';
    if (this.balance < call.authorization.schedule.amountPerRun || this.allowance < call.authorization.schedule.amountPerRun) return 'ERC20InsufficientBalance';
    const legs = dcaLegAmounts(call.authorization);
    const mins = dcaCeilingMinimums(call.authorization);
    for (const [i, a] of call.authorization.assets.entries()) {
      const out = (legs[i] * B(10) ** B(18)) / this.prices.get(a.asset)!;
      const min = call.run.minOutFloors[i] > mins[i] ? call.run.minOutFloors[i] : mins[i];
      if (out < min) return 'Too little received';
    }
    return null;
  }
  async simulateExecute(_e: Hex, call: ExecuteCall) {
    this.rpc('simulate');
    const r = this.refusal(call);
    return r ? { ok: false as const, reason: r } : { ok: true as const, gas: B(400_000) };
  }
  async sendExecute(_e: Hex, call: ExecuteCall, nonce: number) {
    if (this.sendMode === 'throwBeforeBroadcast') throw new Error('process died before broadcast');
    const tx = { hash: keccak256(toHex(`tx:${this.sent.length}:${nonce}`)), nonce, call: JSON.parse(JSON.stringify(call, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) };
    this.sent.push(tx);
    this.mempool.push(tx);
    if (this.sendMode === 'broadcastThenThrow') throw new Error('connection reset after broadcast');
    return tx.hash;
  }
  /** Mines one block at the current time with every mempool transaction (by nonce). */
  mine() {
    this.blockNumber += B(1);
    const blockHash = keccak256(toHex(`block:${this.blockNumber}:${this.time}:${Math.random()}`));
    this.blockHashes.set(this.blockNumber, blockHash);
    this.blockTimes.set(this.blockNumber, this.time);
    for (const tx of this.mempool.sort((a, b) => a.nonce - b.nonce)) {
      this.minedNonce = Math.max(this.minedNonce, tx.nonce + 1);
      const reason = this.refusal(tx.call);
      const a = tx.call.authorization;
      const id = dcaAuthorizationId(a, DEP).toLowerCase() as Hex;
      if (reason) {
        this.mined.set(tx.hash.toLowerCase(), { status: 'reverted', blockNumber: this.blockNumber, blockHash, logs: [] });
        continue;
      }
      const st = this.states.get(id) ?? { runs: 0, spent: B(0), lastWindow: B(0), lastRunAt: B(0), revoked: false };
      const index = B(st.runs);
      const window = (this.time - a.schedule.startsAt) / a.schedule.periodSeconds;
      this.states.set(id, { runs: st.runs + 1, spent: st.spent + a.schedule.amountPerRun, lastWindow: window, lastRunAt: this.time, revoked: false });
      this.balance -= a.schedule.amountPerRun;
      this.allowance -= a.schedule.amountPerRun;
      const legs = dcaLegAmounts(a);
      const mins = dcaCeilingMinimums(a);
      const logs = a.assets.map((x, i) => {
        const before = this.recipientBal.get(x.asset) ?? B(0);
        const out = (legs[i] * B(10) ** B(18)) / this.prices.get(x.asset)!;
        this.recipientBal.set(x.asset, before + out);
        const min = tx.call.run.minOutFloors[i] > mins[i] ? tx.call.run.minOutFloors[i] : mins[i];
        return {
          address: EXECUTOR, logIndex: i, transactionHash: tx.hash, blockHash, blockNumber: this.blockNumber,
          topics: encodeEventTopics({ abi: DCA_EXECUTOR_ABI, eventName: 'AssetDelivered', args: { owner: a.owner, authorizationId: id, executionIndex: index } }),
          data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [a.recipient, x.asset, before, before + out, min]),
        };
      });
      logs.push({
        address: EXECUTOR, logIndex: logs.length, transactionHash: tx.hash, blockHash, blockNumber: this.blockNumber,
        topics: encodeEventTopics({ abi: DCA_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner: a.owner, authorizationId: id, executionIndex: index } }),
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [window, a.recipient, a.schedule.amountPerRun, B(a.assets.length)]),
      });
      this.mined.set(tx.hash.toLowerCase(), { status: 'success', blockNumber: this.blockNumber, blockHash, logs, window, id });
      this.logs.push({ window, executionIndex: index, hash: tx.hash, blockNumber: this.blockNumber, blockHash, id });
    }
    this.mempool = [];
  }
  /** Replaces the latest block: its purchases disappear and the counters roll back. */
  reorgLatest() {
    const n = this.blockNumber;
    for (const [hash, m] of this.mined) {
      if (m.blockNumber !== n) continue;
      this.mined.delete(hash);
      if (m.status === 'success' && m.id) {
        const st = this.states.get(m.id)!;
        this.states.set(m.id, { runs: st.runs - 1, spent: st.spent - B(10_000_000), lastWindow: st.runs - 1 > 0 ? st.lastWindow - B(1) : B(0), lastRunAt: B(0), revoked: false });
        this.balance += B(10_000_000);
        this.allowance += B(10_000_000);
      }
    }
    this.logs = this.logs.filter((l) => l.blockNumber !== n);
    this.blockHashes.set(n, keccak256(toHex(`reorg:${n}`)));
  }
  at(t: bigint) {
    this.time = t;
  }
}

