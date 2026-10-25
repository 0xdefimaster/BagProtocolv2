// V-B2: compile MetaMask/delegation-framework v1.3.0 and compare runtime bytecode with the code
// deployed on Robinhood Chain (4663). The CBOR metadata tail and immutable slots are masked for
// the byte comparison; every masked immutable is then decoded and checked against its expected
// value separately. Usage: node verify-bytecode.mjs <delegation-framework@v1.3.0 dir> [--rpc url]
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.argv.slice(2), dfDir = cli[0];
const rpc = cli.includes('--rpc') ? cli[cli.indexOf('--rpc') + 1] : 'https://rpc.mainnet.chain.robinhood.com';
const req = createRequire(join(here, 'package.json'));
const solc = req('solc'), v = req('viem');
const remaps = readFileSync(join(dfDir, 'remappings.txt'), 'utf8').split('\n').filter(Boolean)
  .map(l => (l === '@SCL=lib/SCL/src' ? '@SCL/=lib/SCL/src/' : l)).map(l => l.split('='))
  .concat([['openzeppelin-contracts/', 'lib/openzeppelin-contracts/'], ['@solidity/', 'lib/SCL/src/']]);

const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const DM = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const targets = {
  DelegationManager: ['src/DelegationManager.sol', DM],
  HybridDeleGator: ['src/HybridDeleGator.sol', '0x48dBe696A4D990079e039489bA2053B36E8FFEC4'],
  MultiSigDeleGator: ['src/MultiSigDeleGator.sol', '0x56a9EdB16a0105eb5a4C54f4C062e2868844f3A7'],
  EIP7702StatelessDeleGator: ['src/EIP7702/EIP7702StatelessDeleGator.sol', '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'],
  ERC20PeriodTransferEnforcer: ['src/enforcers/ERC20PeriodTransferEnforcer.sol', '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB'],
  ERC20TransferAmountEnforcer: ['src/enforcers/ERC20TransferAmountEnforcer.sol', '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc'],
  LimitedCallsEnforcer: ['src/enforcers/LimitedCallsEnforcer.sol', '0x04658B29F6b82ed55274221a06Fc97D318E25416'],
  RedeemerEnforcer: ['src/enforcers/RedeemerEnforcer.sol', '0xE144b0b2618071B4E56f746313528a669c7E65c5'],
  AllowedCalldataEnforcer: ['src/enforcers/AllowedCalldataEnforcer.sol', '0xc2b0d624c1c4319760C96503BA27C347F3260f55'],
  TimestampEnforcer: ['src/enforcers/TimestampEnforcer.sol', '0x1046bb45C8d673d4ea75321280DB34899413c069'],
};
const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'london',
  outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'], '': ['ast'] } } };

function findImport(path) {
  for (const [from, to] of remaps) if (path.startsWith(from)) path = to + path.slice(from.length);
  const full = join(dfDir, path);
  return existsSync(full) ? { contents: readFileSync(full, 'utf8') } : { error: 'not found: ' + path };
}
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
  sources: Object.fromEntries(Object.values(targets).map(([p]) => [p, { content: readFileSync(join(dfDir, p), 'utf8') }])), settings }), { import: findImport }));
const errors = (out.errors ?? []).filter(e => e.severity === 'error');
if (errors.length) { console.error(errors.map(e => e.formattedMessage).join('\n')); process.exit(1); }

