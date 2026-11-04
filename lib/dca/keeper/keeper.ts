import type { Hex } from 'viem';
import {
  checkDcaTerms,
  dcaAuthorizationId,
  dcaAuthorizationTypedData,
  dcaCeilingMinimums,
  dcaLegAmounts,
  dcaRunDue,
  dcaWindowAt,
  verifyDcaReceipt,
  type DcaAuthorization,
  type DcaRunState,
} from '../../../packages/bag-sdk/src/dca';
import { KeeperRpcError, type ExecuteCall, type KeeperChain } from './chain';
import type { KeeperStore } from './store';
import { TERMINAL_STATES, type KeeperJob, type KeeperJobState, type MissedReason } from './types';

// -----------------------------------------------------------------------------
// The keeper state machine. One `tick` = claim due jobs (lease), step each,
// save, release. A step:
//   1. reconciles a write-ahead record against the chain BEFORE anything else
//      (mined → record the run; reverted / nonce used elsewhere / dropped →
//      clear it; still in the mempool → wait), never re-sending blind;
//   2. reads the executor counters (source of truth), back-fills runs other
//      keepers sent, re-checks recent runs for reorgs;
//   3. records windows that closed without a run, with the last blocker;
//   4. if a run is due: funding, quotes vs the signed ceilings, simulation,
//      gas, then write-ahead (nonce allocated atomically), then send.
// The executor itself refuses a second run in a window, so a race between two
// keepers costs gas, never a double purchase.
// -----------------------------------------------------------------------------

export type KeeperMode = 'PAPER' | 'SEND';

export type KeeperAlert = {
  kind: 'GAS_SHORTAGE' | 'RPC_ERROR' | 'VERIFICATION_NOT_VERIFIED' | 'REORG' | 'TX_NOT_INCLUDED' | 'SIMULATION_REVERTED' | 'EXECUTOR_INVARIANT' | 'LEASE_LOST' | 'STUCK_NONCE';
  jobId: Hex;
  detail: string;
};

export interface KeeperOptions {
  store: KeeperStore;
  chain: KeeperChain;
  /** PAPER: everything up to and including the simulation, never a transaction. */
  mode: KeeperMode;
  holder: string;
  leaseMs?: number;
  /** Jobs per tick. */
  batch?: number;
  /** Keeper floor below the fresh quote; it only ever RAISES the owner's ceiling minimum. Default 100 bps. */
  slippageBps?: number;
  /** RunParams.deadline = chain time + this. Default 300 s. */
  deadlineSeconds?: bigint;
  /** Gas estimate headroom in percent. Default 130. */
  gasHeadroomPercent?: bigint;
  /** A write-ahead record whose nonce is not in the mempool after this long is treated as dropped. Default 15 min. */
  pendingTimeoutMs?: number;
  /** Do not send this close before a window boundary (it would land in the next window: WrongWindow). Default 60 s. */
  inclusionSlackSeconds?: bigint;
  /** Re-check a confirmed run for reorgs until it is this many blocks deep. Default 64. */
  reorgDepth?: bigint;
  /** Retry delay for WAITING_PRICE / FUNDING / GAS / SIMULATION. Default 60 s. */
  retryMs?: number;
  /**
   * keccak256 of the executor's runtime code from the reviewed build. REQUIRED in SEND mode: addJob refuses an
   * executor whose code differs, and every run is verified with it. Optional in PAPER mode (runs are then marked
   * codeChecked: false).
   */
  executorCodeHash?: Hex;
  /** Output-token policy. REQUIRED in SEND mode: addJob refuses an authorization with any asset it rejects. */
  assetAllowed?: (asset: Hex) => boolean;
  /** Confirmations before a run is recorded VERIFIED (deeper reorgs are still detected later). Default 1. */
  minConfirmations?: bigint;
  /** A broadcast still in the mempool after this long is replaced (same nonce, higher gas price). Default 60 s. */
  replaceAfterMs?: number;
  /** Replacements per nonce before raising STUCK_NONCE. Default 3. */
  maxReplacements?: number;
  /** Gas price multiplier for a replacement, percent. Default 125 (most nodes need ≥ 110). */
  feeBumpPercent?: bigint;
  /** A broadcast missing from the mempool is declared dropped only after this long (RPC propagation lag). Default 30 s. */
  dropGraceMs?: number;
  now?: () => number;
  onAlert?: (a: KeeperAlert) => void;
}

