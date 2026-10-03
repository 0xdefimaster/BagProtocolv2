import { AppHeader } from '@/components/app/AppHeader';
import { WalletProvider } from '@/lib/wallet-context';
import './dashboard.css';



export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <WalletProvider>
      <AppHeader />
      {children}
    </WalletProvider>
  );
}
