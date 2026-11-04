import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';

// On-chain runtime code vs this repository's compiled artifacts (no Hardhat import, so it can be unit-tested).

export type Artifact = { deployedBytecode: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
export const artifact = (name: string): Artifact => JSON.parse(readFileSync(join('artifacts', 'contracts', `${name}.sol`, `${name}.json`), 'utf8'));

/**
 * Compares on-chain runtime code with this repository's compiled artifact. `exact`: byte-identical. `masked`:
 * identical once the constructor-set immutables and EVERY embedded CBOR metadata blob are zeroed on both sides. A
 * factory embeds its child's creation code (BagFactory carries Bag's), so its runtime holds the child's metadata hash
 * too; a comment change in either source changes those 53-byte blobs and nothing else. `diffRanges` lists the byte
 * ranges that still differ after masking (empty when `masked`), so a real code difference is visible.
 */
export function compareRuntime(onChain: Hex | undefined, name: string) {
  const a = artifact(name);
  const hex = (x: string) => Buffer.from(x.slice(2), 'hex');
  const code = hex(onChain ?? '0x');
  const want = hex(a.deployedBytecode);
  const CBOR = Buffer.from('a264697066735822', 'hex'); // {"ipfs": bytes(34), "solc": bytes(3)} + 2-byte length = 53 bytes
  const blobs = (b: Buffer) => {
    const at: number[] = [];
    for (let i = b.indexOf(CBOR); i >= 0; i = b.indexOf(CBOR, i + 1)) at.push(i);
    return at;
  };
  const mask = (b: Buffer, ranges: number[]) => {
    const c = Buffer.from(b);
    for (const refs of Object.values(a.immutableReferences ?? {})) for (const r of refs) c.fill(0, r.start, r.start + r.length);
    for (const i of ranges) c.fill(0, i, Math.min(c.length, i + 53));
    return c;
  };
  const ranges = [...new Set([...blobs(code), ...blobs(want)])];
  const mc = mask(code, ranges);
  const mw = mask(want, ranges);
  const diffRanges: [number, number][] = [];
  if (mc.length === mw.length) {
    for (let i = 0; i < mc.length && diffRanges.length < 10; i++) {
      if (mc[i] === mw[i]) continue;
      let j = i;
      while (j < mc.length && mc[j] !== mw[j]) j++;
      diffRanges.push([i, j - i]);
      i = j;
    }
  }
  const metadataBlobsDiffer = ranges.some((i) => !code.subarray(i, i + 53).equals(want.subarray(i, i + 53)));
  return {
    bytes: code.length,
    artifactBytes: want.length,
    codeKeccak: keccak256(onChain ?? '0x'),
    exact: code.equals(want),
    masked: code.length === want.length && mc.equals(mw),
    metadataBlobs: ranges,
    metadataBlobsDiffer,
    diffRanges,
  };
}

