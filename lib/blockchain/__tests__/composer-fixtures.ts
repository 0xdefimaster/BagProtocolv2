import type { Output, Outputs } from '@lifi/compose-spec';

// Shapes of the Compose API as @lifi/composer-sdk 0.6 reads them, for tests.

/** One `outputs` entry as the SDK returns it (amounts as bigint). `min` absent = no floor enforced. */
export function out(expected: bigint | number | string | null, min?: bigint | number | string | null, token = '0x0', chainId = 4663, owner = '0xSigner'): Output {
  return {
    role: 'terminal',
    owner,
    delivery: { when: 'now' },
    resource: { kind: 'erc20', token, chainId },
    amount: {
      ...(expected !== null && expected !== undefined ? { estimate: { basis: 'simulated' as const, value: BigInt(expected) } } : {}),
      ...(min !== null && min !== undefined ? { minimum: { basis: 'op' as const, value: BigInt(min) } } : {}),
    },
  };
}

/** The same entry as it travels on the wire (amounts as decimal strings), for HTTP-level mocks. */
export function wireOut(expected: bigint | number | string | null, min?: bigint | number | string | null, token = '0x0', chainId = 4663, owner = '0xSigner') {
  return {
    role: 'terminal',
    owner,
    delivery: { when: 'now' },
    resource: { kind: 'erc20', token, chainId },
    amount: {
      ...(expected !== null && expected !== undefined ? { estimate: { basis: 'simulated', value: String(expected) } } : {}),
      ...(min !== null && min !== undefined ? { minimum: { basis: 'op', value: String(min) } } : {}),
    },
  };
}

export type { Outputs };

/** A fetch Response stand-in the SDK accepts (it reads the version header). */
export function composeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * A typed Compose SDK refusal, as `compile()` throws it under strict simulation.
 * The SDK does not export the `ComposeError` class at runtime; its guards
 * (`isComposeError`) accept any Error named 'ComposeError' with a `code`.
 */
export async function composeError(kind: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name: 'ComposeError', code: 'VALIDATION_ERROR', kind, ...extra });
}
