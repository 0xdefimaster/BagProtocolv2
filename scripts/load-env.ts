// Loads .env.local / .env (same files and precedence as `next dev`) into
// process.env for CLI scripts. Import this FIRST in every script so values
// are in place before any other module reads them.
//
// @next/env is CommonJS: under ESM its exports arrive on the default export,
// under CJS on the namespace itself — handle both.
import * as nextEnv from '@next/env';

type NextEnvModule = { loadEnvConfig: (dir: string) => unknown };
const mod = nextEnv as unknown as Partial<NextEnvModule> & { default?: NextEnvModule };
const loadEnvConfig = mod.loadEnvConfig ?? mod.default?.loadEnvConfig;
if (!loadEnvConfig) throw new Error('@next/env did not expose loadEnvConfig');

loadEnvConfig(process.cwd());
