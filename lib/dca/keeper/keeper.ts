import type { Hex } from 'viem';
import { BagSdkError } from '../../../packages/bag-sdk/src/errors';
import {
  recurringAuthorizationId,
  recurringAuthorizationTypedData,
  recurringWindowAt,
  verifyRecurringPurchaseReceipt,
  type RecurringAuthorization,
} from '../../../packages/bag-sdk/src/recurring';
import { buildRecurringRunPlan, type RouterExecutionPlan } from '../../../packages/bag-sdk/src/adapters/uniswap-v3';
import { KeeperRpcError, type KeeperChain } from './chain';
import type { KeeperStore } from './store';
import { TERMINAL_STATES, type ChainExecutionState, type KeeperJob, type KeeperJobState } from './types';

/** Signs a BagExecutionRouter plan (server-side planSigner). The keeper never sees the key. */
export type PlanSigner = (plan: RouterExecutionPlan, router: Hex) => Promise<Hex>;

export interface KeeperOptions {
  store: KeeperStore;
  chain: KeeperChain;
  signPlan: PlanSigner;
  quoter: Hex;
  /** Identifies this process in job leases. */
  holder: string;
  leaseMs?: number;
  /** Quote slippage below the fresh quote (never below the owner's limit). Default 100 bps. */
  slippageBps?: number;
  quoteTtlSeconds?: bigint;
  /** Gas cost safety factor in percent over the estimate. Default 130. */
  gasHeadroomPercent?: bigint;
  /** A pending transaction whose nonce is still unused after this long is treated as dropped. Default 15 min. */
  pendingTimeoutMs?: number;
  /** Expected seconds until inclusion: no transaction is sent this close before a window boundary (it would land in the
   *  next window and revert with WrongWindow). Default 60. */
  inclusionSlackSeconds?: bigint;
  now?: () => number;
}

const NEXT = (s: bigint, a: bigint) => (s > a ? s : a);

/**
 * Derives what a job is waiting for from the executor's counters alone. Same rules as the executor's `_reserve`:
 * one purchase per calendar window, at least one period between purchases, no catch-up of missed windows.
 */
export function deriveState(auth: RecurringAuthorization, chain: ChainExecutionState, t: bigint): { state: KeeperJobState; nextDueAt: bigint | null; window: bigint | null } {
  const s = auth.schedule;
  if (chain.revoked) return { state: 'REVOKED', nextDueAt: null, window: null };
  if (chain.executions >= s.maxExecutions || chain.grossUsed + s.grossAmountPerRun > s.totalBudget) return { state: 'COMPLETED', nextDueAt: null, window: null };
  if (t >= s.expiresAt) return { state: 'EXPIRED', nextDueAt: null, window: null };
  if (t < s.startsAt) return { state: 'SCHEDULED', nextDueAt: s.startsAt, window: null };
  const window = recurringWindowAt(auth, t)!;
  if (chain.executions > 0 && (window <= chain.lastWindow || t < chain.lastExecutionAt + s.periodSeconds)) {
    const next = NEXT(s.startsAt + (chain.lastWindow + BigInt(1)) * s.periodSeconds, chain.lastExecutionAt + s.periodSeconds);
    return next >= s.expiresAt ? { state: 'EXPIRED', nextDueAt: null, window } : { state: 'DONE_THIS_WINDOW', nextDueAt: next, window };
  }
  return { state: 'DUE', nextDueAt: null, window };
}

export class RecurringKeeper {
  private readonly o: Required<Omit<KeeperOptions, 'now'>> & { now: () => number };
  constructor(options: KeeperOptions) {
    this.o = { leaseMs: 120_000, slippageBps: 100, quoteTtlSeconds: BigInt(300), gasHeadroomPercent: BigInt(130), pendingTimeoutMs: 15 * 60_000, inclusionSlackSeconds: BigInt(60), now: () => Date.now(), ...options };
  }

  /**
   * Adds a signed authorization. The id is recomputed and the owner's signature checked (EOA or ERC-1271 through the
   * chain's client) before anything is stored. Adding the same id again keeps the existing record.
   */
  async addJob(input: { authorization: RecurringAuthorization; ownerSignature: Hex; fundingProof?: Hex | null; deployment: { chainId: number; executor: Hex; router: Hex } }): Promise<KeeperJob> {
    const { authorization: auth, deployment } = input;
    const id = recurringAuthorizationId(auth, deployment);
    if (auth.route.router.toLowerCase() !== deployment.router.toLowerCase()) throw new BagSdkError('RECURRING_TERMS_INVALID', 'the authorization names another router.');
    const ok = await this.o.chain.verifyOwnerSignature(auth.owner, recurringAuthorizationTypedData(auth, deployment), input.ownerSignature);
    if (!ok) throw new BagSdkError('RECURRING_TERMS_INVALID', 'the owner signature does not match the authorization.');
    const existing = await this.o.store.get(id);
    if (existing) return existing;
    const job: KeeperJob = {
      id,
      deployment: { chainId: deployment.chainId, executor: deployment.executor.toLowerCase() as Hex, router: deployment.router.toLowerCase() as Hex },
      authorization: auth,
      ownerSignature: input.ownerSignature,
      fundingProof: input.fundingProof ?? null,
      createdAt: this.o.now(),
      fromBlock: await this.o.chain.latestBlock(),
      state: 'SCHEDULED',
      stateDetail: null,
      nextDueAt: null,
      observed: null,
      pending: null,
      confirmed: [],
      attempts: [],
      lease: null,
    };
    await this.o.store.put(job);
    return job;
  }

