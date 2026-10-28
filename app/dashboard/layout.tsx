import { AppHeader } from '@/components/app/AppHeader';
import { WalletProvider } from '@/lib/wallet-context';
import './dashboard.css';

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <WalletProvider>
      {/* The app's screen density (components/ui/DensityControl.tsx) scales everything inside this box. */}
      <div className="app-density">
        <AppHeader />
        {children}
      </div>
    </WalletProvider>
  );
}
