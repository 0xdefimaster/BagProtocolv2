'use client';

import { useMemo } from 'react';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';
import { useNativeGasReserve, usePaymentBalance, usableBalanceRaw } from '@/hooks/use-payment-balance';
import { formatRawAmount, parseDecimalToRaw, rawToPlainDecimal } from '@/lib/format';

// -----------------------------------------------------------------------------
// The creator's balance of what the launch buy is paid with (the chain's
// stablecoin, or its native ETH), shown right under the amount field so it
// doesn't have to be looked up in the wallet. Same reading as the purchase
// modal (hooks/use-payment-balance.ts): the asset's own chain, never a guess.
//
// Display and a hint only: nothing here blocks the deploy. The purchase
// itself still checks the real balance on chain.
// -----------------------------------------------------------------------------

interface LaunchBuyBalanceProps {
  chain: string;
  native: boolean;
  walletAddress: string | null;
  amount: string;
  onMax(amount: string): void;
}

export function LaunchBuyBalance({ chain, native, walletAddress, amount, onMax }: LaunchBuyBalanceProps) {
  // Token, symbol and decimals come only from lib/config/chains.ts: the
  // chain's stablecoin (USDG on Robinhood Chain) or its native currency.
  const asset = useMemo(() => {
    if (!isBagChain(chain)) return null;
    const config = BAG_CHAINS[chain];
    return native
      ? { chain, address: NATIVE_ASSET_ADDRESS, decimals: config.nativeCurrency.decimals, symbol: config.nativeCurrency.symbol }
      : { chain, address: config.sweepOutputToken.address, decimals: config.sweepOutputToken.decimals, symbol: config.sweepOutputToken.symbol };
  }, [chain, native]);

  const balance = usePaymentBalance(asset, walletAddress);
  const gasReserveRaw = useNativeGasReserve(asset ? chain : null, native);

  if (!asset || !walletAddress || balance.status === 'idle') return null;

  // Null while unknown: then MAX is off and no hint is shown.
  const usableRaw =
    balance.status === 'ready' && balance.balanceRaw !== null && (!native || gasReserveRaw !== null)
      ? usableBalanceRaw(balance.balanceRaw, native, gasReserveRaw ?? BigInt(0))
      : null;
  const amountRaw = parseDecimalToRaw(amount, asset.decimals);
  const overBalance = usableRaw !== null && amountRaw !== null && BigInt(amountRaw) > usableRaw;

  return (
    <div data-testid="launch-buy-balance" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 8, fontSize: 12, color: 'var(--ink-soft, #B4AEA2)' }}>
      {balance.status === 'loading' ? (
        <span>Balance: …</span>
      ) : balance.status === 'error' || balance.balanceRaw === null ? (
        <>
          <span>Balance unavailable</span>
          <button
            type="button"
            onClick={balance.refetch}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--gold-lt, #F0DFC0)', fontSize: 12, textDecoration: 'underline' }}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          {overBalance && <span style={{ color: 'var(--red, #E5786D)' }}>More than your balance</span>}
          <span>
            Balance: {formatRawAmount(balance.balanceRaw.toString(), asset.decimals, native ? { maxFractionDigits: 6 } : { maxFractionDigits: 2, padFraction: true })} {asset.symbol}
          </span>
          <button
            type="button"
            disabled={usableRaw === null || usableRaw === BigInt(0)}
            onClick={() => {
              if (usableRaw !== null) onMax(rawToPlainDecimal(usableRaw, asset.decimals));
            }}
            style={{
              background: 'var(--gold-tint, rgba(217,185,139,0.1))',
              border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
              borderRadius: 6,
              padding: '1px 7px',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--gold-lt, #F0DFC0)',
              cursor: usableRaw === null || usableRaw === BigInt(0) ? 'not-allowed' : 'pointer',
              opacity: usableRaw === null || usableRaw === BigInt(0) ? 0.5 : 1,
            }}
          >
            MAX
          </button>
        </>
      )}
    </div>
  );
}
