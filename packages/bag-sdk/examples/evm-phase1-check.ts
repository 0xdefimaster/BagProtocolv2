// Shared read-only entry point. Each chain requires its own caller-reviewed Composer pin.
// npx tsx packages/bag-sdk/examples/evm-phase1-check.ts <base|arbitrum> <signer>
import { pathToFileURL } from 'node:url';
import { getSdkErrorInfo } from '../src/index';
import { runPhase1Check } from './base-phase1-check';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const chain = process.argv[2];
  if (chain !== 'base' && chain !== 'arbitrum') {
    console.error('Usage: evm-phase1-check.ts <base|arbitrum> <signer>');
    process.exit(2);
  }
  runPhase1Check(chain, process.argv[3]).catch((error) => {
    console.error(getSdkErrorInfo(error).code);
    process.exitCode = 1;
  });
}