const ONE = BigInt(1);
const lc = (h: string) => h.toLowerCase() as Hex;

export class DcaKeeper {
  private readonly o: Required<Omit<KeeperOptions, 'now' | 'onAlert' | 'executorCodeHash' | 'assetAllowed'>> & {
    now: () => number; onAlert: (a: KeeperAlert) => void; executorCodeHash: Hex | null; assetAllowed: ((asset: Hex) => boolean) | null;
  };
  constructor(options: KeeperOptions) {
    this.o = {
      leaseMs: 120_000, batch: 25, slippageBps: 100, deadlineSeconds: BigInt(300), gasHeadroomPercent: BigInt(130), pendingTimeoutMs: 15 * 60_000,
      inclusionSlackSeconds: BigInt(60), reorgDepth: BigInt(64), retryMs: 60_000, now: () => Date.now(), onAlert: () => {},
      minConfirmations: BigInt(1), replaceAfterMs: 60_000, maxReplacements: 3, feeBumpPercent: BigInt(125), dropGraceMs: 30_000,
      ...options,
      executorCodeHash: options.executorCodeHash ? lc(options.executorCodeHash) : null,
      assetAllowed: options.assetAllowed ?? null,
    };
    if (this.o.mode === 'SEND') {
      if (!this.o.chain.keeper) throw new Error('DcaKeeper: SEND mode needs a keeper account');
      if (!this.o.executorCodeHash) throw new Error('DcaKeeper: SEND mode needs executorCodeHash (the reviewed build)');
      if (!this.o.assetAllowed) throw new Error('DcaKeeper: SEND mode needs an assetAllowed policy');
    }
  }

  /**
   * Adds a signed authorization. The id is recomputed and the owner's signature checked (EOA or ERC-1271, through
   * the chain) and the static terms checked before anything is stored. Idempotent: the same id returns the stored job.
   */
  async addJob(input: { authorization: DcaAuthorization; ownerSignature: Hex; deployment: { chainId: number; executor: Hex } }): Promise<KeeperJob> {
    const { authorization: auth, deployment } = input;
    const problems = checkDcaTerms(auth, { executor: deployment.executor });
    if (problems.length) throw new Error(`addJob: invalid terms: ${problems.join('; ')}`);
    if (this.o.mode === 'SEND' && !/^0x0{40}$/i.test(auth.allowedCaller) && auth.allowedCaller.toLowerCase() !== this.o.chain.keeper!.toLowerCase()) {
      throw new Error(`addJob: the authorization may only be executed by ${auth.allowedCaller}, not by this keeper`);
    }
    const rejected = this.o.assetAllowed ? auth.assets.filter((a) => !this.o.assetAllowed!(lc(a.asset))) : [];
    if (rejected.length) throw new Error(`addJob: assets outside the keeper's token policy: ${rejected.map((a) => `${a.symbol} ${a.asset}`).join(', ')}`);
    if (this.o.executorCodeHash) {
      const onChain = await this.o.chain.codeHash(deployment.executor);
      if (onChain.toLowerCase() !== this.o.executorCodeHash) throw new Error(`addJob: executor ${deployment.executor} code hash ${onChain} is not the reviewed build ${this.o.executorCodeHash}`);
    }
    const id = lc(dcaAuthorizationId(auth, deployment));
    const ok = await this.o.chain.verifyOwnerSignature(auth.owner, dcaAuthorizationTypedData(auth, deployment), input.ownerSignature);
    if (!ok) throw new Error('addJob: the owner signature does not match the authorization');
    const head = await this.o.chain.head();
    return this.o.store.insert({
      id, deployment: { chainId: deployment.chainId, executor: lc(deployment.executor) }, authorization: auth, ownerSignature: input.ownerSignature,
      createdAt: this.o.now(), fromBlock: head.number, state: 'SCHEDULED', stateDetail: null, nextDueAt: auth.schedule.startsAt,
      observed: null, pending: null, confirmed: [], blocker: null, accountedThrough: BigInt(0), missed: [], attempts: [], lease: null,
    });
  }

