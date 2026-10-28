import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VersionChange } from '@/lib/server/bag-versioning';
import { buildEditedRecipe, parseCompositionEdit } from '@/lib/server/strategy-edit';

// Shared request parsing / error mapping for the version-update routes.

/**
 * The body is either { recipe } (a whole new recipe) or { composition: [{ address, weightBps }] } from the Edit
 * strategy screen, where only the assets change and the rest of the recipe is the current version's
 * (lib/server/strategy-edit.ts). Both may carry reason and txHash. Returns the parsed body or the error response.
 */
export async function resolveVersionBody(
  admin: SupabaseClient,
  bagId: string,
  raw: unknown
): Promise<{ ok: true; body: { recipe: VersionChange; reason: string; txHash: string } } | { ok: false; response: NextResponse }> {
  const b = raw && typeof raw === 'object' ? (raw as { recipe?: unknown; composition?: unknown }) : null;
  if (b && b.recipe === undefined && b.composition !== undefined) {
    const edit = parseCompositionEdit(b.composition);
    if (!edit) {
      return { ok: false, response: NextResponse.json({ error: 'composition must be a list of { address, weightBps }.', code: 'BAD_REQUEST' }, { status: 400 }) };
    }
    const built = await buildEditedRecipe(admin, bagId, edit);
    if (!built.ok) return { ok: false, response: versionFailureResponse(built) };
    const parsed = parseVersionBody({ ...(raw as object), recipe: built.recipe });
    return parsed ? { ok: true, body: parsed } : { ok: false, response: NextResponse.json({ error: 'Bad request.', code: 'BAD_REQUEST' }, { status: 400 }) };
  }
  const parsed = parseVersionBody(raw);
  if (!parsed) {
    return { ok: false, response: NextResponse.json({ error: 'Body must be { recipe | composition, reason?, txHash? }.', code: 'BAD_REQUEST' }, { status: 400 }) };
  }
  return { ok: true, body: parsed };
}

export function parseVersionBody(body: unknown): { recipe: VersionChange; reason: string; txHash: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { recipe?: unknown; reason?: unknown; txHash?: unknown };
  if (!b.recipe || typeof b.recipe !== 'object' || Array.isArray(b.recipe)) return null;
  return {
    recipe: b.recipe as VersionChange,
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
  PROPOSAL_NOT_SAVED: 503,
  PROPOSAL_CONFLICT: 409,
  IMMUTABLE_FIELD: 422,
  NO_PROPOSAL: 409,
  NOT_FOUND_ON_CHAIN: 409,
  CHAIN_BEHIND: 409,
  CHAIN_ERROR: 502,
};

export function versionFailureResponse(result: Failure) {
  const { ok: _ok, error, ...rest } = result;
  void _ok;
  if (error === 'PENDING') return NextResponse.json({ status: 'PENDING', code: error, ...rest }, { status: 202 });
  return NextResponse.json({ error, code: error, ...rest }, { status: STATUS[error] ?? 500 });
}
