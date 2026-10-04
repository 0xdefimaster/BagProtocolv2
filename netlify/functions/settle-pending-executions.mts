// Netlify Scheduled Function: settles purchases/redemptions that are on chain
// but were never verified because the user left before confirmation
// (/api/cron/settle-pending-executions, up to 25 of each per run). Same
// pattern as the other cron functions: calls the route with the deployment's
// CRON_SECRET; the route fails closed when it is unset.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:settle-pending-executions] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  const res = await fetch(`${base}/api/cron/settle-pending-executions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:settle-pending-executions] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

export const config = { schedule: '*/5 * * * *' };
