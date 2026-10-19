// -----------------------------------------------------------------------------
// After a trade from this app that moves tokens a Bag tracks (Swap, wallet sweep), ask BAG to check the wallet
// again so positions and Bag TVL follow without waiting for the hourly pass. An outflow is booked only when the
// shortfall is seen twice at least two minutes apart (reconciliation_confirm_after), so: once now, once after that.
// Best effort: a failed request changes nothing; the hourly pass still runs.
// -----------------------------------------------------------------------------

export const RECHECK_CONFIRM_DELAY_MS = 150_000;

function ask(): void {
  void fetch('/api/users/me/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'trade' }),
  }).catch(() => undefined);
}

/** Starts the two checks; returns a function that cancels the second one (e.g. when the page unmounts). */
export function recheckWalletAfterTrade(): () => void {
  ask();
  const timer = setTimeout(ask, RECHECK_CONFIRM_DELAY_MS);
  return () => clearTimeout(timer);
}
