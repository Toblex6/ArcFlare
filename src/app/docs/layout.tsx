import Link from "next/link";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto flex">
        <aside className="w-64 border-r border-zinc-800 p-6 sticky top-0 h-screen">
          <h2 className="text-xl font-bold mb-6">
            ArcFlare Docs
          </h2>

          <nav className="space-y-3">
            <Link
              href="/docs"
              className="block text-zinc-300 hover:text-white"
            >
              Overview
            </Link>

            <Link
              href="/docs/api"
              className="block text-zinc-300 hover:text-white"
            >
              API Reference
            </Link>

            <Link
              href="/docs/merchant"
              className="block text-zinc-300 hover:text-white"
            >
              Merchant Guide
            </Link>

            <Link
              href="/docs/agents"
              className="block text-zinc-300 hover:text-white"
            >
              Agent Guide
            </Link>
          </nav>
        </aside>

        <main className="flex-1 p-10">
          {children}
        </main>
      </div>
    </div>
  );
}