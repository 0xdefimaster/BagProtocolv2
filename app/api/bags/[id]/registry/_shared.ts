import { NextResponse } from 'next/server';
import type { RegistrationFailure } from '@/lib/server/strategy-registration';

// Error mapping for the StrategyRegistry routes (lib/server/strategy-registration.ts).

const STATUS: Record<RegistrationFailure['error'], number> = {
  NO_WALLET_ON_SESSION: 401,
  BAG_NOT_FOUND: 404,
  FORBIDDEN: 403,
  REGISTRY_NOT_CONFIGURED: 503,
  NOTHING_TO_REGISTER: 409,
  FORK_PARENT_VERSION_UNKNOWN: 409,
  PARENT_NOT_REGISTERED: 409,
  INVALID_TX_HASH: 400,
  TX_ALREADY_USED: 409,
  PENDING: 202,
  VERIFICATION_FAILED: 422,
  CHAIN_ERROR: 502,
};

export function registrationFailureResponse(f: RegistrationFailure) {
  if (f.error === 'PENDING') return NextResponse.json({ status: 'PENDING', code: f.error, message: f.message }, { status: 202 });
  return NextResponse.json({ error: f.message ?? f.error, code: f.error }, { status: STATUS[f.error] ?? 500 });
}
