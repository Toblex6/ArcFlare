// src/app/page.tsx — FlareHQ modern homepage (server component composing client sections)
import HomeNavbar from '@/src/components/home/HomeNavbar';
import Hero from '@/src/components/home/Hero';
import StatsStrip from '@/src/components/home/StatsStrip';
import Marquee from '@/src/components/home/Marquee';
import ProductGrid from '@/src/components/home/ProductGrid';
import AgentRail from '@/src/components/home/AgentRail';
import DevSplit from '@/src/components/home/DevSplit';
import PersonaTabs from '@/src/components/home/PersonaTabs';
import ClosingCTA from '@/src/components/home/ClosingCTA';

export default function HomePage() {
  return (
    <main className="homepage min-h-screen bg-[var(--background)] text-[var(--text)] overflow-x-hidden">
      <HomeNavbar />
      <Hero />
      <StatsStrip />
      <div className="mt-10 md:mt-14">
        <Marquee />
      </div>
      <ProductGrid />
      <AgentRail />
      <DevSplit />
      <PersonaTabs />
      <ClosingCTA />
    </main>
  );
}
