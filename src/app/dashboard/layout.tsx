import Image from "next/image";
import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-darkbg text-white">
      <header className="border-b border-copper/20 bg-cardbg/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10">
              <Image
                src="/arcflare-logo.png.png"
                alt="ArcFlare Logo"
                width={40}
                height={40}
                className="object-contain"
              />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-wider text-copper">ARCFLARE</h1>
              <p className="text-xs text-gray-400">Stablecoin Payment Infrastructure</p>
            </div>
          </div>
          <nav className="flex gap-6">
            <Link href="/dashboard/jobs" className="hover:text-copper transition">Jobs</Link>
            <Link href="/dashboard/wallets" className="hover:text-copper transition">Wallets</Link>
          </nav>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
