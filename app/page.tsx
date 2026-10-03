import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import Hero from "@/components/landing/Hero";
import Thesis from "@/components/landing/Thesis";
import Problem from "@/components/landing/Problem";
import Primitive from "@/components/landing/Primitive";
import CreatorFi from "@/components/landing/CreatorFi";
import ForkLineage from "@/components/landing/ForkLineage";
import Audiences from "@/components/landing/Audiences";
import FeaturedBagsSection from "@/components/landing/FeaturedBagsSection";
import HowItWorks from "@/components/landing/HowItWorks";
import Networks from "@/components/landing/Networks";
import Different from "@/components/landing/Different";
import Spec from "@/components/landing/Spec";
import Architecture from "@/components/landing/Architecture";
import Roadmap from "@/components/landing/Roadmap";
import CTA from "@/components/landing/CTA";
import ScrollReveal from "@/components/animations/ScrollReveal";

// -----------------------------------------------------------------------------
// Landing story, one question per section:
//   What is Bag? (Hero + Thesis) → Why does it exist? (Problem) → What is new?
//   (Primitive) → Why create on it? (CreatorFi, ForkLineage) → Who is it for?
//   (Audiences) → What does a strategy look like? (Discovery) → How does it
//   work? (HowItWorks) → Where? (Networks) → Why is it different? (Different)
//   → What is the format / stack? (Spec, Architecture) → What is live?
//   (Roadmap/Status) → CTA.
// -----------------------------------------------------------------------------

export default function LandingPage() {
  return (
    <>
      <ScrollReveal />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Thesis />
        <Problem />
        <Primitive />
        <CreatorFi />
        <ForkLineage />
        <Audiences />
        <FeaturedBagsSection />
        <HowItWorks />
        <Networks />
        <Different />
        <div id="protocol">
          <Spec />
          <Architecture />
        </div>
        <Roadmap />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
