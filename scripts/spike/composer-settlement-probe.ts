/**
 * P1 — LI.FI Composer → contract call probe on Robinhood Chain (4663). SPIKE ONLY: changes no app code, never
 * imported by the application. Plan: docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §6.
 *
 * Target: contracts/spike/ComposerSettlementProbe.sol (deploy it with scripts/spike/deploy-composer-probe.ts). It
 * records msg.sender, tx.origin, the calldata amount, its allowance, how the tokens arrived and how much, then
 * forwards everything to the recipient. No fee, no vault, no BAG router.
 *
 * DEFAULT = COMPILE ONLY. Nothing is signed or sent; no key is read. Composer compiles each flow and simulates it
 * against the live chain (simulationPolicy 'strict', simulateUserProgram). Flows:
 *   T   pull     USDG → core.call probe (resource + inline approval to the probe; amount = the USDG resource)
 *   P   push     USDG → core.transfer to the probe → core.call probe without a resource (amount 0)
 *   S   swap     --swap-token → lifi.swap → USDG → core.call probe (amount = the swap's runtime output)
 *   R   revert   like T with minReceived = amount + 1: the simulation must revert (atomicity)
 *   T2  repeat   T compiled again: is userProxy the same address for the same signer?
 * Every probe call sends to `context.sender`, so the event's `recipient` also shows what that resolves to.
 *
 *   npx tsx scripts/spike/composer-settlement-probe.ts --signer 0xWALLET --probe 0xPROBE \
 *     [--usdg-amount 1000000] [--swap-token 0xTOKEN --swap-amount <raw>]
 *
 * The signer must hold the USDG (and the swap token, for S): the server simulates the real transaction.
 *
 * --send T|P|S additionally broadcasts that ONE flow from a DISPOSABLE wallet, only if ALL are set:
 *   PROBE_PRIVATE_KEY     disposable key (env only; never printed or written; its address must equal --signer)
 *   PROBE_CONFIRM         must equal I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS
 *   PROBE_MAX_INPUT_RAW   hard cap on the flow's input amount (raw units)
 *   PROBE_ALLOWED_ADDRESS the deployed probe; --probe must equal it (a wrong .env cannot send funds elsewhere)
 * and it checks the chain id, the probe's token (USDG) and that the probe address is in the compiled calldata.
 * Order: --send T first (msg.sender, allowance, delivery model), then --send S — P1 is complete only when S passes.
 * It sends exactly the approvals the compile returned (only for the input token, never above the input), pre-checks
 * the transaction with eth_call (revoking those approvals if it would revert), sends it, and reads the answers from
 * the receipt and from chain state afterwards.
 *
 * Env: LIFI_API_KEY (required), ROBINHOOD_RPC_URL / RPC_URL_ROBINHOOD (optional; never printed).
 * Output: stdout + reports/composer-settlement-probe.json (no secrets). Never claims a result it did not observe.
 */
import '../load-env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createComposeSdk, guards, isComposeError, materialisers, resources } from '@lifi/composer-sdk';
import type { ComposeCompileResult } from '@lifi/compose-spec';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, getAddress, http, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_REWARD_TOKEN, ROBINHOOD_RPC_URL } from '../../lib/config/robinhood-chain';
import { redactRpcUrl } from '../../lib/domain/basket-protocol/redeem/fee-router-executability';

const CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS';
const USDG = ROBINHOOD_REWARD_TOKEN.address as `0x${string}`;
const PROBE_SIG = 'function probe(address recipient, uint256 amount, uint256 minReceived) returns (uint256)';
const PROBE_EVENT_ABI = [
  {
    type: 'event',
    name: 'Probed',
    inputs: [
      { name: 'msgSender', type: 'address', indexed: true },
      { name: 'txOrigin', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amountArg', type: 'uint256', indexed: false },
      { name: 'pushedBeforeCall', type: 'uint256', indexed: false },
      { name: 'allowanceBefore', type: 'uint256', indexed: false },
      { name: 'pulled', type: 'uint256', indexed: false },
      { name: 'received', type: 'uint256', indexed: false },
      { name: 'allowanceAfter', type: 'uint256', indexed: false },
    ],
  },
] as const;

type Variant = 'T' | 'P' | 'S' | 'R' | 'T2';
const isAddress = (v: string | undefined): v is `0x${string}` => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);
const isRaw = (v: string | undefined): v is string => !!v && /^\d+$/.test(v) && BigInt(v) > BigInt(0);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const rpcUrl = ROBINHOOD_RPC_URL;
const scrub = (s: string) => s.split(rpcUrl).join(redactRpcUrl(rpcUrl));
const report: Record<string, unknown> = { at: new Date().toISOString(), chainId: ROBINHOOD_CHAIN_ID, rpc: redactRpcUrl(rpcUrl), compiles: {} as Record<string, unknown> };