// AST id -> state variable name, for every immutable in every compiled source.
const names = new Map();
const walk = n => { if (!n || typeof n !== 'object') return; if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') names.set(String(n.id), n.name); for (const x of Object.values(n)) Array.isArray(x) ? x.forEach(walk) : walk(x); };
for (const s of Object.values(out.sources)) walk(s.ast);

const client = v.createPublicClient({ transport: v.http(rpc) });
const stripMeta = b => { const n = b.readUInt16BE(b.length - 2); return b.subarray(0, b.length - 2 - n); };
const mask = (buf, refs) => { const b = Buffer.from(buf); for (const list of Object.values(refs ?? {})) for (const { start, length } of list) b.fill(0, start, start + length); return b; };
const shortString = s => { const b = Buffer.alloc(32); Buffer.from(s).copy(b); b[31] = Buffer.byteLength(s); return '0x' + b.toString('hex'); };
const word = x => v.pad(typeof x === 'string' ? x : v.toHex(x), { size: 32 }).toLowerCase();

async function expectedImmutables(address) {
  let domain = null;
  try {
    const d = await client.readContract({ address, abi: v.parseAbi(['function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])']), functionName: 'eip712Domain' });
    domain = { name: d[1], version: d[2], chainId: d[3], verifyingContract: d[4] };
  } catch {}
  // __self: OpenZeppelin UUPSUpgradeable's address(this) of the implementation.
  const e = { _cachedChainId: word(4663n), _cachedThis: word(address), __self: word(address), delegationManager: word(DM), entryPoint: word(ENTRY_POINT) };
  if (domain) {
    const hashedName = v.keccak256(v.toHex(domain.name)), hashedVersion = v.keccak256(v.toHex(domain.version));
    const typeHash = v.keccak256(v.toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
    Object.assign(e, { _hashedName: hashedName, _hashedVersion: hashedVersion, _name: shortString(domain.name), _version: shortString(domain.version),
      _cachedDomainSeparator: v.keccak256(v.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [typeHash, hashedName, hashedVersion, 4663n, address])) });
  }
  return { expected: e, domain };
}

const report = { source: 'MetaMask/delegation-framework v1.3.0', compiler: solc.version(), settings: { ...settings, outputSelection: undefined }, rpc: '<rpc>', contracts: [] };
let allMatch = true;
for (const [name, [path, address]] of Object.entries(targets)) {
  const c = out.contracts[path][name], refs = c.evm.deployedBytecode.immutableReferences;
  const local = Buffer.from(c.evm.deployedBytecode.object, 'hex');
  const chain = Buffer.from((await client.getCode({ address })).slice(2), 'hex');
  const entry = { name, address, localBytes: local.length, chainBytes: chain.length, immutables: [] };
  if (local.length !== chain.length) { entry.bytecode = 'MISMATCH_LENGTH'; allMatch = false; report.contracts.push(entry); console.log(`MISMATCH ${name} length local=${local.length} chain=${chain.length}`); continue; }
  entry.bytecode = mask(stripMeta(local), refs).equals(mask(stripMeta(chain), refs)) ? 'MATCH' : 'MISMATCH';
  if (entry.bytecode !== 'MATCH') allMatch = false;
  const { expected, domain } = await expectedImmutables(address);
  entry.eip712Domain = domain && { ...domain, chainId: String(domain.chainId) };
  for (const [id, list] of Object.entries(refs ?? {})) {
    const values = [...new Set(list.map(({ start, length }) => '0x' + chain.subarray(start, start + length).toString('hex')))];
    const varName = names.get(id) ?? '#' + id, want = expected[varName];
    const status = values.length !== 1 ? 'INCONSISTENT_COPIES' : want === undefined ? 'NO_EXPECTATION' : values[0].toLowerCase() === want.toLowerCase() ? 'EXPECTED' : 'UNEXPECTED';
    if (status !== 'EXPECTED') allMatch = false;
    entry.immutables.push({ name: varName, copies: list.length, value: values[0], expected: want ?? null, status });
  }
  report.contracts.push(entry);
  console.log(`${entry.bytecode.padEnd(8)} ${name} ${address} ${local.length}B` + entry.immutables.map(i => `\n         ${i.status.padEnd(14)} ${i.name} = ${i.value}`).join(''));
}
mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'bytecode-verification.json'), JSON.stringify(report, null, 2));
process.exit(allMatch ? 0 : 2);
