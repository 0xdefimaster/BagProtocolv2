// Prints the counterfactual MetaMask MultiSigDeleGator (threshold 1, signer = <EOA>, salt 0x)
// address on Robinhood Chain, for the signing page. Read-only: no key, no transaction.
//   node wallet/print-account.mjs <EOA> [--rpc url]
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// MetaMask Smart Accounts Kit sends usage analytics unless DO_NOT_TRACK is set.
process.env.DO_NOT_TRACK ??= '1';
const req = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const v = req('viem'), kit = req('@metamask/smart-accounts-kit');
const [eoa] = process.argv.slice(2), cli = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(eoa ?? '')) throw new Error('usage: node wallet/print-account.mjs <EOA> [--rpc url]');
const rpc = cli.includes('--rpc') ? cli[cli.indexOf('--rpc') + 1] : 'https://rpc.mainnet.chain.robinhood.com';
const chain = v.defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = v.createPublicClient({ chain, transport: v.http(rpc) });
const watchOnly = { address: eoa, signMessage: async () => { throw new Error('read-only'); }, signTypedData: async () => { throw new Error('read-only'); } };
const sa = await kit.toMetaMaskSmartAccount({ client, implementation: kit.Implementation.MultiSig, deployParams: [[eoa], 1n], deploySalt: '0x', signer: [{ account: watchOnly }] });
console.log(sa.address);
