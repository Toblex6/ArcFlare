// src/app/page.tsx — FlareHQ homepage: 7 sections, system-led, no oversell.
import HomeNavbar from '@/src/components/home/HomeNavbar';
import Hero from '@/src/components/home/Hero';
import SystemFlow from '@/src/components/home/SystemFlow';
import PersonaTabs from '@/src/components/home/PersonaTabs';
import ProductGrid from '@/src/components/home/ProductGrid';
import AgentRail from '@/src/components/home/AgentRail';
import DevSplit from '@/src/components/home/DevSplit';
import ClosingCTA from '@/src/components/home/ClosingCTA';

export default function HomePage() {
  return (
    <main className="homepage min-h-screen bg-[var(--background)] text-[var(--text)] overflow-x-hidden">
      <HomeNavbar />
      <Hero />
      <SystemFlow />
      <PersonaTabs />
      <ProductGrid />
      <AgentRail />
      <DevSplit />
      <ClosingCTA />
    </main>
  );
}
