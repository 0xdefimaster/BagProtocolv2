// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DcaTrialPanel } from '../DcaTrialPanel';
import { DCA_REFERENCE_BAG } from '@/lib/dca/reference';
import { buildDcaPlan } from '@/lib/dca/plan';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows a local-only schedule and recalculates complete purchases and remainder', () => {
  render(<DcaTrialPanel bag={DCA_REFERENCE_BAG} />);
  expect(screen.getByText('10 purchases')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Total budget (USDG)'), { target: { value: '105' } });
  expect(screen.getByText('Unallocated remainder: 5 USDG')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Amount per purchase (USDG)'), { target: { value: '20' } });
  expect(screen.getByText('5 purchases')).toBeTruthy();
  expect(screen.getByText(/Your wallet is not charged/)).toBeTruthy();
});
it('does not allow a different token or invalid amounts to run', () => {
  const view = render(<DcaTrialPanel bag={{ ...DCA_REFERENCE_BAG, chains: ['ethereum'] }} />);
  expect(screen.getByRole('button', { name: 'Run local trial' })).toBeDisabled();
  view.rerender(<DcaTrialPanel bag={DCA_REFERENCE_BAG} />);
  fireEvent.change(screen.getByLabelText('Amount per purchase (USDG)'), { target: { value: '0' } });
  expect(screen.getByRole('button', { name: 'Run local trial' })).toBeDisabled();
});
it('submits only settings to the selected Bag and reports a failed start', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Local trial is not enabled.' }) }); vi.stubGlobal('fetch', fetch);
  render(<DcaTrialPanel bag={DCA_REFERENCE_BAG} />); fireEvent.click(screen.getByRole('button', { name: 'Run local trial' }));
  await screen.findByText('Local trial is not enabled.');
  expect(fetch.mock.calls[0][0]).toBe('/api/bags/local-reference/dca-trial');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ budget: '100', amount: '10', interval: '1', unit: 'days' });
});
it('polls the real job response without inventing completed purchases', async () => {
  const plan = buildDcaPlan({ budget: '100', amount: '10', interval: '1', unit: 'days' });
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ trial: { id: 'job', state: 'RUNNING', plan, completedChecks: 2, completedPurchases: 0 } }) }).mockResolvedValue({ ok: true, json: async () => ({ trial: { id: 'job', state: 'FAILED', plan, error: 'Trial stopped.' } }) }); vi.stubGlobal('fetch', fetch);
  render(<DcaTrialPanel bag={DCA_REFERENCE_BAG} />); fireEvent.click(screen.getByRole('button', { name: 'Run local trial' }));
  await screen.findByText('0/10 purchases · 2 checks passed');
  await waitFor(() => expect(screen.getByText('Trial stopped.')).toBeTruthy(), { timeout: 4000 });
});
