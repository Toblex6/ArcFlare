'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useSpring } from 'framer-motion';
import Link from 'next/link';
import Image from 'next/image';
import ThemeToggle from '@/src/components/ThemeToggle';

export default function HomeNavbar() {
  const [hidden, setHidden] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const lastY = useRef(0);
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 25 });

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 24);
      // hide on scroll down, reveal on scroll up
      if (y > lastY.current && y > 320 && !open) setHidden(true);
      else setHidden(false);
      lastY.current = y;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [open ]);

  return (
    <>
      <motion.header
        animate={{ y: hidden ? '-100%' : '0%' }}
        transition={{ duration: 0.32, ease: 'easeOut' }}
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
            <a href="#products" className="hover:text-[var(--text)] transition">Products</a>
            <a href="#agents" className="hover:text-[var(--text)] transition">Agents</a>
            <a href="#developers" className="hover:text-[var(--text)] transition">Developers</a>
            <a href="#personas" className="hover:text-[var(--text)] transition">Who it&apos;s for</a>
            <a href="/stats" className="hover:text-[var(--text)] transition">Live stats</a>
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

          <div className="flex md:hidden items-center gap-2">
            <ThemeToggle />
            <button
              onClick={() => setOpen(!open)}
              aria-label="Toggle navigation menu"
              className="p-2 text-[var(--text-secondary)] hover:text-[var(--text)] transition"
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
        <motion.div style={{ scaleX: progress }} className="h-[2px] origin-left bg-gradient-to-r from-cyan-400 via-sky-500 to-amber-400" />
        {open && (
          <div className="md:hidden border-t border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-xl px-4 py-4 flex flex-col gap-1 text-base font-medium">
            {[
              ['Products', '#products'],
              ['Agents', '#agents'],
              ['Developers', '#developers'],
              ['Who it’s for', '#personas'],
              ['Live stats', '/stats'],
            ].map(([label, href]) => (
              <a key={href} href={href} onClick={() => setOpen(false)} className="p-2.5 rounded-xl hover:bg-[var(--surface-secondary)] transition">
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
      </motion.header>
    </>
  );
}
