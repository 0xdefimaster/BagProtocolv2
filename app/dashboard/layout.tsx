import { AppHeader } from '@/components/app/AppHeader';
import { AppSidebar } from '@/components/app/AppSidebar';
import { WalletProvider } from '@/lib/wallet-context';
import './dashboard.css';

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <WalletProvider>
      <div className="app-shell">
        <AppSidebar />
        <div className="app-main">
          <AppHeader />
          {children}
        </div>
      </div>
    </WalletProvider>
  );
}