  /** One pass over every non-terminal job this process can lease. Returns the jobs after the pass. */
  async tick(): Promise<KeeperJob[]> {
    const out: KeeperJob[] = [];
    for (const listed of await this.o.store.list()) {
      if (TERMINAL_STATES.includes(listed.state) && !listed.pending) {
        out.push(listed);
        continue;
      }
      if (!(await this.o.store.claim(listed.id, this.o.holder, this.o.now(), this.o.leaseMs))) continue;
      const job = (await this.o.store.get(listed.id))!;
      try {
        await this.step(job);
      } catch (e) {
        if (!(e instanceof KeeperRpcError)) throw e;
        this.set(job, 'RPC_ERROR', e.operation);
        await this.o.store.put(job);
      } finally {
        await this.o.store.release(job.id, this.o.holder);
      }
      out.push((await this.o.store.get(job.id))!);
    }
    return out;
  }

  private set(job: KeeperJob, state: KeeperJobState, detail: string | null = null, nextDueAt: bigint | null = null) {
    job.state = state;
    job.stateDetail = detail;
    job.nextDueAt = nextDueAt;
  }

  private async observe(job: KeeperJob): Promise<{ chain: ChainExecutionState; t: bigint }> {
    const { chain } = this.o;
    const [state, t] = [await chain.getState(job.deployment.executor, job.authorization.owner, job.id), await chain.latestTimestamp()];
    job.observed = { ...state, at: t };
    return { chain: state, t };
  }

  private async recordConfirmed(job: KeeperJob, hash: Hex, window: bigint, executionIndex: bigint | null, blockNumber: bigint) {
    if (job.confirmed.some((c) => c.hash.toLowerCase() === hash.toLowerCase())) return;
    const v = await verifyRecurringPurchaseReceipt({ client: this.o.chain.receiptClient, transactionHash: hash, auth: job.authorization, deployment: job.deployment });
    job.confirmed.push({ window, executionIndex: v.executionIndex ?? executionIndex, hash, blockNumber, verification: v.status, issues: v.issues.map((i) => `${i.code}: ${i.detail}`) });
    job.fundingProof = null; // a permit is single-use; later runs rely on the remaining allowance
  }

