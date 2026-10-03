'use client';

import { Hero } from '@/components/app/Hero';
import { Dashboard } from '@/components/app/Dashboard';
import { FeaturedBags } from '@/components/app/FeaturedBags';
import { useWallet } from '@/lib/wallet-context';

export default function AppPage() {
  const { isConnected } = useWallet();

  return (
    <main style={{ minHeight: '100vh' }}>
      <div className="wrap" style={{ paddingBottom: 80 }}>
        {isConnected ? (
          <Dashboard isConnected={isConnected} />
        ) : (
          <>
            <Hero isConnected={isConnected} />
            <div style={{ marginTop: 56 }}>
              <FeaturedBags />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
