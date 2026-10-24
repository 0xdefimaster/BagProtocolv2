import { NextRequest, NextResponse } from 'next/server';
import { localDcaRequestAllowed } from '@/lib/server/dca-trial';
import { listPublicDcaBags, publicDcaSourceEnabled } from '@/lib/server/dca-public-bags';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  if (!localDcaRequestAllowed(request) || !publicDcaSourceEnabled()) return NextResponse.json({ error: 'Local trial is not enabled.' }, { status: 404 });
  try { return NextResponse.json({ bags: await listPublicDcaBags(), source: 'bagprotocol.com' }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'The public BAG list could not be loaded. Try again.' }, { status: 502 }); }
}
