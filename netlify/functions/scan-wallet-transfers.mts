// Netlify Scheduled Function: every minute, the Transfer-log scan only
// (/api/cron/scan-wallet-transfers), so a token leaving a holder's wallet shows
// in positions and Bag TVL within a minute or two. When nothing moved it costs a
// couple of chain reads and no database writes. The hourly reconcile-wallets
// pass still does the full round-robin checks. Same pattern as the other cron
// functions: calls the route with the deployment's CRON_SECRET; the route fails
// closed when it is unset.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:scan-wallet-transfers] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  const res = await fetch(`${base}/api/cron/scan-wallet-transfers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:scan-wallet-transfers] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

export const config = { schedule: '* * * * *' };
