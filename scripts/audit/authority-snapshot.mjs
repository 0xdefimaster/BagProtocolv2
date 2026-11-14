// Read-only snapshot of every privileged role on BAG's deployed contracts.
//
//   node scripts/audit/authority-snapshot.mjs [--out evidence/authority]
//
// What it does: for each chain, pins one block, reads the role getters of each
// listed contract at that block, hashes the runtime code, and classifies every
// role-holding address as EOA, EIP-7702-delegated EOA, Safe or other contract.
// What it never does: read a key, sign, send a transaction, or print an RPC URL.
// RPC: <CHAIN>_RPC_URL from the process environment if set, otherwise the
// chain's public endpoint. The environment is NOT loaded from .env files.
//
// The inventory below is reviewed by hand. Each entry names where its address
// comes from; nothing is inferred from constructor arguments or env values.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, getAddress, http, keccak256, parseAbi } from 'viem';

const CHAINS = {
  robinhood: { id: 4663, env: 'ROBINHOOD_RPC_URL', publicRpc: 'https://rpc.mainnet.chain.robinhood.com' },
  base: { id: 8453, env: 'BASE_RPC_URL', publicRpc: 'https://mainnet.base.org' },
  arbitrum: { id: 42161, env: 'ARBITRUM_RPC_URL', publicRpc: 'https://arb1.arbitrum.io/rpc' },
};

const ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function treasury() view returns (address)',
  'function creationFee() view returns (uint256)',
  'function creationFeeCap() view returns (uint256)',
  'function attestor() view returns (address)',
  'function usdg() view returns (address)',
  'function FORK_ROYALTY_SHARE_BPS() view returns (uint256)',
  'function MAX_FEE_RATE_BPS() view returns (uint256)',
  'function registry() view returns (address)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

const FACTORY = ['owner', 'pendingOwner', 'treasury', 'creationFee', 'creationFeeCap'];
const SETTLEMENT = ['owner', 'attestor', 'usdg', 'FORK_ROYALTY_SHARE_BPS', 'MAX_FEE_RATE_BPS'];
const COMPOSER_FACTORY_HASH = '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5';

/** Address roles whose holder must be classified (the rest are configuration values). */
const ROLE_GETTERS = new Set(['owner', 'pendingOwner', 'treasury', 'attestor']);

