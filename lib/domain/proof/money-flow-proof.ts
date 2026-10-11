import { parseAbiItem, parseEventLogs, type Hex } from 'viem';
import { SETTLED_EVENT_ABI } from '@/lib/blockchain/redeem-settlement-event';

// -----------------------------------------------------------------------------
// Proof that BAG's money flows ran live, from transaction receipts only:
//   sale      a fee-paying sale: RedeemSettlement emitted Settled with fee > 0,
//             and USDG moved settlement → creator (the fee) and → user (the rest)
//   credit    a fork royalty: CreatorRewardsVault emitted Credited, and USDG
//             moved settler → vault for the same amount
//   withdraw  a creator withdrawal: the vault emitted Withdrawn, and USDG moved
//             vault → recipient for the same amount
// Each check passes only if the receipt succeeded, the event came from the
// configured contract, and the token movement matches the event exactly.
// Pure: the caller fetches the receipt.
// -----------------------------------------------------------------------------

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const CREDITED = parseAbiItem('event Credited(address indexed creator, uint256 amount, bytes32 indexed refId, address indexed settler)');
const WITHDRAWN = parseAbiItem('event Withdrawn(address indexed creator, address indexed to, uint256 amount)');

export interface ProofReceipt {
  status: 'success' | 'reverted';
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
}

