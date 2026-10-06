import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXTERNAL_BAG_PATH = fileURLToPath(new URL('./fixtures/external.bag.json', import.meta.url));
export const externalBagText = () => readFileSync(EXTERNAL_BAG_PATH, 'utf8');
export const externalBag = () => JSON.parse(externalBagText()) as Record<string, any>;

/** The published hash of the fixture's definition (docs/schemas/bag-json.v1.vectors.json, "full-unnormalized-input"). */
export const EXTERNAL_DEFINITION_HASH = '0x972926ad5b5f6022245c540172fea53c23165b0d86d34440ddfc28fa2704c5b0';

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
