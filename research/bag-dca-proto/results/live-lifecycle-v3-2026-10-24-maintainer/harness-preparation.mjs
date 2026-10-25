import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const proto = resolve('work/dca-lifecycle-v3-live-2026-10-24/proto');
const source = join(proto, 'composer/run.mjs');
const target = join(proto, 'composer/run-isolated-models.mjs');
assert.ok(!existsSync(target));
let text = readFileSync(source, 'utf8');
assert.equal(createHash('sha256').update(text).digest('hex'), '08c7d1d301765b76c3e54c0a5296f2843bf7ee227dd3e5cd670466e7762220c6');
const begin = "if (TD) {\n  // ---- Model A";
assert.equal(text.split(begin).length, 2);
text = text.replace(begin, "if (TD) {\n  // Independent A/B experiments start from the same fork state. This never rewinds\n  // successful purchases within the same delegation-consumption lifecycle.\n  const beforeIndependentModels = await rpc('evm_snapshot');\n  report.modelIsolation = { enabled: true, kind: 'A_AND_B_FROM_SAME_FORK_BASE',\n    note: 'A results are collected before reverting to the common base for B. Existing B-17 branch isolation remains unchanged.' };\n  // ---- Model A");
const modelB = "  // ---- Model B ----------------------------------------------------------------------------\n  const env = kit.getSmartAccountsEnvironment(4663)";
assert.equal(text.split(modelB).length, 2);
text = text.replace(modelB, "  // ---- Model B ----------------------------------------------------------------------------\n  assert.equal(await rpc('evm_revert', [beforeIndependentModels]), true, 'Could not restore independent B base state');\n  console.log('ISOLATION restored initial fork state before independent model B');\n  const env = kit.getSmartAccountsEnvironment(4663)");
writeFileSync(target, text);
console.log(JSON.stringify({ originalSha256: createHash('sha256').update(readFileSync(source)).digest('hex'), isolatedRunnerSha256: createHash('sha256').update(text).digest('hex'), contractChanged: false, guardsChanged: false, path: target }, null, 2));
