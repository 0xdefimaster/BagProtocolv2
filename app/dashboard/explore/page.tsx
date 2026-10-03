'use client';

import { FeaturedBags } from '@/components/app/FeaturedBags';

export default function ExplorePage() {
  return (
    <main className="min-h-screen bg-black">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <FeaturedBags />
      </div>
    </main>
  );
}
