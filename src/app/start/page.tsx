'use client';

import Link from 'next/link';
import Image from 'next/image';

export default function StartPage() {
    return (
        <main className="min-h-screen bg-[#120b08] text-white flex flex-col items-center justify-center px-6">
            <div className="flex items-center gap-3 mb-12">
                <Image src="/arcflare-logo.png" alt="FlareHQ" width={44} height={44} />
                <h1 className="text-2xl font-bold">FlareHQ</h1>
            </div>

            <h2 className="text-3xl md:text-4xl font-bold text-center mb-3">What brings you here?</h2>
            <p className="text-gray-400 text-center mb-14 max-w-md">
                Pick the one that fits — you can always do the other later.
            </p>

            <div className="grid md:grid-cols-2 gap-6 w-full max-w-3xl">
                <Link
                    href="/merchant/signup"
                    className="group bg-[#1a120d] border border-[#2d2019] rounded-3xl p-8 flex flex-col hover:border-cyan-500/60 transition duration-200"
                >
                    <div className="text-4xl mb-4">🏪</div>
                    <h3 className="text-xl font-bold mb-2">I run a business</h3>
                    <p className="text-gray-400 text-sm leading-relaxed flex-1">
                        Accept USDC payments, generate checkout links, deploy agents, and use escrow and job
                        tools. Requires an account with an API key.
                    </p>
                    <span className="mt-6 text-cyan-400 text-sm font-semibold group-hover:text-cyan-300 transition">
                        Create a business account →
                    </span>
                </Link>

                <Link
                    href="/consumer"
                    className="group bg-[#1a120d] border border-[#2d2019] rounded-3xl p-8 flex flex-col hover:border-cyan-500/60 transition duration-200"
                >
                    <div className="text-4xl mb-4">👤</div>
                    <h3 className="text-xl font-bold mb-2">I'm here for myself</h3>
                    <p className="text-gray-400 text-sm leading-relaxed flex-1">
                        Send money, request payments, save automatically, and chat with an agent. Just connect
                        or create a wallet — no signup form.
                    </p>
                    <span className="mt-6 text-cyan-400 text-sm font-semibold group-hover:text-cyan-300 transition">
                        Continue as an individual →
                    </span>
                </Link>
            </div>

            <div className="mt-14 text-sm text-gray-500">
                Already have a business account?{' '}
                <Link href="/merchant/login" className="text-cyan-400 hover:text-cyan-300 transition">
                    Log in
                </Link>
            </div>
        </main>
    );
}
