import { defineConfig } from 'vitest/config';
import path from 'path';

// This config's `include` covers `lib/**` (pure/server-side units — Node
// environment, no DOM) plus `hooks/**` (client React hooks — these opt
// into a `jsdom` environment per-file via a `// @vitest-environment jsdom`
// docblock at the top of the test file, rather than forcing jsdom as this
// whole config's global default, so the much larger `lib/**` suite keeps
// running under the faster, dependency-free `node` environment), plus
// component (`components/**`, `app/**`) suite — same per-file `jsdom`
// opt-in convention as `hooks/**`.
//
// `*.integration.test.ts` files need a real PostgreSQL (and, for one suite, a
// local EVM) and are run by `npm run test:integration` via
// vitest.integration.config.ts — they are deliberately EXCLUDED here so that
// `npm test` stays a pure, dependency-free unit run and never reports an
// integration suite as passed/skipped without a database.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  // Every component in this repo relies on the automatic JSX runtime, the
  // same one Next.js's own build uses. tsconfig.json keeps `jsx: preserve`
  // for Next, so the test transform (oxc since Vite 8) is told explicitly;
  // otherwise JSX reaches the parser untransformed.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    include: ['packages/**/*.test.ts', 'lib/**/*.test.ts', 'lib/**/*.test.tsx', 'hooks/**/*.test.ts', 'hooks/**/*.test.tsx', 'app/**/*.test.tsx', 'components/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
