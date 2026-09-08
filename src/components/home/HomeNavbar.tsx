'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import ThemeToggle from '@/src/components/ThemeToggle';

// Section anchors rendered on this page (src/app/page.tsx composition).
// These are intentional scroll targets, not routes — the navbar smooth-scrolls
// to them and highlights whichever section is currently in view. Converting
// them into real routes is a bigger scope change and is deliberately NOT done
// here (flagged for Track B instead).
const SECTIONS: { id: string; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'personas', label: "Who it's for" },
  { id: 'products', label: 'Products' },
  { id: 'agents', label: 'Agents' },
  { id: 'developers', label: 'Developers' },
];

export default function HomeNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);

      // Slim scroll-progress indicator (0 → 1 across the whole page).
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setProgress(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);

      // Scroll-spy: the active section is the last one whose top has crossed
      // the navbar line. A plain top-of-viewport sweep (rather than
      // IntersectionObserver) stays stable with the homepage's very uneven
      // section heights (AgentRail is a 300vh sticky rail) and is cheap
      // enough for 5 elements.
      const line = 120; // navbar height + breathing room
      let current: string | null = null;
      for (const { id } of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Intentional scroll-to-section: keep the anchor semantics (URL hash still
  // updates, middle-click/open-in-new-tab still work) but smooth-scroll
  // instead of the default hard jump.
  const scrollToSection = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
    setOpen(false);
  };

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-colors ${
        scrolled
          ? 'bg-[var(--background)]/85 backdrop-blur-xl border-b border-[var(--border)] shadow-sm'
          : 'bg-transparent border-b border-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Image src="/arcflare-logo.png" alt="FlareHQ" width={36} height={36} className="w-8 h-8" />
          <span className="text-lg sm:text-xl font-extrabold tracking-tight">FlareHQ</span>
          <span className="hidden sm:inline-flex text-[10px] font-bold uppercase tracking-widest bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/25 rounded-full px-2.5 py-1">
            Arc
          </span>
        </Link>

        <nav className="hidden lg:flex items-center gap-7 text-sm font-medium text-[var(--text-secondary)]">
          {SECTIONS.map(({ id, label }) => (
            <a
              key={id}
              href={`#${id}`}
              onClick={scrollToSection(id)}
              aria-current={active === id ? 'true' : undefined}
              className={`transition ${
                active === id
                  ? 'text-cyan-600 dark:text-cyan-300 font-semibold'
                  : 'hover:text-[var(--text)]'
              }`}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-3">
          <ThemeToggle />
          <a
            href="https://docs.flarehq.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text)] transition px-2"
          >
            Docs ↗
          </a>
          <Link
            href="/merchant/login"
            className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text)] transition whitespace-nowrap"
          >
            Business Login
          </Link>
          <Link
            href="/start"
            className="text-sm bg-cyan-500 hover:bg-cyan-400 text-white font-bold px-5 py-2.5 rounded-xl transition shadow-[0_8px_24px_rgba(6,182,212,0.35)] whitespace-nowrap"
          >
            Get Started
          </Link>
        </div>

        <div className="flex lg:hidden items-center gap-2">
          <ThemeToggle />
          <button
            id="home-menu-toggle"
            onClick={() => setOpen(!open)}
            aria-label="Toggle navigation menu"
            aria-expanded={open}
            aria-controls="home-menu"
            className="p-2.5 text-[var(--text-secondary)] hover:text-[var(--text)] transition"
          >
            {open ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {/* Scroll-progress indicator — hugs the navbar's bottom border and only
          shows once the page has been scrolled (matching the nav's own
          fade-in) so the transparent top-of-page state stays clean. */}
      <div
        aria-hidden
        className={`absolute bottom-0 left-0 right-0 h-0.5 origin-left bg-gradient-to-r from-cyan-500 to-cyan-300 transition-opacity duration-300 ${
          scrolled ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ transform: `scaleX(${progress})` }}
      />
      {open && (
        <div id="home-menu" className="lg:hidden border-t border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-xl px-4 py-4 flex flex-col gap-1 text-base font-medium">
          {SECTIONS.map(({ id, label }) => (
            <a
              key={id}
              href={`#${id}`}
              onClick={scrollToSection(id)}
              aria-current={active === id ? 'true' : undefined}
              className={`p-2.5 rounded-xl transition ${
                active === id
                  ? 'text-cyan-600 dark:text-cyan-300 bg-[var(--surface-secondary)] font-semibold'
                  : 'hover:bg-[var(--surface-secondary)]'
              }`}
            >
              {label}
            </a>
          ))}
          <Link href="/merchant/login" onClick={() => setOpen(false)} className="p-2.5 rounded-xl hover:bg-[var(--surface-secondary)] transition">
            Business Login
          </Link>
          <Link
            href="/start"
            onClick={() => setOpen(false)}
            className="mt-2 text-center bg-cyan-500 text-white font-bold px-5 py-3.5 rounded-xl"
          >
            Get Started
          </Link>
        </div>
      )}
    </header>
  );
}
