// Copy the canonical repo schema into the published SDK tarball.
// Source of truth stays in docs/schemas; dist is generated and never hand-edited.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../docs/schemas/bag.v1.schema.json');
const destination = resolve(here, '../dist/schema/bag.v1.schema.json');

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log('copy-schema: dist/schema/bag.v1.schema.json copied from the canonical docs schema');
