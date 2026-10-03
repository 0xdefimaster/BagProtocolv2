// Netlify Scheduled Function: Re-checks submitted settlement transactions (runReconciliation).
//
// Netlify ignores vercel.json's `crons`, so on Netlify nothing would ever
// call /api/cron/reconcile-creator-rewards. This function runs on the same schedule and calls
// that route with the deployment's CRON_SECRET, exactly like Vercel Cron
// does. The route itself fails closed when CRON_SECRET is unset.
// `URL` is the site's primary URL, set by Netlify at runtime.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:reconcile-creator-rewards] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  const res = await fetch(`${base}/api/cron/reconcile-creator-rewards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:reconcile-creator-rewards] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

export const config = { schedule: '0 * * * *' };
