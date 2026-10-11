// Netlify Scheduled Function: the 5-minute NAV pass (/api/cron/snapshot-bag-navs),
// so TVL, returns and the leaderboard follow prices. Same pattern as the other
// cron functions: calls the route with the deployment's CRON_SECRET; the route
// fails closed when it is unset.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:snapshot-bag-navs] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  const res = await fetch(`${base}/api/cron/snapshot-bag-navs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:snapshot-bag-navs] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

export const config = { schedule: '*/5 * * * *' };
