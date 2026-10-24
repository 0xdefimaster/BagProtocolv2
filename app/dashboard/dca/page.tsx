import { notFound } from 'next/navigation';
import { DcaLab } from '@/components/bags/DcaLab';

export default function DcaPage() {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DCA_TRIAL !== 'true' || process.env.BAG_DCA_TRIAL !== 'true') notFound();
  return <main className="min-h-screen bg-black"><div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
    <p className="mb-2 text-xs font-medium uppercase tracking-widest text-emerald-300">Local experiment</p>
    <h1 className="text-3xl font-semibold text-white">DCA</h1>
    <p className="mt-3 mb-8 max-w-2xl text-white/60">Try scheduled Bag purchases with a fixed USDG budget. This experiment does not activate live trading or change your existing positions.</p>
    <DcaLab />
  </div></main>;
}
