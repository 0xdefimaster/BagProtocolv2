// -----------------------------------------------------------------------------
// WalletConnect as one more entry in the wallet picker: phone wallets connect
// by scanning a QR code. Only offered when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
// is set (a public Reown project id, not a secret). The SDK is loaded the
// first time the option is used, so it never weighs on the normal page load.
// -----------------------------------------------------------------------------

import { ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC_URL } from '@/lib/config/robinhood-chain';
import type { Eip1193Provider, WalletOption } from './eth-provider';

export const WALLETCONNECT_WALLET_ID = 'walletconnect';

type Handler = (...args: unknown[]) => void;
type WcProvider = Awaited<ReturnType<typeof import('@walletconnect/ethereum-provider').EthereumProvider.init>>;

/** The WalletConnect project id, or null when WalletConnect is not configured. */
export function getWalletConnectProjectId(): string | null {
  const id = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
  return id ? id : null;
}

/**
 * An EIP-1193 provider that starts the WalletConnect SDK on first use.
 * `eth_requestAccounts` opens the QR modal; closing it is reported as a user
 * rejection (code 4001), the same as declining in an extension.
 */
function createLazyWalletConnectProvider(projectId: string): Eip1193Provider {
  let wc: WcProvider | null = null;
  let loading: Promise<WcProvider> | null = null;
  const listeners: [string, Handler][] = [];

  const load = () => {
    loading ??= import('@walletconnect/ethereum-provider')
      .then(({ EthereumProvider }) =>
        EthereumProvider.init({
          projectId,
          optionalChains: [ROBINHOOD_CHAIN_ID],
          rpcMap: { [ROBINHOOD_CHAIN_ID]: ROBINHOOD_PUBLIC_RPC_URL },
          showQrModal: true,
          metadata: {
            name: 'Bag Protocol',
            description: 'Tokenized stock bags on Robinhood Chain',
            url: window.location.origin,
            icons: [`${window.location.origin}/logo.png`],
          },
        })
      )
      .then((provider) => {
        wc = provider;
        for (const [event, handler] of listeners) provider.on(event as never, handler as never);
        return provider;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
    return loading;
  };

  return {
    async request({ method, params }) {
      const provider = await load();
      if (method === 'eth_requestAccounts') {
        try {
          return await provider.enable();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/reject|reset|closed|cancel/i.test(message)) throw Object.assign(new Error(message), { code: 4001 });
          throw err;
        }
      }
      // Without a session (fresh visitor) there are no accounts yet — say so
      // instead of letting the SDK throw on a silent reconnect.
      if (method === 'eth_accounts' && !provider.session) return [];
      return provider.request({ method, params });
    },
    on(event, handler) {
      listeners.push([event, handler]);
      wc?.on(event as never, handler as never);
    },
    removeListener(event, handler) {
      const i = listeners.findIndex(([e, h]) => e === event && h === handler);
      if (i >= 0) listeners.splice(i, 1);
      wc?.removeListener(event as never, handler as never);
    },
    async disconnect() {
      if (wc?.session) await wc.disconnect();
    },
  };
}

let option: WalletOption | null | undefined;

/** The picker entry for WalletConnect, or null when no project id is configured. */
export function getWalletConnectOption(): WalletOption | null {
  if (option !== undefined) return option;
  const projectId = getWalletConnectProjectId();
  option = projectId
    ? { id: WALLETCONNECT_WALLET_ID, name: 'WalletConnect', icon: null, provider: createLazyWalletConnectProvider(projectId) }
    : null;
  return option;
}
