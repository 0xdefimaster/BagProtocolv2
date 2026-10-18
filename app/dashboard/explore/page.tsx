'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { FeaturedBags } from '@/components/app/FeaturedBags';

// The header search lands here as ?q=…; FeaturedBags starts from it.
function ExploreWithQuery() {
  const q = useSearchParams()?.get('q') ?? undefined;
  return <FeaturedBags initialQuery={q} />;
}

export default function ExplorePage() {
  return (
    <main className="min-h-screen bg-black">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <Suspense fallback={<FeaturedBags />}>
          <ExploreWithQuery />
        </Suspense>
      </div>
    </main>
  );
}