  /** One pass: claim due jobs, step each, save, release. Returns the jobs as saved. */
  async tick(): Promise<KeeperJob[]> {
    const { store, holder } = this.o;
    const out: KeeperJob[] = [];
    for (const job of await store.claimDue(holder, this.o.now(), this.o.leaseMs, this.o.batch)) {
      let nextCheckMs = this.o.now() + this.o.retryMs;
      try {
        nextCheckMs = await this.step(job);
      } catch (e) {
        if (!(e instanceof KeeperRpcError)) {
          await store.release(job.id, holder);
          throw e;
        }
        this.set(job, 'RPC_ERROR', e.operation);
        const w = job.observed ? dcaWindowAt(job.authorization, job.observed.at) : null;
        if (w !== null && job.blocker?.window !== w) job.blocker = { window: w, reason: 'RPC_ERROR', detail: e.operation };
        this.o.onAlert({ kind: 'RPC_ERROR', jobId: job.id, detail: e.operation });
        nextCheckMs = this.o.now() + Math.min(this.o.retryMs, 30_000);
      }
      if (!(await store.save(job, holder, this.o.now()))) this.o.onAlert({ kind: 'LEASE_LOST', jobId: job.id, detail: 'lease expired before save; state left to the next holder' });
      await store.setNextCheck(job.id, nextCheckMs);
      await store.release(job.id, holder);
      out.push(job);
    }
    return out;
  }

  private set(job: KeeperJob, state: KeeperJobState, detail: string | null = null, nextDueAt: bigint | null = null) {
    job.state = state;
    job.stateDetail = detail;
    job.nextDueAt = nextDueAt;
  }

  private block(job: KeeperJob, window: bigint, reason: MissedReason, detail: string | null) {
    job.blocker = { window, reason, detail };
  }

  /** Windows that closed without a run since the last pass, with the last blocker seen in each. Never made up later. */
  private account(job: KeeperJob, st: DcaRunState, t: bigint) {
    const s = job.authorization.schedule;
    if (st.revoked) return;
    const total = (s.expiresAt - s.startsAt + s.periodSeconds - ONE) / s.periodSeconds;
    let upTo = t < s.startsAt ? BigInt(0) : t >= s.expiresAt ? total : (t - s.startsAt) / s.periodSeconds;
    const live = job.confirmed.filter((c) => !c.reorged);
    if (st.runs >= s.maxRuns && live.length) {
      const last = live.reduce((m, c) => (c.window > m ? c.window : m), BigInt(0)) + ONE;
      if (last < upTo) upTo = last;
    }
    const bought = new Set(live.map((c) => c.window.toString()));
    for (let w = job.accountedThrough; w < upTo; w++) {
      if (bought.has(w.toString())) continue;
      const seen = job.blocker?.window === w ? job.blocker : null;
      job.missed.push({ window: w, reason: seen?.reason ?? 'NOT_OBSERVED', detail: seen?.detail ?? null });
    }
    if (upTo > job.accountedThrough) job.accountedThrough = upTo;
    if (job.blocker && job.blocker.window < job.accountedThrough) job.blocker = null;
  }

  private async recordRun(job: KeeperJob, log: { hash: Hex; window: bigint; executionIndex: bigint; blockNumber: bigint; blockHash: Hex }) {
    const existing = job.confirmed.find((c) => !c.reorged && c.hash.toLowerCase() === log.hash.toLowerCase());
    if (existing && existing.verification !== 'INDETERMINATE') return;
    if (existing) job.confirmed.splice(job.confirmed.indexOf(existing), 1); // re-verify (e.g. confirmations reached)
    const v = await verifyDcaReceipt({
      client: this.o.chain.receiptClient, transactionHash: log.hash, auth: job.authorization, deployment: job.deployment, executionIndex: log.executionIndex,
      minConfirmations: this.o.minConfirmations, ...(this.o.executorCodeHash ? { expectedExecutorCodeHash: this.o.executorCodeHash } : {}),
    });
    job.confirmed.push({ ...log, verification: v.status, issues: v.issues.map((i) => `${i.code}: ${i.detail}`), reorged: false, finalized: false, codeChecked: v.executorCodeChecked });
    if (v.status !== 'VERIFIED') this.o.onAlert({ kind: 'VERIFICATION_NOT_VERIFIED', jobId: job.id, detail: `${log.hash} ${v.status}: ${v.issues.map((i) => i.code).join(',')}` });
  }

