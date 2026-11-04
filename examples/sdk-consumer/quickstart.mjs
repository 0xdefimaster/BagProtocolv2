// Quickstart: parse → validate → normalize → hash a bag.json, offline, with nothing but the published SDK.
// Uses only APIs present since @bagprotocol/sdk 0.3.0. No network, no key, no wallet, no transaction.
//
//   node quickstart.mjs [bag.json]      (default: bag.example.json)
import { readFile } from 'node:fs/promises';
import { getSdkErrorInfo, hashBag, normalizeBag, parseBag, resolveV1Rules, validateBag } from '@bagprotocol/sdk';

const file = process.argv[2] ?? 'bag.example.json';
try {
  const parsed = parseBag(await readFile(file, 'utf8'));
  if (!parsed.ok) {
    console.log(JSON.stringify({ status: 'INVALID_BAG_JSON', issues: parsed.issues.map(({ code, path }) => ({ code, path })) }, null, 2));
    process.exit(1);
  }
  const validation = validateBag(parsed.bag);
  if (!validation.valid) {
    console.log(JSON.stringify({ status: 'INVALID_STRATEGY', errors: validation.errors.map(({ code, path }) => ({ code, path })) }, null, 2));
    process.exit(1);
  }
  const definitionHash = hashBag(normalizeBag(parsed.bag));
  const rules = resolveV1Rules(parsed.bag.definition);
  console.log(JSON.stringify({
    status: 'VALID',
    chain: parsed.bag.definition.chain,
    assets: parsed.bag.definition.assets.length,
    definitionHash,
    hashMatchesValidation: definitionHash === validation.definitionHash,
    swapSlippageBps: rules.swapSlippageBps.value,
    warnings: validation.warnings.map(({ code, path }) => ({ code, path })),
  }, null, 2));
} catch (error) {
  // getSdkErrorInfo gives a stable code and message; it never includes URLs, keys or upstream text.
  console.error(JSON.stringify(getSdkErrorInfo(error)));
  process.exit(1);
}
