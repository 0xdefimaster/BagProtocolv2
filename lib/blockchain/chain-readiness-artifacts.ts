import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { RuntimeArtifact } from './chain-readiness';

/**
 * A Hardhat 3 artifact (`_format: hh3-artifact-1`) as the readiness check uses it: the deployed bytecode and the
 * compiler-declared `immutableReferences` (AST id → byte ranges). Undefined when the contract has not been compiled.
 * Throws on a file in another format rather than comparing against something it does not understand.
 */
export function loadRuntimeArtifact(name: string, artifactsRoot = 'artifacts'): RuntimeArtifact | undefined {
  const file = join(artifactsRoot, 'contracts', `${name}.sol`, `${name}.json`);
  if (!existsSync(file)) return undefined;
  const a = JSON.parse(readFileSync(file, 'utf8')) as { _format?: string; deployedBytecode?: string; immutableReferences?: RuntimeArtifact['immutableReferences'] };
  if (a._format !== 'hh3-artifact-1' || typeof a.deployedBytecode !== 'string' || !/^0x[0-9a-fA-F]*$/.test(a.deployedBytecode)) {
    throw new Error(`${file} is not a Hardhat 3 artifact with deployed bytecode.`);
  }
  return { deployedBytecode: a.deployedBytecode as Hex, immutableReferences: a.immutableReferences ?? {} };
}
