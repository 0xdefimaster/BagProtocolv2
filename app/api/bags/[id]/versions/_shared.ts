import { NextResponse } from 'next/server';
import type { NewVersionRecipe } from '@/lib/server/bag-versioning';

// Shared request parsing / error mapping for the version-update routes.

export function parseVersionBody(body: unknown): { recipe: NewVersionRecipe; reason: string; txHash: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { recipe?: unknown; reason?: unknown; txHash?: unknown };
  if (!b.recipe || typeof b.recipe !== 'object' || Array.isArray(b.recipe)) return null;
  return {
    recipe: b.recipe as NewVersionRecipe,
    reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : 'Composition update',
    txHash: typeof b.txHash === 'string' ? b.txHash : '',
  };
}

type Failure = { ok: false; error: string; [k: string]: unknown };

const STATUS: Record<string, number> = {
  NO_WALLET_ON_SESSION: 401,
  INVALID_TX_HASH: 400,
  BAG_NOT_FOUND: 404,
  FORBIDDEN: 403,
  WRONG_WALLET: 403,
  BAG_ARCHIVED: 409,
  IMMUTABLE_BAG: 409,
  NOT_DEPLOYED: 409,
  NO_CHANGE: 409,
  PERFORMANCE_FEE_LOCKED: 409,
  OUT_OF_SYNC: 409,
  STALE_VERSION: 409,
  DEPLOYMENT_MISMATCH: 409,
  TX_ALREADY_USED: 409,
  VALIDATION_FAILED: 422,
  VERIFICATION_FAILED: 422,
  PENDING: 202,
  CHAIN_UNAVAILABLE: 503,
  CHAIN_ERROR: 502,
};

export function versionFailureResponse(result: Failure) {
  const { ok: _ok, error, ...rest } = result;
  void _ok;
  if (error === 'PENDING') return NextResponse.json({ status: 'PENDING', code: error, ...rest }, { status: 202 });
  return NextResponse.json({ error, code: error, ...rest }, { status: STATUS[error] ?? 500 });
}
