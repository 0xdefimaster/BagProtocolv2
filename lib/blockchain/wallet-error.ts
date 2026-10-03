// -----------------------------------------------------------------------------
// Turns whatever a wallet / RPC / viem call threw into a readable message.
//
// Injected wallets (EIP-1193) often reject with a PLAIN OBJECT —
// `{ code: 4001, message: 'User rejected the request.' }` or a nested
// `{ code: -32603, message, data: { message } }` — not an `Error`, so
// `String(err)` printed "[object Object]" and a plain-object rejection was
// not even recognised as a rejection. viem errors are `Error`s whose useful
// text is in `shortMessage` / `details`, with the provider's code on a
// `cause`. This walks both shapes; it never throws.
// -----------------------------------------------------------------------------

export interface WalletErrorDescription {
  message: string;
  code: number | string | undefined;
  /** The user declined in their wallet (EIP-1193 4001, ethers ACTION_REJECTED, or the usual wording). */
  rejected: boolean;
}

type Loose = { message?: unknown; shortMessage?: unknown; details?: unknown; code?: unknown; data?: unknown; error?: unknown; cause?: unknown };

function asLoose(value: unknown): Loose | null {
  return value && typeof value === 'object' ? (value as Loose) : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return undefined;
}

export function describeWalletError(err: unknown): WalletErrorDescription {
  let message: string | undefined;
  let code: number | string | undefined;
  // Walk err → cause / error / data (max a few levels) collecting the first message and code.
  let node: unknown = err;
  for (let depth = 0; depth < 5 && node; depth++) {
    const o = asLoose(node);
    if (!o) {
      message ??= firstString(node);
      break;
    }
    message ??= firstString(o.shortMessage, o.message, o.details);
    if (code === undefined && (typeof o.code === 'number' || typeof o.code === 'string')) code = o.code;
    node = o.cause ?? o.error ?? (asLoose(o.data) ? o.data : undefined);
  }
  if (!message) {
    try {
      message = JSON.stringify(err)?.slice(0, 300);
    } catch {
      message = undefined;
    }
  }
  message = message || 'Unknown wallet error.';
  const lower = message.toLowerCase();
  const rejected =
    code === 4001 || code === '4001' || code === 'ACTION_REJECTED' || lower.includes('user rejected') || lower.includes('rejected the request') || lower.includes('denied') || lower.includes('user cancel');
  const withCode = code !== undefined && !message.includes(String(code)) ? `${message} (code ${code})` : message;
  return { message: withCode, code, rejected };
}