  /** Recent runs whose block is no longer canonical are marked reorged; the chain counters decide what happens next. */
  private async checkReorgs(job: KeeperJob, headNumber: bigint) {
    if (!job.confirmed.some((c) => !c.reorged && !c.finalized)) return;
    // Final only when BOTH the RPC's finalized tag (if any) and `reorgDepth` say so: a dev node or a misreporting
    // RPC that calls `latest` finalized does not end the reorg checks early.
    const deep = headNumber > this.o.reorgDepth ? headNumber - this.o.reorgDepth : BigInt(0);
    const tag = await this.o.chain.finalizedBlock();
    const finalized = tag !== null && tag < deep ? tag : deep;
    for (const c of job.confirmed) {
      if (c.reorged || c.finalized) continue;
      if (c.blockNumber <= finalized) {
        // still canonical at finality? check once more, then stop looking
        if ((await this.o.chain.blockHashAt(c.blockNumber))?.toLowerCase() === c.blockHash.toLowerCase()) {
          c.finalized = true;
          continue;
        }
      }
      const h = await this.o.chain.blockHashAt(c.blockNumber);
      const r = await this.o.chain.receipt(c.hash);
      if (h?.toLowerCase() !== c.blockHash.toLowerCase() || !r || r.blockHash.toLowerCase() !== c.blockHash.toLowerCase()) {
        if (r && r.status === 'success' && h?.toLowerCase() === r.blockHash.toLowerCase()) {
          // re-included in another block: re-verify there
          c.reorged = true;
          await this.recordRun(job, { hash: c.hash, window: c.window, executionIndex: c.executionIndex, blockNumber: r.blockNumber, blockHash: r.blockHash });
        } else c.reorged = true;
        job.attempts.push({ at: this.o.now(), window: c.window, outcome: 'REORGED', detail: `run ${c.hash} left block ${c.blockNumber}`, hash: c.hash });
        this.o.onAlert({ kind: 'REORG', jobId: job.id, detail: `${c.hash} at ${c.blockNumber}` });
      }
    }
  }