  /** Resolves a write-ahead record against the chain. Returns true while the transaction may still be in flight. */
  private async reconcilePending(job: KeeperJob): Promise<boolean> {
    const p = job.pending;
    if (!p) return false;
    const { chain } = this.o;
    const logged = (await chain.executions(job.deployment.executor, job.authorization.owner, job.id, job.fromBlock)).find((l) => l.window === p.window);
    if (logged) {
      await this.recordConfirmed(job, logged.hash, logged.window, logged.executionIndex, logged.blockNumber);
      if (p.hash && p.hash.toLowerCase() !== logged.hash.toLowerCase()) {
        // another keeper's transaction bought this window; ours (if mined) reverted on the executor's window check
        const own = await chain.receipt(p.hash);
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: own?.status === 'reverted' ? 'REVERTED' : 'NONCE_USED_ELSEWHERE', detail: `window ${p.window} was bought by ${logged.hash}`, hash: p.hash });
      }
      job.pending = null;
      return false;
    }
    if (p.hash) {
      const r = await chain.receipt(p.hash);
      if (r?.status === 'reverted') {
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'REVERTED', detail: 'mined and reverted; no counter changed', hash: p.hash });
        job.pending = null;
        return false;
      }
      if (r?.status === 'success') {
        // success but no PurchaseExecuted for this window would be an executor bug; never re-send for it
        job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'REVERTED', detail: 'receipt success without a PurchaseExecuted event for this window', hash: p.hash });
        job.pending = null;
        return false;
      }
    }
    const n = await chain.nonces();
    if (n.latest > p.nonce) {
      // the nonce is used but not by a purchase of this window: our tx reverted or was replaced
      job.attempts.push({ at: this.o.now(), window: p.window, outcome: 'NONCE_USED_ELSEWHERE', detail: `nonce ${p.nonce} mined without a purchase for window ${p.window}`, hash: p.hash });
      job.pending = null;
      return false;
    }
    if (n.pending > p.nonce && this.o.now() - p.preparedAt < this.o.pendingTimeoutMs) return true;
    job.attempts.push({ at: this.o.now(), window: p.window, outcome: p.hash ? 'DROPPED' : 'UNSENT', detail: `nonce ${p.nonce} not in the mempool`, hash: p.hash });
    job.pending = null;
    return false;
  }

  private async step(job: KeeperJob): Promise<void> {
    const { chain, store } = this.o;
    if (await this.reconcilePending(job)) {
      await this.observe(job);
      this.set(job, 'PENDING_TX', `nonce ${job.pending!.nonce}${job.pending!.hash ? ` ${job.pending!.hash}` : ''}`);
      await store.put(job);
      return;
    }
    const { chain: counters, t } = await this.observe(job);
    // Backfill runs another keeper (or a crashed one) sent: the chain's events are the record.
    if (counters.executions > job.confirmed.length) {
      for (const l of await chain.executions(job.deployment.executor, job.authorization.owner, job.id, job.fromBlock)) await this.recordConfirmed(job, l.hash, l.window, l.executionIndex, l.blockNumber);
    }
    const auth = job.authorization;
    // The same clock as the pre-flight eth_call (latest block), so the keeper and the executor agree on due-ness.
    const derived = deriveState(auth, counters, t);
    if (derived.state !== 'DUE') {
      this.set(job, derived.state, null, derived.nextDueAt);
      await store.put(job);
      return;
    }
    const landing = recurringWindowAt(auth, t + this.o.inclusionSlackSeconds);
    if (landing !== derived.window) {
      this.set(job, 'DUE', 'too close to the window boundary to send; retried in the next window', auth.schedule.startsAt + (derived.window! + BigInt(1)) * auth.schedule.periodSeconds);
      await store.put(job);
      return;
    }
    const gross = auth.schedule.grossAmountPerRun;
    const funds = await chain.ownerFunds(auth, job.deployment.executor);
    if (funds.balance < gross || (funds.allowance < gross && !job.fundingProof)) {
      this.set(job, 'FUNDING_SHORTAGE', `balance ${funds.balance}, allowance ${funds.allowance}, need ${gross} per run`);
      await store.put(job);
      return;
    }
    let run;
    try {
      run = await buildRecurringRunPlan({ client: chain.quoteClient, auth, deployment: job.deployment, quoter: this.o.quoter, nowSeconds: t, quoteTtlSeconds: this.o.quoteTtlSeconds, slippageBps: this.o.slippageBps });
    } catch (e) {
      if (e instanceof BagSdkError && (e.code === 'PRICE_LIMIT_NOT_MET' || e.code === 'NO_ROUTE')) {
        this.set(job, e.code === 'NO_ROUTE' ? 'NO_ROUTE' : 'WAITING_PRICE', e.message);
        await store.put(job);
        return;
      }
      if (e instanceof BagSdkError && e.code === 'RPC_READ_FAILED') throw new KeeperRpcError('quote');
      throw e;
    }
    const call = {
      authorization: auth,
      execution: { ...run.execution, plan: run.plan, planSignature: await this.o.signPlan(run.plan, job.deployment.router) },
      ownerSignature: job.ownerSignature,
      fundingProof: (funds.allowance < gross ? job.fundingProof : null) ?? ('0x' as Hex),
    };
    const sim = await chain.simulateExecute(job.deployment.executor, call);
    if (!sim.ok) {
      job.attempts.push({ at: this.o.now(), window: derived.window, outcome: 'SIMULATION_REVERTED', detail: sim.reason });
      this.set(job, 'SIMULATION_REVERTED', sim.reason);
      await store.put(job);
      return;
    }
    const gas = (sim.gas * this.o.gasHeadroomPercent) / BigInt(100);
    const cost = gas * (await chain.gasPrice());
    if ((await chain.keeperBalance()) < cost) {
      this.set(job, 'GAS_SHORTAGE', `keeper ${chain.keeper} needs about ${cost} wei for ${gas} gas`);
      await store.put(job);
      return;
    }
    // Write-ahead: the record of what is about to be sent is durable BEFORE it is sent.
    const nonce = (await chain.nonces()).pending;
    job.pending = { window: run.execution.window, from: chain.keeper, nonce, hash: null, preparedAt: this.o.now() };
    this.set(job, 'PENDING_TX', `nonce ${nonce}`);
    await store.put(job);
    const hash = await chain.sendExecute(job.deployment.executor, call, nonce, gas);
    job.pending.hash = hash;
    this.set(job, 'PENDING_TX', `nonce ${nonce} ${hash}`);
    await store.put(job);
  }
}
