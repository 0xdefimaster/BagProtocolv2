// Registers @testing-library/jest-dom's matchers (toBeInTheDocument,
// toHaveAttribute, toBeDisabled, ...) for every test file — needed by the
// app/**/*.test.tsx component suite; harmless no-op import for the
// existing lib/**/hooks/** suites, which don't use these matchers.
import '@testing-library/jest-dom/vitest';
