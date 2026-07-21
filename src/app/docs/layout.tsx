import Link from 'next/link';
import Image from 'next/image';

const docsLinks = [
  { href: '/docs', label: 'Overview' },
  { href: '/docs/api', label: 'API Reference' },
  { href: '/docs/merchant', label: 'Merchant Guide' },
  { href: '/docs/agents', label: 'Agent Guide' },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#120b08] text-white">
      <div className="border-b border-[#2a1d16] bg-[#120b08]/95">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={38} height={38} />
            <div>
              <p className="text-lg font-bold leading-tight">FlareHQ Docs</p>
              <p className="text-xs text-gray-500">Built on Arc Testnet</p>
            </div>
          </Link>

          <nav className="flex flex-wrap gap-3 text-sm">
            {docsLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-full border border-[#3a2a22] bg-[#1a120d] px-4 py-2 text-gray-300 transition hover:border-cyan-900/60 hover:text-cyan-300"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-8 px-6 py-10 lg:grid-cols-[17rem_1fr]">
        <aside className="hidden lg:block">
          <div className="sticky top-8 rounded-3xl border border-[#2d2019] bg-[#1a120d] p-6">
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
              Documentation
            </p>

            <nav className="space-y-2">
              {docsLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="block rounded-2xl px-4 py-3 text-sm text-gray-400 transition hover:bg-[#241913] hover:text-cyan-300"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
        </aside>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
