import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { definitionFromRecipe, computeDefinitionHash } from '@/lib/domain/basket-protocol/bag-json';
import { buildDcaPlan, DcaPlanError, usdgRaw, type DcaSettings } from '@/lib/dca/plan';
import { supportsDcaTrial } from '@/lib/dca/profile';
import { getDcaTrial, localDcaRequestAllowed, startDcaTrial } from '@/lib/server/dca-trial';
import { DCA_REFERENCE_DEFINITION, DCA_REFERENCE_ID } from '@/lib/dca/reference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const hidden = () => NextResponse.json({ error: 'Local trial is not enabled.' }, { status: 404 });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!localDcaRequestAllowed(request)) return hidden();
  if (Number(request.headers.get('content-length') ?? 0) > 2048) return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
  const text = await request.text();
  if (text.length > 2048) return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
  let settings: DcaSettings;
  try { settings = JSON.parse(text); } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  try {
    const plan = buildDcaPlan(settings);
    const { id } = await params;
    if (id === DCA_REFERENCE_ID) {
      const definition = DCA_REFERENCE_DEFINITION;
      const trial = await startDcaTrial(id, { bagJson: 1, definition }, computeDefinitionHash(definition), settings, plan);
      return NextResponse.json({ trial }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 });
    const admin = supabaseAdmin();
    const stored = await getBagById(admin, id);
    if (!stored || stored.status !== 'ACTIVE') return NextResponse.json({ error: 'Live Bag not found.' }, { status: 404 });
    const version = await getCurrentBagVersion(admin, stored.id);
    if (!version) return NextResponse.json({ error: 'Current strategy is unavailable.' }, { status: 409 });
    const recipe = version.recipe;
    if (!supportsDcaTrial({ chains: [recipe.chain], composition: recipe.assets.map(a => ({ address: a.address, weightBps: a.weightBps, weight: a.weightBps / 100, symbol: a.symbol })) })) return NextResponse.json({ error: 'The local trial currently supports 40% WETH / 30% cbBTC / 30% USDG on Robinhood.' }, { status: 422 });
    const definition = definitionFromRecipe(recipe);
    if (definition.rules.performanceFeeBps) return NextResponse.json({ error: 'The local trial does not support Bags with a performance fee.' }, { status: 422 });
    if (definition.rules.minInvestment && BigInt(plan.amountRaw) < usdgRaw(definition.rules.minInvestment.amount)) throw new DcaPlanError('The purchase amount is below this Bag’s minimum investment.');
    const trial = await startDcaTrial(id, { bagJson: 1, definition }, computeDefinitionHash(definition), settings, plan);
    return NextResponse.json({ trial }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof DcaPlanError ? err.message : 'The trial could not start. Check that another trial is not running and the local configuration is available.' }, { status: err instanceof DcaPlanError ? 400 : 409 });
  }
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!localDcaRequestAllowed(request)) return hidden();
  const { id } = await params;
  const trialId = request.nextUrl.searchParams.get('trial');
  const trial = trialId && /^[a-f0-9-]{36}$/.test(trialId) ? getDcaTrial(trialId, id) : null;
  return trial ? NextResponse.json({ trial }, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'Trial not found. The development server may have restarted.' }, { status: 404 });
}
