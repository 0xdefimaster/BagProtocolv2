// Which bytes of a compiled Composer program depend on the signer? Classifies every VM state
// slot by whether it contains the signer, its Composer proxy, or neither. Usage:
//   node analyze-signer-dependence.mjs <repoDir> <kitDir> <compiled.json> <rpcUrl>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [, , repoDir, kitDir, file, rpc] = process.argv;
const v = createRequire(join(kitDir, 'package.json'))('viem');
const { composerWire } = await import(pathToFileURL(join(repoDir, 'scripts/research/usdg-recurring/wire.mjs')));
const wire = composerWire(v);
const FACTORY = '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae';
const fixture = JSON.parse(readFileSync(file, 'utf8'));
const signer = fixture.plan.signer.toLowerCase();
const client = v.createPublicClient({ transport: v.http(rpc) });
const proxy = (await client.readContract({ address: FACTORY, abi: v.parseAbi(['function predictProxyAddress(address) view returns (address)']), functionName: 'predictProxyAddress', args: [signer] })).toLowerCase();
const x = wire.decode(fixture.compiled.transaction.data);
const has = (hex, a) => hex.toLowerCase().includes(a.slice(2));
const contextSlot = Number(BigInt(v.slice(x.instructions[0][1], 2, 3)));
const rows = x.state.map((s, i) => {
  let kind = 'fixed';
  try { const a = wire.swap(s); kind = 'swap(receiver=' + (a[3].toLowerCase() === proxy ? 'proxy' : a[3]) + ')'; } catch {}
  return { slot: i, bytes: (s.length - 2) / 2, kind: i === contextSlot ? 'context' : kind, containsSigner: has(s, signer), containsProxy: has(s, proxy) };
});
const instrSigner = x.instructions.some(([, op]) => has(op, signer) || has(op, proxy));
console.log(JSON.stringify({ signer, proxy, wrapped: x.wrapped, instructions: x.instructions.length, instructionsContainAddress: instrSigner, contextSlot, slots: rows }, null, 1));
// Inside each swap: which fields carry the proxy?
for (const [i, s] of x.state.entries()) {
  let a; try { a = wire.swap(s); } catch { continue; }
  const [, , , receiver, , swaps] = a;
  console.log(JSON.stringify({ slot: i, receiverIsProxy: receiver.toLowerCase() === proxy,
    legs: swaps.map((w, k) => ({ k, callTo: w.callTo, feeCallDataHasProxy: has(w.callData, proxy), callDataHasProxy: has(w.callData, proxy), callDataHasSigner: has(w.callData, signer) })) }));
}
