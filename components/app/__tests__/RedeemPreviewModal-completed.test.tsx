// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const state = vi.hoisted(() => ({ phase: 'idle' as string }));
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ isConnected: true, walletAddress: '0xabc', authUser: { id: 'u1' } }) }));
vi.mock('@/hooks/use-redeem-execution', () => ({
  useRedeemExecution: () => ({
    state: { phase: state.phase, walletStep: null, intent: null, activeStepIndex: null, error: null, failureCode: null, errorCode: null, resumable: null, blocking: null },
    start: vi.fn(),
    reset: vi.fn(),
    resume: vi.fn(),
  }),
}));

const { RedeemPreviewModal } = await import('../RedeemPreviewModal');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RedeemPreviewModal onCompleted', () => {
  it('fires once when the sale finishes, not on later re-renders', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) })));
    const onCompleted = vi.fn();
    state.phase = 'confirming';
    const { rerender } = render(<RedeemPreviewModal bagId="b1" bagName="Bag" onClose={() => {}} onCompleted={onCompleted} />);
    expect(onCompleted).not.toHaveBeenCalled();

    state.phase = 'completed';
    rerender(<RedeemPreviewModal bagId="b1" bagName="Bag" onClose={() => {}} onCompleted={onCompleted} />);
    rerender(<RedeemPreviewModal bagId="b1" bagName="Bag" onClose={() => {}} onCompleted={() => onCompleted()} />);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('a partial sale also refreshes the page behind', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) })));
    const onCompleted = vi.fn();
    state.phase = 'partial';
    render(<RedeemPreviewModal bagId="b1" bagName="Bag" onClose={() => {}} onCompleted={onCompleted} />);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
});
