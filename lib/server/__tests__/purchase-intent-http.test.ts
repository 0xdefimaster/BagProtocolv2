import { describe, expect, it } from 'vitest';
import { purchaseExecutionErrorResponse } from '../purchase-intent-http';

// Each failure says what actually went wrong; none of them is the old blanket "Live pricing is temporarily unavailable".
describe('purchaseExecutionErrorResponse — accurate reasons', () => {
  it('a valuation failure names the unpriced holdings and says nothing was sent', async () => {
    const res = purchaseExecutionErrorResponse({ kind: 'VALUATION_UNAVAILABLE', assets: [{ chain: 'robinhood', address: '0xabc' }] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'VALUATION_UNAVAILABLE', assets: [{ chain: 'robinhood', address: '0xabc' }] });
    expect(body.error).toContain('Nothing was sent');
    expect(body.error).not.toContain('Live pricing');
  });

  it("an unreachable Stock Token registry is reported as the registry, not as pricing", async () => {
    const res = purchaseExecutionErrorResponse({ kind: 'STOCK_REGISTRY_UNAVAILABLE', message: 'down' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('STOCK_REGISTRY_UNAVAILABLE');
    expect(body.error).toContain('registry');
  });
});
