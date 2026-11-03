import type { Pool } from 'pg';

// -----------------------------------------------------------------------------
// Closing a pg Pool so that NO client socket is still open afterwards.
//
// `pool.end()` resolves too early for a test teardown that then drops the
// database: pg-pool's `_remove()` takes each client out of the pool's list
// synchronously and calls `client.end()` without waiting for it, and `end()`
// resolves as soon as that list is empty. The client's socket may still be
// open, and the pool has already detached the idle 'error' listener. A
// `drop database … with (force)` issued at that moment terminates the backend,
// which sends FATAL 57P01 ("terminating connection due to administrator
// command") to the still-open socket; the client emits 'error' with no
// listener and Node reports an uncaught exception.
//
// pg-pool emits 'remove' from inside each `client.end()` callback, i.e. after
// that client's connection has ended. Waiting for one 'remove' per client the
// pool held removes the race instead of hiding its error: a client that is
// genuinely leaked (never released) keeps `end()` pending and the hook times
// out visibly.
// -----------------------------------------------------------------------------

export async function endPoolCompletely(pool: Pool): Promise<void> {
  if (pool.ended) return;
  const held = pool.totalCount;
  const allRemoved = new Promise<void>((resolve) => {
    if (held === 0) return resolve();
    let removed = 0;
    pool.on('remove', () => {
      if (++removed >= held) resolve();
    });
  });
  await pool.end();
  await allRemoved;
}
