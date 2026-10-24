import { NextRequest, NextResponse } from 'next/server';
import { localDcaRequestAllowed } from '@/lib/server/dca-trial';
import { loadPublicDcaBag, publicDcaSourceEnabled } from '@/lib/server/dca-public-bags';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!localDcaRequestAllowed(request) || !publicDcaSourceEnabled()) return NextResponse.json({ error: 'Local trial is not enabled.' }, { status: 404 });
  try {
    const { bag, document } = await loadPublicDcaBag((await params).id);
    return NextResponse.json({ bag, definitionHash: document.definitionHash, source: 'bagprotocol.com' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'This BAG could not be verified. Reload the BAG list and try again.' }, { status: 422 }); }
}