export interface ProofCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProofResult {
  kind: 'sale' | 'credit' | 'withdraw';
  ok: boolean;
  checks: ProofCheck[];
  /** Raw USDG amounts and parties, for the report. */
  facts: Record<string, string>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function transfers(receipt: ProofReceipt, token: string) {
  const logs = receipt.logs.filter((l) => same(l.address, token));
  return parseEventLogs({ abi: [TRANSFER], logs: logs as never, strict: false }).map((e) => ({
    from: String(e.args.from ?? ''),
    to: String(e.args.to ?? ''),
    value: (e.args.value as bigint | undefined) ?? BigInt(0),
  }));
}

function finish(kind: ProofResult['kind'], checks: ProofCheck[], facts: Record<string, string>): ProofResult {
  return { kind, ok: checks.length > 0 && checks.every((c) => c.ok), checks, facts };
}

export function proveSale(receipt: ProofReceipt, o: { settlement: string; usdg: string; expectedCreator?: string }): ProofResult {
  const checks: ProofCheck[] = [{ name: 'TX_SUCCEEDED', ok: receipt.status === 'success', detail: receipt.status }];
  const mine = receipt.logs.filter((l) => same(l.address, o.settlement));
  const events = parseEventLogs({ abi: SETTLED_EVENT_ABI, logs: mine as never, eventName: 'Settled' });
  checks.push({ name: 'ONE_SETTLED_EVENT_FROM_SETTLEMENT', ok: events.length === 1, detail: `${events.length} event(s) from ${o.settlement}` });
  if (events.length !== 1) return finish('sale', checks, {});
  const e = events[0].args;
  const facts = {
    user: e.user,
    creator: e.creator,
    received: e.received.toString(),
    feeBase: e.feeBase.toString(),
    fee: e.fee.toString(),
    userProceeds: e.userProceeds.toString(),
  };
  checks.push({ name: 'POSITIVE_FEE', ok: e.fee > BigInt(0), detail: `fee ${e.fee} raw USDG on a fee base of ${e.feeBase}` });
  checks.push({ name: 'BUYER_IS_NOT_CREATOR', ok: !same(e.user, e.creator), detail: `user ${e.user}, creator ${e.creator}` });
  checks.push({ name: 'AMOUNTS_ADD_UP', ok: e.fee + e.userProceeds === e.received, detail: `${e.fee} + ${e.userProceeds} = ${e.received}` });
  if (o.expectedCreator) checks.push({ name: 'CREATOR_AS_EXPECTED', ok: same(e.creator, o.expectedCreator), detail: `event ${e.creator}, expected ${o.expectedCreator}` });
  const moved = transfers(receipt, o.usdg).filter((t) => same(t.from, o.settlement));
  const toCreator = moved.filter((t) => same(t.to, e.creator)).reduce((s, t) => s + t.value, BigInt(0));
  const toUser = moved.filter((t) => same(t.to, e.user)).reduce((s, t) => s + t.value, BigInt(0));
  checks.push({ name: 'FEE_PAID_TO_CREATOR_IN_USDG', ok: toCreator === e.fee, detail: `${toCreator} USDG transferred to the creator, event says ${e.fee}` });
  checks.push({ name: 'PROCEEDS_PAID_TO_USER_IN_USDG', ok: toUser === e.userProceeds, detail: `${toUser} USDG transferred to the user, event says ${e.userProceeds}` });
  return finish('sale', checks, facts);
}

export function proveCredit(receipt: ProofReceipt, o: { vault: string; usdg: string; expectedCreator?: string }): ProofResult {
  const checks: ProofCheck[] = [{ name: 'TX_SUCCEEDED', ok: receipt.status === 'success', detail: receipt.status }];
  const events = parseEventLogs({ abi: [CREDITED], logs: receipt.logs.filter((l) => same(l.address, o.vault)) as never });
  checks.push({ name: 'CREDITED_EVENT_FROM_VAULT', ok: events.length >= 1, detail: `${events.length} event(s) from ${o.vault}` });
  if (events.length === 0) return finish('credit', checks, {});
  const total = events.reduce((s, e) => s + e.args.amount, BigInt(0));
  const e = events[0].args;
  const facts = { creator: e.creator, amount: total.toString(), refId: e.refId, settler: e.settler };
  checks.push({ name: 'POSITIVE_AMOUNT', ok: total > BigInt(0), detail: `${total} raw USDG` });
  if (o.expectedCreator) checks.push({ name: 'CREATOR_AS_EXPECTED', ok: events.every((x) => same(x.args.creator, o.expectedCreator!)), detail: `event ${e.creator}, expected ${o.expectedCreator}` });
  const funded = transfers(receipt, o.usdg).filter((t) => same(t.to, o.vault)).reduce((s, t) => s + t.value, BigInt(0));
  checks.push({ name: 'VAULT_FUNDED_IN_USDG', ok: funded === total, detail: `${funded} USDG transferred into the vault, credited ${total}` });
  return finish('credit', checks, facts);
}

export function proveWithdraw(receipt: ProofReceipt, o: { vault: string; usdg: string; expectedCreator?: string }): ProofResult {
  const checks: ProofCheck[] = [{ name: 'TX_SUCCEEDED', ok: receipt.status === 'success', detail: receipt.status }];
  const events = parseEventLogs({ abi: [WITHDRAWN], logs: receipt.logs.filter((l) => same(l.address, o.vault)) as never });
  checks.push({ name: 'ONE_WITHDRAWN_EVENT_FROM_VAULT', ok: events.length === 1, detail: `${events.length} event(s) from ${o.vault}` });
  if (events.length !== 1) return finish('withdraw', checks, {});
  const e = events[0].args;
  const facts = { creator: e.creator, to: e.to, amount: e.amount.toString() };
  checks.push({ name: 'POSITIVE_AMOUNT', ok: e.amount > BigInt(0), detail: `${e.amount} raw USDG` });
  if (o.expectedCreator) checks.push({ name: 'CREATOR_AS_EXPECTED', ok: same(e.creator, o.expectedCreator), detail: `event ${e.creator}, expected ${o.expectedCreator}` });
  const paid = transfers(receipt, o.usdg).filter((t) => same(t.from, o.vault) && same(t.to, e.to)).reduce((s, t) => s + t.value, BigInt(0));
  checks.push({ name: 'PAID_OUT_IN_USDG', ok: paid === e.amount, detail: `${paid} USDG transferred to ${e.to}, event says ${e.amount}` });
  return finish('withdraw', checks, facts);
}