  /**
   * Resolves a write-ahead record against the chain. Returns true while a transaction with its nonce may still be
   * mined. Never clears a record whose nonce is still in the mempool: a stuck broadcast is REPLACED (same nonce,
   * higher gas price) and, once the run's deadline has passed (it would revert anyway), CANCELLED with a 0-value
   * self-transfer at that nonce; after `maxReplacements` it raises STUCK_NONCE and keeps waiting.
   */
  private async reconcilePending(job: KeeperJob): Promise<boolean> {
    const p = job.pending;
    if (!p) return false;
    const { chain } = this.o;
    const hashes = [...new Set([...(p.hashes ?? []), ...(p.hash ? [p.hash] : [])].map((h) => lc(h)))];
    const logged = (await chain.purchases(job.deployment.executor, job.authorization.owner, job.id, job.fromBlock)).find((l) => l.window === p.window);
    if (logged) {
      await this.recordRun(job, logged);
      if (!hashes.length) {
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'UNSENT', detail: `window ${p.window} was bought by ${logged.hash} before this record was sent`, hash: null });
      } else if (!hashes.includes(lc(logged.hash))) {
        // another keeper bought this window; ours either reverted on the executor's window check or never mined
        const own = await Promise.all(hashes.map((h) => chain.receipt(h)));
        const reverted = own.some((r) => r?.status === 'reverted');
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: reverted ? 'REVERTED' : 'NONCE_USED_ELSEWHERE', detail: `window ${p.window} was bought by ${logged.hash}`, hash: p.hash });
      }
      job.pending = null;
      return false;
    }
    for (const h of hashes) {
      const r = await chain.receipt(h);
      if (!r) continue;
      if (r.status === 'reverted') {
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'REVERTED', detail: 'mined and reverted; no counter changed', hash: h });
        this.block(job, p.window, 'TX_NOT_INCLUDED', `transaction ${h} reverted`);
        job.pending = null;
        return false;
      }
      // success without PurchaseExecuted: the cancel was mined, or logs lag behind the receipt
      if (p.cancelling) {
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'CANCELLED', detail: `nonce ${p.nonce} freed by ${h}`, hash: h });
        this.block(job, p.window, 'TX_NOT_INCLUDED', `cancelled after the deadline: nonce ${p.nonce}`);
        job.pending = null;
        return false;
      }
      if (this.o.now() - p.preparedAt < this.o.pendingTimeoutMs) return true;
      this.o.onAlert({ kind: 'EXECUTOR_INVARIANT', jobId: job.id, detail: `${h} succeeded without a PurchaseExecuted for window ${p.window}` });
      job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'REVERTED', detail: 'success receipt without PurchaseExecuted', hash: h });
      job.pending = null;
      return false;
    }
    const n = await chain.nonces();
    if (n.latest > p.nonce) {
      job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'NONCE_USED_ELSEWHERE', detail: `nonce ${p.nonce} mined without a run for window ${p.window}`, hash: p.hash });
      this.block(job, p.window, 'TX_NOT_INCLUDED', `nonce ${p.nonce} used without a run`);
      job.pending = null;
      return false;
    }
    const sinceSend = this.o.now() - (p.lastSentAt ?? p.preparedAt);
    let inPool = false;
    for (const h of hashes) if (await chain.inMempool(h)) inPool = true;
    if (inPool) {
      // the node holds it: wait, replace, or cancel; never clear
      if (sinceSend < this.o.replaceAfterMs) return true;
      await this.replaceOrCancel(job);
      return true;
    }
    // no known hash (crashed between broadcast and storing it): the nonce count is the only signal
    if (!p.hash && n.pending > p.nonce && this.o.now() - p.preparedAt < this.o.pendingTimeoutMs) return true;
    if (p.hash && sinceSend < this.o.dropGraceMs) return true; // the RPC may not show a fresh broadcast yet
    job.attempts.push({ at: this.o.now(), window: p.window, outcome: p.hash ? 'DROPPED' : 'UNSENT', detail: `nonce ${p.nonce} not in the mempool`, hash: p.hash });
    this.block(job, p.window, 'TX_NOT_INCLUDED', `${p.hash ? 'dropped' : 'not sent'}: nonce ${p.nonce}`);
    this.o.onAlert({ kind: 'TX_NOT_INCLUDED', jobId: job.id, detail: `${p.hash ?? 'unsent'} nonce ${p.nonce}` });
    job.pending = null;
    return false;
  }

  /** Same nonce, higher gas price: the same call while its deadline holds, a 0-value self-transfer after it. */
  private async replaceOrCancel(job: KeeperJob) {
    const p = job.pending!;
    const { chain } = this.o;
    if ((p.replacements ?? 0) >= this.o.maxReplacements) {
      this.o.onAlert({ kind: 'STUCK_NONCE', jobId: job.id, detail: `nonce ${p.nonce} still pending after ${p.replacements} replacements` });
      return;
    }
    const current = await chain.gasPrice();
    const bumped = ((p.gasPrice ?? current) * this.o.feeBumpPercent + BigInt(99)) / BigInt(100);
    const gasPrice = bumped > current ? bumped : current;
    const t = (await chain.head()).timestamp;
    let hash: Hex;
    let outcome: 'REPLACED' | 'CANCEL_SENT';
    try {
      if (p.cancelling || t > p.run.deadline) {
        hash = await chain.sendCancel(p.nonce, gasPrice);
        outcome = 'CANCEL_SENT';
        p.cancelling = true;
      } else {
        const call: ExecuteCall = { authorization: job.authorization, ownerSignature: job.ownerSignature, run: { authorizationId: job.id, window: p.run.window, deadline: p.run.deadline, fees: p.run.fees, minOutFloors: p.run.minOutFloors } };
        hash = await chain.sendExecute(job.deployment.executor, call, p.nonce, BigInt(1_500_000), gasPrice);
        outcome = 'REPLACED';
      }
    } catch (e) {
      // e.g. "nonce too low": the nonce was just mined; the next reconcile sees it
      job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'REPLACED', detail: `replacement not accepted: ${(e as Error)?.message?.split('\n')[0]?.slice(0, 120) ?? 'error'}`, hash: p.hash });
      return;
    }
    p.hashes = [...new Set([...(p.hashes ?? []), ...(p.hash ? [p.hash] : []), hash])];
    p.hash = hash;
    p.gasPrice = gasPrice;
    p.lastSentAt = this.o.now();
    p.replacements = (p.replacements ?? 0) + 1;
    job.attempts.push({ at: this.o.now(), window: p.window, outcome, detail: `nonce ${p.nonce} at ${gasPrice} wei/gas`, hash });
  }

  /** One job. Returns when (ms) it should next be looked at. */
  private async step(job: KeeperJob): Promise<number> {
    const { chain, store, holder } = this.o;
    const nowMs = this.o.now();
    if (await this.reconcilePending(job)) {
      this.set(job, 'PENDING_TX', `nonce ${job.pending!.nonce}${job.pending!.hash ? ` ${job.pending!.hash}` : ''}`);
      return nowMs + 15_000;
    }
    const head = await chain.head();
    const t = head.timestamp;
    const st = await chain.getState(job.deployment.executor, job.authorization.owner, job.id);
    job.observed = { ...st, at: t };
    await this.checkReorgs(job, head.number);
    const live = job.confirmed.filter((c) => !c.reorged);
    if (st.runs !== live.length) {
      for (const l of await chain.purchases(job.deployment.executor, job.authorization.owner, job.id, job.fromBlock)) await this.recordRun(job, l);
    }
    // runs recorded INDETERMINATE (e.g. not yet minConfirmations deep) are verified again until they are decided
    for (const c of job.confirmed.filter((x) => !x.reorged && x.verification === 'INDETERMINATE')) await this.recordRun(job, c);
    const auth = job.authorization;
    this.account(job, st, t);
    const due = dcaRunDue(auth, st, t);
    if (due.state !== 'DUE') {
      this.set(job, due.state, null, due.nextDueAt);
      if (TERMINAL_STATES.includes(due.state)) return nowMs + 24 * 3600_000;
      return nowMs + Math.max(5_000, Number((due.nextDueAt ?? t) - t) * 1000 + 1_000);
    }
    const window = due.window!;
    const windowEnd = auth.schedule.startsAt + (window + ONE) * auth.schedule.periodSeconds;
    if (t + this.o.inclusionSlackSeconds >= windowEnd) {
      if (job.blocker?.window !== window) this.block(job, window, 'NOT_OBSERVED', 'first seen within the inclusion slack before the window boundary');
      this.set(job, 'DUE', 'too close to the window boundary; next window', windowEnd);
      return nowMs + Number(windowEnd - t) * 1000 + 1_000;
    }
    const gross = auth.schedule.amountPerRun;
    const funds = await chain.ownerFunds(auth, job.deployment.executor);
    if (funds.balance < gross || funds.allowance < gross) {
      this.set(job, 'FUNDING_SHORTAGE', `balance ${funds.balance}, allowance ${funds.allowance}, need ${gross} per run`);
      this.block(job, window, 'FUNDING_SHORTAGE', job.stateDetail);
      return nowMs + this.o.retryMs;
    }
    const plan = await planRun(chain, auth, this.o.slippageBps);
    if (!plan.ok) {
      // WAITING_PRICE: the market is above the owner's FIXED ceiling. The window is lost if it stays there.
      this.set(job, plan.reason, plan.detail);
      this.block(job, window, plan.reason, plan.detail);
      return nowMs + this.o.retryMs;
    }
    const call: ExecuteCall = {
      authorization: auth,
      run: { authorizationId: job.id, window, deadline: t + this.o.deadlineSeconds, fees: plan.fees, minOutFloors: plan.floors },
      ownerSignature: job.ownerSignature,
    };
    const sim = await chain.simulateExecute(job.deployment.executor, call);
    if (!sim.ok) {
      job.attempts.push({ at: nowMs, window, outcome: 'SIMULATION_REVERTED', detail: sim.reason });
      this.set(job, 'SIMULATION_REVERTED', sim.reason);
      this.block(job, window, 'SIMULATION_REVERTED', sim.reason);
      this.o.onAlert({ kind: 'SIMULATION_REVERTED', jobId: job.id, detail: sim.reason });
      return nowMs + this.o.retryMs;
    }
    if (this.o.mode === 'PAPER') {
      this.set(job, 'DUE', `PAPER: would send window ${window}, fees ${plan.fees.join('/')}, floors ${plan.floors.join('/')}, gas ${sim.gas}`);
      return nowMs + this.o.retryMs;
    }
    const gas = (sim.gas * this.o.gasHeadroomPercent) / BigInt(100);
    const gasPrice = await chain.gasPrice();
    const cost = gas * gasPrice;
    const keeperBalance = await chain.keeperBalance();
    if (keeperBalance < cost) {
      this.set(job, 'GAS_SHORTAGE', `keeper ${chain.keeper} has ${keeperBalance} wei, needs about ${cost}`);
      this.block(job, window, 'GAS_SHORTAGE', job.stateDetail);
      this.o.onAlert({ kind: 'GAS_SHORTAGE', jobId: job.id, detail: job.stateDetail! });
      return nowMs + this.o.retryMs;
    }
    // Write-ahead: durable record of what is about to be sent, with an atomically allocated nonce, BEFORE sending.
    job.pending = { window, from: lc(chain.keeper!), nonce: -1, hash: null, preparedAt: nowMs, run: { window, deadline: call.run.deadline, fees: plan.fees, minOutFloors: plan.floors } };
    this.set(job, 'PENDING_TX', 'write-ahead');
    const nonce = await store.writeAhead(job, holder, this.o.now(), (await chain.nonces()).latest);
    if (nonce === null) {
      job.pending = null;
      this.o.onAlert({ kind: 'LEASE_LOST', jobId: job.id, detail: 'lease lost before write-ahead; nothing sent' });
      return nowMs + 5_000;
    }
    job.pending.nonce = nonce;
    let hash: Hex;
    try {
      hash = await chain.sendExecute(job.deployment.executor, call, nonce, gas, gasPrice);
    } catch (e) {
      // Not known to have left: keep the write-ahead record; reconciliation resolves it by nonce (never re-sent blind).
      this.set(job, 'PENDING_TX', `send failed: ${(e as Error)?.name ?? 'error'}; reconciling nonce ${nonce}`);
      return nowMs + 15_000;
    }
    job.pending.hash = hash;
    job.pending.hashes = [hash];
    job.pending.gasPrice = gasPrice;
    job.pending.lastSentAt = this.o.now();
    this.set(job, 'PENDING_TX', `nonce ${nonce} ${hash}`);
    return nowMs + 15_000;
  }
}