function finish(code: number, final: string): never {
  report.final = final;
  const out = resolve(process.cwd(), 'reports/composer-settlement-probe.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\nFINAL: ${final}\nEvidence: ${out}`);
  process.exit(code);
}

interface FlowSpec {
  variant: Variant;
  inputToken: `0x${string}`;
  inputAmount: bigint;
}

async function compileFlow(sdk: ReturnType<typeof createComposeSdk>, signer: `0x${string}`, probe: `0x${string}`, spec: FlowSpec): Promise<ComposeCompileResult> {
  const { variant } = spec;
  const minReceived = variant === 'R' ? spec.inputAmount + BigInt(1) : BigInt(0);
  const b = sdk.flow(ROBINHOOD_CHAIN_ID, {
    name: `composer-settlement-probe-${variant}`,
    inputs: { amountIn: resources.erc20(spec.inputToken, ROBINHOOD_CHAIN_ID), probeAddress: 'address', zero: 'uint256', minReceived: 'uint256' },
  } as const);

  if (variant === 'P') {
    b.core.transfer('push', { bind: { amount: b.inputs.amountIn, recipient: b.inputs.probeAddress }, config: {} });
    b.core.call('probe', {
      bind: { recipient: b.context.sender, amount: b.inputs.zero, minReceived: b.inputs.minReceived } as never,
      config: { target: probe, functionSignature: PROBE_SIG },
    });
  } else {
    let usdg = b.inputs.amountIn as Parameters<typeof b.core.call>[1]['resource'];
    if (variant === 'S') {
      const swap = b.lifi.swap('swap', {
        bind: { amountIn: b.inputs.amountIn },
        config: { resourceOut: { kind: 'erc20', token: USDG, chainId: ROBINHOOD_CHAIN_ID }, slippage: 0.01 },
        guards: [guards.slippage({ port: 'unspentIn', bps: 100 })],
      });
      usdg = swap.amountOut;
    }
    b.core.call('probe', {
      resource: usdg,
      bind: { recipient: b.context.sender, amount: usdg, minReceived: b.inputs.minReceived } as never,
      config: { target: probe, functionSignature: PROBE_SIG, approvals: [{ spender: probe }] },
    });
  }

  return b.compile({
    signer,
    inputs: {
      amountIn: materialisers.directDeposit({ amount: spec.inputAmount }),
      probeAddress: probe,
      zero: '0',
      minReceived: minReceived.toString(),
    } as never,
    // Composer refuses sweepTo when nothing is left on the proxy to sweep ("no proxy-held terminal resources"): T/R/T2's
    // core.call consumes the whole USDG. P (transfer remainder) and S (the swap's unspent input) leave something.
    ...(variant === 'P' || variant === 'S' ? { sweepTo: { $ref: 'context.sender' } } : {}),
    simulationPolicy: 'strict',
    simulateUserProgram: true,
    checkOnChainAllowances: false,
  } as never);
}

function summarize(r: ComposeCompileResult, probe: string, inputAmount: bigint) {
  const data = (r.transactionRequest?.data ?? '').toLowerCase();
  return {
    status: r.status,
    ...(r.status === 'partial' ? { error: r.error } : {}),
    userProxy: r.userProxy,
    txTo: r.transactionRequest?.to ?? null,
    value: r.transactionRequest?.value ?? '0',
    gasLimit: r.transactionRequest?.gasLimit ?? null,
    calldataBytes: data ? (data.length - 2) / 2 : 0,
    probeAddressInCalldata: data.includes(probe.slice(2).toLowerCase()),
    inputAmountInCalldata: data.includes(inputAmount.toString(16).padStart(64, '0')),
    approvals: (r.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, amount: a.amount })),
    producedResources: Object.fromEntries(Object.entries(r.producedResources ?? {}).map(([k, v]) => [k, { availability: v.availability, owner: v.owner, simulated: v.simulated }])),
    userProgramSimulation: (r as { userProgramSimulation?: { status: string } }).userProgramSimulation?.status ?? null,
    actions: (r as { actions?: unknown[] }).actions?.length ?? 0,
  };
}

