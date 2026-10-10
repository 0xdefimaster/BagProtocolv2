// The SDK's source uses extensionless relative imports (the BAG app and its
// tests import it from source through a bundler). Node's ESM loader needs the
// full file name, so after `tsc` this adds `.js` to every relative specifier
// in dist/ (.js and .d.ts). Node built-ins only; no dependency.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(dist)) throw new Error(`fix-esm-imports: ${dist} does not exist; run tsc first.`);

const files = readdirSync(dist, { recursive: true })
  .map((f) => join(dist, String(f)))
  .filter((f) => statSync(f).isFile() && (f.endsWith('.js') || f.endsWith('.d.ts')));

const SPECIFIER = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]*?)(['"])/g;
let rewritten = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(SPECIFIER, (match, head, spec, tail) => {
    if (/\.(m?js|json)$/.test(spec)) return match;
    const target = resolve(dirname(file), spec);
    const withExt = existsSync(`${target}.js`) || existsSync(`${target}.d.ts`) ? `${spec}.js` : existsSync(join(target, 'index.js')) ? `${spec}/index.js` : null;
    if (!withExt) throw new Error(`fix-esm-imports: ${file}: cannot resolve "${spec}".`);
    rewritten++;
    return `${head}${withExt}${tail}`;
  });
  if (next !== text) writeFileSync(file, next);
}
console.log(`fix-esm-imports: ${rewritten} relative import(s) in ${files.length} file(s) now end in .js`);