const CONTRACTS = [
  { chain: 'robinhood', name: 'BagFactory', status: 'LIVE (configured)', address: '0x7ce5a81df434755f38cb5f67ad49a8bb3c8e6f72', source: 'FACTORY_ADDRESS_ROBINHOOD; evidence/three-chain-app/deployment-inputs.json', getters: FACTORY },
  { chain: 'robinhood', name: 'StrategyRegistry', status: 'LIVE (configured)', address: '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8', source: 'docs/STRATEGY_REGISTRY_DESIGN.md', getters: [] },
  { chain: 'robinhood', name: 'RedeemSettlement v2', status: 'LIVE (configured)', address: '0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3', source: 'docs/REDEEM_SETTLEMENT_DEPLOYMENT.md §0', getters: SETTLEMENT },
  { chain: 'robinhood', name: 'RedeemSettlement v1', status: 'SUPERSEDED', address: '0x934a3f266e68DfbFF8eD4F02AA393a36048170a0', source: 'docs/REDEEM_SETTLEMENT_DEPLOYMENT.md §0', getters: SETTLEMENT },
  { chain: 'robinhood', name: 'RedeemSettlement (7702 attestor)', status: 'SUPERSEDED, never configured', address: '0x1B365C5325Eb511935F60B7aeA184a3fABedF6f6', source: 'docs/REDEEM_SETTLEMENT_DEPLOYMENT.md §0', getters: SETTLEMENT },
  { chain: 'robinhood', name: 'RedeemSettlement (probe owner)', status: 'ABANDONED, unmanageable', address: '0x0FB961dd2844091361C6bFcCd92D8f0457DC984d', source: 'docs/REDEEM_SETTLEMENT_DEPLOYMENT.md §0', getters: SETTLEMENT },
  { chain: 'robinhood', name: 'LI.FI Composer factory (external)', status: 'PINNED', address: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae', source: 'docs/SDK_DEPLOYMENT_PIN_ROBINHOOD.md', getters: [], expectedCodeHash: COMPOSER_FACTORY_HASH },
  { chain: 'base', name: 'BagFactory', status: 'DEPLOYED (2026-11-08)', address: '0x9F66fA3F7a70281eB4F598EfE763B3f83379df4a', source: 'evidence/three-chain-app/deployments-base.json', getters: FACTORY, expectedCodeHash: '0xab9c9cdb2d05b30c157a5d3fd04b69d305a4039f8009ce1ed38e0a0e913612e5' },
  { chain: 'base', name: 'StrategyRegistry', status: 'DEPLOYED', address: '0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920', source: 'docs/STATUS.md; evidence/three-chain-app/base-post-deploy-readiness.json', getters: [], expectedCodeHash: '0x40aa4d92bd07a225802ff76c42c17cb62e80160b1c902144492b9289cf692c9b' },
  { chain: 'base', name: 'StrategyCompositions', status: 'DEPLOYED (2026-11-08)', address: '0x7D4A75a7F196eA90Cf96021ADAC83a0DE93A4Fc8', source: 'evidence/three-chain-app/deployments-base.json', getters: ['registry'], expectedCodeHash: '0x5ce5308f9ad1210951f9f60a8b38672d20a89bdbceabee9541cde04a1752160d' },
  { chain: 'base', name: 'LI.FI Composer factory (external)', status: 'PINNED', address: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae', source: 'docs/SDK_DEPLOYMENT_PIN_BASE.md', getters: [], expectedCodeHash: COMPOSER_FACTORY_HASH },
  { chain: 'arbitrum', name: 'StrategyRegistry (predicted)', status: 'NOT DEPLOYED (prediction)', address: '0xcAD829DCC30fa88B3d57CC0a6Fa32Bd56c9a5920', source: 'evidence/three-chain-app/unsigned-deployments.json (nonce 0)', getters: [], expectNoCode: true },
  { chain: 'arbitrum', name: 'BagFactory (predicted)', status: 'NOT DEPLOYED (prediction)', address: '0x663A10b45a7617B37C47068484FC49D915EA322F', source: 'evidence/three-chain-app/unsigned-deployments.json (nonce 1)', getters: [], expectNoCode: true },
  { chain: 'arbitrum', name: 'StrategyCompositions (predicted)', status: 'NOT DEPLOYED (prediction)', address: '0x8B033b1cF7F3876B11Acc0e9298713E730B698AE', source: 'evidence/three-chain-app/unsigned-deployments.json (nonce 2)', getters: [], expectNoCode: true },
];

/** Accounts classified on every chain even when no getter returns them. */
const KNOWN_ACCOUNTS = {
  '0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46': 'deployer / factory owner / settlement owner (docs)',
  '0x5186f0cCAB569dE1655922213074D97914378cd8': 'protocol treasury (docs)',
  '0xFf60Ab336c3Be45Cfae3B31238dd22DEA176dff2': 'RedeemSettlement attestor (docs)',
};

const errName = (e) => (e && typeof e === 'object' && 'name' in e ? String(e.name) : 'Error');
const str = (v) => (typeof v === 'bigint' ? v.toString() : v);

async function classify(client, address, blockNumber) {
  const [code, nonce] = await Promise.all([
    client.getCode({ address, blockNumber }),
    client.getTransactionCount({ address, blockNumber }).catch(() => null),
  ]);
  if (!code || code === '0x') return { kind: 'EOA', nonce };
  const delegation = /^0xef0100([0-9a-fA-F]{40})$/.exec(code);
  if (delegation) return { kind: 'EOA_EIP7702_DELEGATED', delegate: getAddress(`0x${delegation[1]}`), nonce };
  const safe = {};
  try {
    safe.threshold = String(await client.readContract({ address, abi: ABI, functionName: 'getThreshold', blockNumber }));
    safe.owners = await client.readContract({ address, abi: ABI, functionName: 'getOwners', blockNumber });
  } catch { /* not a Safe-compatible contract */ }
  return { kind: safe.owners ? 'CONTRACT_SAFE_COMPATIBLE' : 'CONTRACT', codeHash: keccak256(code), ...safe };
}

async function snapshotChain(name, cfg) {
  const rpc = process.env[cfg.env] || cfg.publicRpc;
  const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
  const chainId = await client.getChainId();
  if (chainId !== cfg.id) throw new Error(`${name}: RPC chain ${chainId}, expected ${cfg.id}`);
  const blockNumber = await client.getBlockNumber();
  const rpcSource = process.env[cfg.env] ? `env ${cfg.env}` : `public ${new URL(cfg.publicRpc).host}`;
  const contracts = [];
  const holders = new Map(Object.entries(KNOWN_ACCOUNTS).map(([a, why]) => [getAddress(a), new Set([why])]));
  for (const c of CONTRACTS.filter((x) => x.chain === name)) {
    const address = getAddress(c.address);
    const code = await client.getCode({ address, blockNumber });
    const hasCode = !!code && code !== '0x';
    const row = { name: c.name, documentedStatus: c.status, address, addressSource: c.source, hasCode, codeHash: hasCode ? keccak256(code) : null, codeBytes: hasCode ? (code.length - 2) / 2 : 0, roles: {} };
    if (c.expectedCodeHash) row.expectedCodeHash = c.expectedCodeHash;
    if (c.expectedCodeHash) row.codeHashMatches = hasCode && row.codeHash.toLowerCase() === c.expectedCodeHash.toLowerCase();
    if (c.expectNoCode) row.predictionStillFree = !hasCode;
    if (hasCode) {
      for (const fn of c.getters) {
        try {
          const v = await client.readContract({ address, abi: ABI, functionName: fn, blockNumber });
          row.roles[fn] = str(v);
          if (ROLE_GETTERS.has(fn) && v !== '0x0000000000000000000000000000000000000000') {
            const a = getAddress(v);
            if (!holders.has(a)) holders.set(a, new Set());
            holders.get(a).add(`${c.name}.${fn}`);
          }
        } catch (e) {
          row.roles[fn] = `CALL_FAILED (${errName(e)})`;
        }
      }
    }
    contracts.push(row);
  }
  const accounts = [];
  for (const [address, why] of holders) {
    try {
      accounts.push({ address, referencedBy: [...why], ...(await classify(client, address, blockNumber)) });
    } catch (e) {
      accounts.push({ address, referencedBy: [...why], kind: `READ_FAILED (${errName(e)})` });
    }
  }
  return { chain: name, chainId, blockNumber: blockNumber.toString(), rpcSource, contracts, accounts };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'evidence/authority' } } });
  const result = { schema: 'bag-authority-snapshot/v1', createdAt: new Date().toISOString(), readOnly: true, chains: [] };
  for (const [name, cfg] of Object.entries(CHAINS)) {
    try {
      result.chains.push(await snapshotChain(name, cfg));
    } catch (e) {
      // Never print the message: an env RPC URL may carry an API key.
      result.chains.push({ chain: name, chainId: cfg.id, status: `UNVERIFIED: ${errName(e)}` });
    }
  }
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `authority-snapshot-${result.createdAt.slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  console.error(`written: ${file}`);
}

main().catch((e) => {
  console.error(JSON.stringify({ status: 'STOPPED', error: errName(e) }));
  process.exitCode = 1;
});