/**
 * Fresh quotes for one run against the owner's ceilings. For each asset, the best SIGNED fee tier by QuoterV2; the
 * run is refused (WAITING_PRICE) when the best quote is below the ceiling minimum, NO_ROUTE when no signed tier
 * quotes. The keeper floor is max(ceiling minimum, quote × (1 − slippage)): it only ever raises the bound.
 */
export async function planRun(chain: Pick<KeeperChain, 'quote'>, auth: DcaAuthorization, slippageBps: number):
  Promise<{ ok: true; fees: number[]; floors: bigint[]; quotes: bigint[] } | { ok: false; reason: 'WAITING_PRICE' | 'NO_ROUTE'; detail: string }> {
  const legs = dcaLegAmounts(auth);
  const mins = dcaCeilingMinimums(auth);
  const fees: number[] = [];
  const floors: bigint[] = [];
  const quotes: bigint[] = [];
  for (const [i, a] of auth.assets.entries()) {
    let best: { fee: number; out: bigint } | null = null;
    for (const fee of auth.route.allowedFees) {
      const out = await chain.quote(auth.inputToken, a.asset, legs[i], fee);
      if (out !== null && (!best || out > best.out)) best = { fee, out };
    }
    if (!best) return { ok: false, reason: 'NO_ROUTE', detail: `${a.symbol} (${a.asset}): no signed fee tier quotes` };
    if (best.out < mins[i]) {
      return { ok: false, reason: 'WAITING_PRICE', detail: `${a.symbol}: best quote ${best.out} < ceiling minimum ${mins[i]} (ceiling ${a.maxPriceRaw} per whole token)` };
    }
    const floor = (best.out * BigInt(10_000 - slippageBps)) / BigInt(10_000);
    fees.push(best.fee);
    floors.push(floor > mins[i] ? floor : mins[i]);
    quotes.push(best.out);
  }
  return { ok: true, fees, floors, quotes };
}
