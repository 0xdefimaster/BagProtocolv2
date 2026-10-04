// Netlify Scheduled Function: the 5-minute safety pass of wallet reconciliation
// (/api/cron/reconcile-wallets). Same pattern as the other cron functions:
// calls the route with the deployment's CRON_SECRET; the route fails closed
// when it is unset.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:reconcile-wallets] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  const res = await fetch(`${base}/api/cron/reconcile-wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:reconcile-wallets] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

export const config = { schedule: '*/5 * * * *' };
