'use client';

import Link from 'next/link';
import Image from 'next/image';

// /start keeps its persona-choice concept, styled in the shared FlareHQ
// theme (var() tokens — no third visual language) so it reads as part of
// the same product as the homepage. Choosing the individual path leads into
// wallet/account onboarding in /consumer (create a FlareHQ-managed wallet
// or connect one you control).
//
// Wallet-creation reality (no Google auth exists in this repo): consumer
// onboarding offers exactly two paths — "Connect a wallet" (EIP-6963 /
// WalletConnect via wagmi + nonce/signature challenge) or "Create a
// FlareHQ wallet" (Circle-managed, POST /api/consumer/session). Email is
// recovery/verification only (OTP via /api/consumer/email + /recover), not
// a wallet-creation method. Nothing here invents another provider.
export default function StartPage() {
    return (
        <main className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col items-center px-6">
            <header className="w-full max-w-5xl flex items-center justify-between py-5">
                <Link href="/" className="flex items-center gap-2.5">
                    <Image src="/arcflare-logo.png" alt="FlareHQ" width={32} height={32} className="rounded-lg" />
                    <span className="text-lg font-extrabold tracking-tight">FlareHQ</span>
                </Link>
                <Link
                    href="/"
                    className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text)] transition"
                >
                    ← Back to home
                </Link>
            </header>

            <div className="flex items-center gap-3 mt-8 mb-6">
                <Image src="/arcflare-logo.png" alt="FlareHQ" width={44} height={44} className="rounded-xl" />
                <h1 className="text-2xl font-bold">FlareHQ</h1>
            </div>

            <h2 className="text-3xl md:text-4xl font-bold text-center mb-3">What brings you here?</h2>
            <p className="text-[var(--text-secondary)] text-center mb-10 max-w-md">
                Pick the one that fits — you can always do the other later.
            </p>

            <div className="grid md:grid-cols-2 gap-4 md:gap-6 w-full max-w-3xl">
                <Link
                    href="/merchant/signup"
                    className="group bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-8 flex flex-col hover:border-cyan-500/60 hover:shadow-lg hover:-translate-y-1 transition duration-200"
                >
                    <div className="text-4xl mb-4">🏪</div>
                    <h3 className="text-xl font-bold mb-2">I run a business</h3>
                    <p className="text-[var(--text-secondary)] text-sm leading-relaxed flex-1">
                        Accept USDC payments, generate checkout links, deploy agents, and use escrow and job
                        tools. Requires an account with an API key.
                    </p>
                    <span className="mt-6 text-cyan-600 dark:text-cyan-300 text-sm font-semibold group-hover:text-cyan-500 transition">
                        Create a business account →
                    </span>
                </Link>

                <Link
                    href="/consumer"
                    className="group bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-8 flex flex-col hover:border-cyan-500/60 hover:shadow-lg hover:-translate-y-1 transition duration-200"
                >
                    <div className="text-4xl mb-4">👤</div>
                    <h3 className="text-xl font-bold mb-2">I&apos;m here for myself</h3>
                    <p className="text-[var(--text-secondary)] text-sm leading-relaxed flex-1">
                        Next you&apos;ll create a FlareHQ-managed wallet or connect one you control —
                        then send, request, save, and chat with an agent. No signup form.
                    </p>
                    <span className="mt-6 text-cyan-600 dark:text-cyan-300 text-sm font-semibold group-hover:text-cyan-500 transition">
                        Continue to wallet setup →
                    </span>
                </Link>
            </div>

            <div className="mt-12 mb-10 text-sm text-[var(--text-secondary)]">
                Already have a business account?{' '}
                <Link href="/merchant/login" className="text-cyan-600 dark:text-cyan-300 hover:text-cyan-500 transition font-semibold">
                    Log in
                </Link>
            </div>
        </main>
    );
}
