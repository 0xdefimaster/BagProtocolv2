// Writes lib/pins.json: runtime code hashes (keccak256) of every on-chain contract the wallet-fork
// flow relies on, read from Robinhood Chain through the read-only relay. Delegation Framework
// contracts must also be MATCH in out/bytecode-verification.json (source-verified, v1.3.0).
//   node tools/pin-bytecode.mjs [--rpc <url>]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay, chainFor, v, kit, PUBLIC_RPC } from '../lib/fork-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), rpc = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1] : PUBLIC_RPC;
const relay = await startRelay(rpc);
try {
  const remote = v.createPublicClient({ chain: chainFor(relay.url), transport: v.http(relay.url) });
  const block = await remote.getBlock();
  const env = kit.getSmartAccountsEnvironment(4663), E = env.caveatEnforcers;
  const verified = JSON.parse(readFileSync(join(here, '..', 'out/bytecode-verification.json'), 'utf8'));
  const match = Object.fromEntries(verified.contracts.map(c => [c.address.toLowerCase(), c.bytecode]));
  const targets = {
    DelegationManager: env.DelegationManager, MultiSigDeleGatorImpl: env.implementations.MultiSigDeleGatorImpl,
    ERC20PeriodTransferEnforcer: E.ERC20PeriodTransferEnforcer, ERC20TransferAmountEnforcer: E.ERC20TransferAmountEnforcer, LimitedCallsEnforcer: E.LimitedCallsEnforcer,
    TimestampEnforcer: E.TimestampEnforcer, RedeemerEnforcer: E.RedeemerEnforcer, AllowedCalldataEnforcer: E.AllowedCalldataEnforcer,
    EntryPointV07: env.EntryPoint, SimpleFactory: env.SimpleFactory,
  };
  const pins = { chainId: 4663, pinnedAtBlock: block.number.toString(), pinnedAtBlockHash: block.hash, delegationFramework: 'v1.3.0', contracts: {} };
  for (const [name, address] of Object.entries(targets)) {
    const code = await remote.getCode({ address });
    if (!code || code === '0x') throw new Error(`${name} has no code at ${address}`);
    const sourceVerified = match[address.toLowerCase()] === 'MATCH';
    if (!['EntryPointV07', 'SimpleFactory'].includes(name) && !sourceVerified) throw new Error(`${name} is not MATCH in out/bytecode-verification.json`);
    pins.contracts[name] = { address, codeHash: v.keccak256(code), bytes: (code.length - 2) / 2, sourceVerifiedV130: sourceVerified };
  }
  writeFileSync(join(here, '..', 'lib/pins.json'), JSON.stringify(pins, null, 2) + '\n');
  console.log(JSON.stringify(pins, null, 2));
} finally { await relay.close(); }
