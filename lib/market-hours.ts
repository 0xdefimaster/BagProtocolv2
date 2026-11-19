// -----------------------------------------------------------------------------
// US equity regular session (NYSE/Nasdaq): Monday–Friday 09:30–16:00 America/New_York.
//
// Used only to warn: outside the session, tokenized-stock reference prices are
// held at the last close (Chainlink feeds run 24/5) while onchain DEX trading
// continues, so spreads widen and quotes can move away from the last close.
// Exchange holidays and early closes are NOT modelled: on a holiday this says
// "open" when the market is closed. It never blocks anything.
// -----------------------------------------------------------------------------

export type UsMarketStatus = 'OPEN' | 'CLOSED_WEEKEND' | 'CLOSED_OVERNIGHT';

const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 16 * 60;

/** The weekday (0 = Sunday) and minute of the day in New York for `now`. */
function newYorkClock(now: Date): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function usMarketStatus(now: Date = new Date()): UsMarketStatus {
  const { weekday, minute } = newYorkClock(now);
  if (weekday === 0 || weekday === 6) return 'CLOSED_WEEKEND';
  return minute >= OPEN_MINUTE && minute < CLOSE_MINUTE ? 'OPEN' : 'CLOSED_OVERNIGHT';
}
