// Netlify Scheduled Function: refreshes the asset registry's liquidity status
// (/api/cron/refresh-asset-routes, up to 40 assets per run, oldest first).
// Same pattern as settle-creator-rewards.mts: calls the route with the
// deployment's CRON_SECRET; the route fails closed when it is unset.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:refresh-asset-routes] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  const res = await fetch(`${base}/api/cron/refresh-asset-routes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:refresh-asset-routes] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

export const config = { schedule: '*/15 * * * *' };
