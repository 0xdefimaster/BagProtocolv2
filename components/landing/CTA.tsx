import Image from "next/image";
import Link from "next/link";
import ArrowIcon from "@/components/ui/ArrowIcon";

export default function CTA() {
  return (
    <section className="wrap" id="start">
      <div className="cta" data-reveal>
        <Image className="cta-mark" src="/hero/glass-mark.png" alt="" width={120} height={120} />
        <div className="cta-inner">
          <h2>Invest in a strategy. Or publish one.</h2>
          <p>
            Explore what creators have published, or turn your own strategy into a Bag others
            can invest in and build on.
          </p>
          <div className="cta-actions">
            <Link className="btn btn-primary btn-lg" href="/dashboard/explore">
              Explore Bags
              <ArrowIcon />
            </Link>
            <Link className="btn btn-ghost btn-lg" href="/dashboard/create">
              Create a Bag
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