function describeError(e: unknown) {
  if (isComposeError(e)) return { code: e.code, kind: e.kind ?? null, status: e.status ?? null, message: scrub(e.message).slice(0, 500), revert: e.details ?? null };
  return { code: 'UNKNOWN', message: scrub((e as Error).message ?? String(e)).slice(0, 500) };
}

async function main() {
  const apiKey = process.env.LIFI_API_KEY;
  const signer = arg('signer');
  const probe = arg('probe');
  const usdgAmount = arg('usdg-amount') ?? '1000000';
  const swapToken = arg('swap-token');
  const swapAmount = arg('swap-amount');
  const send = arg('send') as Variant | undefined;
  if (!apiKey) finish(2, 'BLOCKED: LIFI_API_KEY is not set (Composer rejects unauthenticated requests).');
  if (!isAddress(signer) || !isAddress(probe)) finish(2, 'BLOCKED: pass --signer 0x… and --probe 0x… (the deployed ComposerSettlementProbe).');
  if (!isRaw(usdgAmount)) finish(2, 'BLOCKED: --usdg-amount must be a positive raw integer (6 decimals: 1000000 = 1 USDG).');
  if (swapToken !== undefined && (!isAddress(swapToken) || !isRaw(swapAmount))) finish(2, 'BLOCKED: --swap-token needs an address and --swap-amount a positive raw integer.');
  if (send !== undefined && !['T', 'P', 'S'].includes(send)) finish(2, 'BLOCKED: --send takes T, P or S.');
  if (send === 'S' && !swapToken) finish(2, 'BLOCKED: --send S needs --swap-token and --swap-amount.');

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId().catch((e: Error) => finish(2, `RPC_UNREACHABLE: ${scrub(e.message.split('\n')[0])}`));
  if (chainId !== ROBINHOOD_CHAIN_ID) finish(2, `RPC_WRONG_CHAIN: ${chainId}, expected ${ROBINHOOD_CHAIN_ID}.`);
  if (!(await pub.getCode({ address: probe }))) finish(2, `PROBE_NOT_DEPLOYED: no code at ${probe} on chain ${chainId}.`);
  const probeToken = (await pub.readContract({ address: probe, abi: [{ type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const, functionName: 'token' })) as string;
  if (probeToken.toLowerCase() !== USDG.toLowerCase()) finish(2, `PROBE_WRONG_TOKEN: probe forwards ${probeToken}, not USDG.`);
  report.signer = getAddress(signer);
  report.probe = getAddress(probe);

  const sdk = createComposeSdk({ baseUrl: 'https://composer.li.quest', apiKey });

  // Question 1a: is Robinhood Chain a listed Composer chain at all?
  try {
    const chains = await sdk.getSupportedChains();
    report.robinhoodListed = chains.some((c) => c.chainId === ROBINHOOD_CHAIN_ID);
    console.log(`Composer chains: ${chains.length}; Robinhood Chain (${ROBINHOOD_CHAIN_ID}) listed: ${report.robinhoodListed}`);
  } catch (e) {
    report.robinhoodListed = null;
    report.getChainsError = describeError(e);
    console.log(`getChains failed: ${JSON.stringify(report.getChainsError)}`);
  }

  const specs: FlowSpec[] = [
    { variant: 'T', inputToken: USDG, inputAmount: BigInt(usdgAmount) },
    { variant: 'P', inputToken: USDG, inputAmount: BigInt(usdgAmount) },
    ...(swapToken ? [{ variant: 'S' as const, inputToken: swapToken as `0x${string}`, inputAmount: BigInt(swapAmount as string) }] : []),
    { variant: 'R', inputToken: USDG, inputAmount: BigInt(usdgAmount) },
    { variant: 'T2', inputToken: USDG, inputAmount: BigInt(usdgAmount) },
  ];
  const compiles = report.compiles as Record<string, unknown>;
  for (const spec of specs) {
    try {
      const r = await compileFlow(sdk, signer, probe, spec);
      compiles[spec.variant] = { ok: r.status === 'success', ...summarize(r, probe, spec.inputAmount) };
    } catch (e) {
      compiles[spec.variant] = { ok: false, error: describeError(e) };
    }
    console.log(`\n[${spec.variant}] ${JSON.stringify(compiles[spec.variant], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
  const t = compiles.T as { ok?: boolean; userProxy?: string } | undefined;
  const t2 = compiles.T2 as { ok?: boolean; userProxy?: string } | undefined;
  const r = compiles.R as { ok?: boolean; error?: { kind?: string } } | undefined;
  report.compileAnswers = {
    'core.call builds on Robinhood (T)': t?.ok ?? false,
    'push model builds (P)': (compiles.P as { ok?: boolean })?.ok ?? false,
    'swap output into core.call builds (S)': swapToken ? ((compiles.S as { ok?: boolean })?.ok ?? false) : 'not run',
    // Only a simulation revert counts: R failing for any other reason (e.g. request validation) proves nothing.
    'a reverting probe call fails the whole simulation (R)': r ? !r.ok && /revert/.test(r.error?.kind ?? '') : 'not run',
    'R failure kind': r?.error?.kind ?? null,
    'userProxy same across compiles (T vs T2)': t?.userProxy && t2?.userProxy ? t.userProxy.toLowerCase() === t2.userProxy.toLowerCase() : null,
  };
  console.log(`\nCompile answers: ${JSON.stringify(report.compileAnswers, null, 2)}`);

  if (!send) finish(0, 'COMPILE_ONLY: nothing was signed or sent. msg.sender / tx.origin / delivery model need --send (one tiny transaction).');
  await sendOne(pub, sdk, signer, probe, specs.find((s) => s.variant === send)!);
}

async function sendOne(pub: ReturnType<typeof createPublicClient>, sdk: ReturnType<typeof createComposeSdk>, signer: `0x${string}`, probe: `0x${string}`, spec: FlowSpec) {
  const key = process.env.PROBE_PRIVATE_KEY as Hex | undefined;
  const cap = process.env.PROBE_MAX_INPUT_RAW;
  const allowedProbe = process.env.PROBE_ALLOWED_ADDRESS;
  if (!key || process.env.PROBE_CONFIRM !== CONFIRM_PHRASE || !isRaw(cap) || !isAddress(allowedProbe)) {
    finish(2, `SEND_REFUSED: set PROBE_PRIVATE_KEY, PROBE_CONFIRM=${CONFIRM_PHRASE}, PROBE_MAX_INPUT_RAW and PROBE_ALLOWED_ADDRESS.`);
  }
  // Funds only ever go to the one probe the operator deployed and pinned; chain id and the probe's token (USDG) were
  // already checked on-chain in main().
  if (allowedProbe.toLowerCase() !== probe.toLowerCase()) finish(2, `SEND_REFUSED: --probe ${probe} is not PROBE_ALLOWED_ADDRESS ${allowedProbe}.`);
  if (spec.inputAmount > BigInt(cap)) finish(2, `SEND_REFUSED: input ${spec.inputAmount} is above PROBE_MAX_INPUT_RAW ${cap}.`);
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== signer.toLowerCase()) finish(2, 'SEND_REFUSED: PROBE_PRIVATE_KEY does not belong to --signer.');

  // Fresh compile: quotes expire.
  let r: ComposeCompileResult;
  try {
    r = await compileFlow(sdk, signer, probe, spec);
  } catch (e) {
    finish(1, `SEND_COMPILE_FAILED: ${JSON.stringify(describeError(e))}`);
  }
  if (r.status !== 'success' || !r.transactionRequest) finish(1, 'SEND_COMPILE_FAILED: no successful transaction.');
  const tx = r.transactionRequest;
  if (BigInt(tx.value ?? '0') !== BigInt(0)) finish(1, 'VALIDATION_FAILED: the transaction would spend native ETH.');
  if (tx.chainId !== undefined && Number(tx.chainId) !== ROBINHOOD_CHAIN_ID) finish(1, `VALIDATION_FAILED: transaction is for chain ${tx.chainId}.`);
  if (!tx.data.toLowerCase().includes(probe.slice(2).toLowerCase())) finish(1, 'VALIDATION_FAILED: the probe address does not appear in the compiled calldata.');
  const approvals = (r.approvals ?? []).map((a) => ({ token: a.token as `0x${string}`, spender: a.spender as `0x${string}`, amount: BigInt(a.amount) }));
  for (const a of approvals) {
    if (a.token.toLowerCase() !== spec.inputToken.toLowerCase()) finish(1, `VALIDATION_FAILED: approval asked for ${a.token}, not the input token.`);
    if (!isAddress(a.spender) || a.amount > spec.inputAmount) finish(1, 'VALIDATION_FAILED: approval spender invalid or amount above the input.');
  }

  const chain = defineChain({ id: ROBINHOOD_CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const bal = (token: `0x${string}`, owner: `0x${string}`) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const allowance = (token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
  const before = { usdg: await bal(USDG, signer), input: await bal(spec.inputToken, signer) };

  const sent: Record<string, unknown> = { variant: spec.variant, userProxy: r.userProxy, txTo: tx.to, approvals };
  report.send = sent;
  for (const a of approvals) {
    if ((await allowance(a.token, signer, a.spender)) >= a.amount) continue;
    const h = await wallet.writeContract({ address: a.token, abi: erc20Abi, functionName: 'approve', args: [a.spender, a.amount] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`approval ${a.spender} ${a.amount}: ${h}`);
  }

  try {
    await pub.call({ account: signer, to: tx.to as `0x${string}`, data: tx.data as Hex, value: BigInt(0) });
  } catch (e) {
    for (const a of approvals) await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: a.token, abi: erc20Abi, functionName: 'approve', args: [a.spender, BigInt(0)] }) });
    finish(1, `PRECHECK_REVERTED (approvals revoked, nothing else sent): ${scrub((e as Error).message.split('\n')[0])}`);
  }

  const hash = await wallet.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as Hex, value: BigInt(0) });
  sent.txHash = hash;
  console.log(`sent: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  sent.status = receipt.status;
  sent.blockNumber = receipt.blockNumber;
  sent.receiptFrom = receipt.from;
  sent.receiptTo = receipt.to;
  if (receipt.status !== 'success') finish(1, `TX_REVERTED: ${hash} (atomic: check that no token left the wallet).`);

  const probed = parseEventLogs({ abi: PROBE_EVENT_ABI, logs: receipt.logs.filter((l) => l.address.toLowerCase() === probe.toLowerCase()), eventName: 'Probed' });
  if (probed.length !== 1) finish(1, `UNEXPECTED: ${probed.length} Probed events in ${hash}.`);
  const e = probed[0].args;
  const after = { usdg: await bal(USDG, signer), input: await bal(spec.inputToken, signer) };
  const leftover = {
    probeUsdgBalance: await bal(USDG, probe),
    allowanceMsgSenderToProbe: await allowance(USDG, e.msgSender, probe),
    allowancesSignerToSpenders: await Promise.all(approvals.map(async (a) => ({ spender: a.spender, allowance: await allowance(a.token, signer, a.spender) }))),
  };
  sent.probed = e;
  sent.balances = { before, after };
  sent.leftover = leftover;
  const lc = (a: string | null | undefined) => (a ?? '').toLowerCase();
  sent.answers = {
    '6 msg.sender at the probe': e.msgSender,
    '6 msg.sender equals userProxy from compile': lc(e.msgSender) === lc(r.userProxy),
    '6 msg.sender equals the signer': lc(e.msgSender) === lc(signer),
    '6 tx.origin equals the signer': lc(e.txOrigin) === lc(signer),
    '6 context.sender resolved to (recipient)': e.recipient,
    '4 tokens arrived at the probe (received)': e.received,
    'delivery model': e.pulled > BigInt(0) ? 'PULL (allowance from msg.sender)' : e.pushedBeforeCall > BigInt(0) ? 'PUSH (transferred before the call)' : 'NONE',
    '3 calldata amount (runtime)': e.amountArg,
    '5 balance delta measured in the same tx (pulled)': e.pulled,
    '7 user approval spender(s)': approvals.map((a) => a.spender),
    '7 user approval spender equals userProxy': approvals.map((a) => lc(a.spender) === lc(r.userProxy)),
    '7 inline approval left after the call (msg.sender → probe)': leftover.allowanceMsgSenderToProbe,
    'probe kept nothing': leftover.probeUsdgBalance === BigInt(0),
    // T shows Composer can call a contract; only S shows a swap's actual output reaching BAG's contract in the same tx.
    'P1 complete (swap output → probe, same tx)': spec.variant === 'S' && e.received > BigInt(0),
  };
  console.log(`\nAnswers: ${JSON.stringify(sent.answers, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}`);
  finish(0, `SENT ${hash}: see answers.`);
}

main().catch((e) => finish(2, `UNEXPECTED: ${scrub((e as Error).message ?? String(e))}`));
