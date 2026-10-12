// Netlify Scheduled Function: Pays EARNED fork royalties on-chain (runSettlementBatch).
//
// Netlify ignores vercel.json's `crons`, so on Netlify nothing would ever
// call /api/cron/settle-creator-rewards. This function runs on the same schedule and calls
// that route with the deployment's CRON_SECRET, exactly like Vercel Cron
// does. The route itself fails closed when CRON_SECRET is unset.
// `URL` is the site's primary URL, set by Netlify at runtime.

export default async function handler(): Promise<Response> {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error('[cron:settle-creator-rewards] URL or CRON_SECRET is not set — skipping.');
    return new Response('not configured', { status: 503 });
  }

  // The route needs the vault address and the settler key (createVaultChainClient).
  // Skipped here, before the route is invoked, so an unconfigured deployment does not spend a
  // function run (and Netlify credits) every few minutes on a call that can only return 503.
  const missing = ['CREATOR_REWARDS_VAULT_ADDRESS', 'CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`[cron:settle-creator-rewards] ${missing.join(', ')} not set — skipping.`);
    return new Response(`skipped: ${missing.join(', ')} not set`, { status: 200 });
  }

  const res = await fetch(`${base}/api/cron/settle-creator-rewards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) console.error(`[cron:settle-creator-rewards] ${res.status}: ${body.slice(0, 500)}`);
  return new Response(body, { status: res.status });
}

// Every 15 minutes: a fork royalty is credited within the quarter hour; every 5 minutes cost three
// times the function runs for no user-visible gain.
export const config = { schedule: '*/15 * * * *' };
