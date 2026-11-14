// Read-only check of the smart-account contracts BAG's exact wallet-batch binding trusts
// (packages/bag-sdk/src/wallet-envelope.ts, TRUSTED_SMART_ACCOUNTS).
//
//   node scripts/audit/verify-smart-account-pins.mjs [--out evidence/smart-account]
//
// For each chain: the pinned MetaMask DelegationManager and EIP7702StatelessDeleGator implementation have code;
// the implementation's immutable delegationManager() is the pinned DelegationManager; and each runtime code equals
// the Base copy (Sourcify exact match for both contracts) once the two chain-bound immutables are masked on both
// sides: the 32-byte chain id word and the contract's own EIP-712 domain hash (read from getDomainHash()). Any
// other differing byte fails the chain. No key, no transaction; RPC URLs are public endpoints unless
// <CHAIN>_RPC_URL is set, and are never printed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, http, keccak256, pad, parseAbi, toHex } from 'viem';

const CONTRACTS = {
  delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  delegator: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
};
const REFERENCE = 'base';
const CHAINS = {
  base: { id: 8453, env: 'BASE_RPC_URL', rpc: 'https://mainnet.base.org' },
  robinhood: { id: 4663, env: 'ROBINHOOD_RPC_URL', rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  arbitrum: { id: 42161, env: 'ARBITRUM_RPC_URL', rpc: 'https://arb1.arbitrum.io/rpc' },
  ethereum: { id: 1, env: 'ETHEREUM_RPC_URL', rpc: 'https://ethereum-rpc.publicnode.com' },
};
const abi = parseAbi([
  'function delegationManager() view returns (address)',
  'function entryPoint() view returns (address)',
  'function getDomainHash() view returns (bytes32)',
]);
const errName = (e) => (e && typeof e === 'object' && 'name' in e ? String(e.name) : 'Error');

/** Code hex with every byte-aligned occurrence of each 32-byte word replaced by zeros; returns the count masked. */
function mask(codeHex, words) {
  let hex = codeHex.slice(2).toLowerCase();
  let masked = 0;
  for (const word of words) {
    const w = word.slice(2).toLowerCase();
    for (let i = hex.indexOf(w); i !== -1; i = hex.indexOf(w, i + 1)) {
      if (i % 2 !== 0) continue;
      hex = hex.slice(0, i) + '0'.repeat(64) + hex.slice(i + 64);
      masked++;
    }
  }
  return { hex, masked };
}

async function read(name, cfg) {
  const client = createPublicClient({ transport: http(process.env[cfg.env] || cfg.rpc, { timeout: 20_000, retryCount: 2 }) });
  if ((await client.getChainId()) !== cfg.id) throw new Error(`${name}: wrong chain`);
  const blockNumber = await client.getBlockNumber();
  const out = { chain: name, chainId: cfg.id, blockNumber: String(blockNumber) };
  for (const [label, address] of Object.entries(CONTRACTS)) {
    const code = (await client.getCode({ address, blockNumber })) ?? '0x';
    const entry = { address, bytes: code === '0x' ? 0 : (code.length - 2) / 2, codeHash: code === '0x' ? null : keccak256(code), code };
    if (entry.bytes) entry.domainHash = await client.readContract({ address, abi, functionName: 'getDomainHash', blockNumber });
    out[label] = entry;
  }
  if (out.delegator.bytes) {
    out.implDelegationManager = await client.readContract({ address: CONTRACTS.delegator, abi, functionName: 'delegationManager', blockNumber });
    out.implEntryPoint = await client.readContract({ address: CONTRACTS.delegator, abi, functionName: 'entryPoint', blockNumber });
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'evidence/smart-account' } } });
  const reads = {};
  for (const [name, cfg] of Object.entries(CHAINS)) {
    try { reads[name] = await read(name, cfg); } catch (e) { reads[name] = { chain: name, status: `UNVERIFIED: ${errName(e)}` }; }
  }
  const ref = reads[REFERENCE];
  const result = {
    schema: 'bag-smart-account-pins/v2', createdAt: new Date().toISOString(), readOnly: true,
    contracts: CONTRACTS, reference: `${REFERENCE} (Sourcify exact match for both contracts)`,
    method: 'mask the chain id word and getDomainHash() on both sides, then require identical runtime code',
    chains: [],
  };
  for (const [name, r] of Object.entries(reads)) {
    if (r.status) { result.chains.push(r); continue; }
    const row = { chain: name, chainId: r.chainId, blockNumber: r.blockNumber };
    let sameBuild = true;
    for (const label of Object.keys(CONTRACTS)) {
      const e = r[label];
      const entry = { address: e.address, bytes: e.bytes, codeHash: e.codeHash, domainHash: e.domainHash ?? null };
      if (!e.bytes || !ref || ref.status) { sameBuild = false; row[label] = entry; continue; }
      const own = mask(e.code, [pad(toHex(r.chainId), { size: 32 }), e.domainHash]);
      const base = mask(ref[label].code, [pad(toHex(ref.chainId), { size: 32 }), ref[label].domainHash]);
      entry.maskedWords = own.masked;
      entry.identicalToReferenceAfterMasking = own.hex === base.hex;
      if (!entry.identicalToReferenceAfterMasking) sameBuild = false;
      row[label] = entry;
    }
    row.implDelegationManager = r.implDelegationManager ?? null;
    row.implBindsPinnedDelegationManager = typeof r.implDelegationManager === 'string' && r.implDelegationManager.toLowerCase() === CONTRACTS.delegationManager.toLowerCase();
    row.implEntryPoint = r.implEntryPoint ?? null;
    row.trustable = sameBuild && row.implBindsPinnedDelegationManager;
    result.chains.push(row);
  }
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `metamask-delegation-pins-${result.createdAt.slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result.chains.map((c) => ({ chain: c.chain, trustable: c.trustable ?? false, status: c.status ?? 'READ', block: c.blockNumber })), null, 1));
  console.error(`written: ${file}`);
}

main().catch((e) => {
  console.error(JSON.stringify({ status: 'STOPPED', error: errName(e) }));
  process.exitCode = 1;
});
