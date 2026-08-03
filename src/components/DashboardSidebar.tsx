// src/components/DashboardSidebar.tsx
// One sidebar, used everywhere. Fully self-contained: fetches its own
// merchant info, manages its own mobile open/close state, and renders its
// own hamburger toggle on small screens. Every dashboard-adjacent page
// should render <DashboardSidebar active="X" /> and nothing else for its
// nav — no per-page copies, no drift.
'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface NavItem {
    label: string;
    href: string;
    disabled?: boolean;
}

interface NavSection {
    group: string;
    items: NavItem[];
}

const SECTIONS: NavSection[] = [
    {
        group: 'OVERVIEW',
        items: [
            { label: 'Dashboard', href: '/merchant/dashboard' },
            { label: 'Analytics', href: '/analytics' },
            { label: 'Homepage', href: '/' },
        ],
    },
    {
        group: 'PAYMENTS',
        items: [
            { label: 'Transactions', href: '/transactions' },
            { label: 'Escrow', href: '/escrow' },
            { label: 'Nanopayments', href: '/nano' },
        ],
    },
    {
        group: 'AI & AGENTS',
        items: [
            { label: 'Agent Brain', href: '/agent-brain' },
            { label: 'Agents', href: '/agents' },
            { label: 'Jobs', href: '/jobs' },
            { label: 'AI Assistant', href: '/merchant/assistant' },
        ],
    },
    {
        group: 'COMING SOON',
        items: [
            { label: 'Marketplace', href: '/marketplace', disabled: true },
            { label: 'Agent Wallets', href: '/agent-wallets', disabled: true },
        ],
    },
];

const ICONS: Record<string, JSX.Element> = {
    Dashboard: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
    Analytics: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 3v18h18" /><path d="M7 16l4-6 4 3 5-8" /></svg>,
    Homepage: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>,
    Transactions: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>,
    Escrow: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>,
    Nanopayments: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" /></svg>,
    Marketplace: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 9l1.5-5h15L21 9" /><path d="M3 9h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z" /><path d="M9 13a3 3 0 0 0 6 0" /></svg>,
    'Agent Brain': <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" /></svg>,
    Agents: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /><line x1="12" y1="11" x2="12" y2="15" /></svg>,
    Jobs: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg>,
    'AI Assistant': <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
    'Agent Wallets': <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><circle cx="7" cy="15" r="1.5" /></svg>,
};

export default function DashboardSidebar({ active }: { active: string }) {
    const router = useRouter();
    const [isMobile, setIsMobile] = useState(false);
    const [open, setOpen] = useState(false);
    const [merchant, setMerchant] = useState<{ businessName: string; email: string } | null>(null);

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth < 768);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, []);

    useEffect(() => {
        fetch('/api/merchant/me')
            .then((r) => r.json())
            .then((data) => {
                if (data.success) setMerchant({ businessName: data.merchant.businessName, email: data.merchant.email });
            })
            .catch(() => { });
    }, []);

    const signOut = async () => {
        await fetch('/api/merchant/me', { method: 'DELETE' });
        router.replace('/merchant/login');
    };

    return (
        <>
            {isMobile && (
                <button
                    onClick={() => setOpen(true)}
                    style={{
                        position: 'fixed', top: 16, left: 16, zIndex: 1001,
                        background: '#1f140f', border: '1px solid #2d2015', borderRadius: 8,
                        width: 40, height: 40, color: '#fff', fontSize: 20, cursor: 'pointer',
                        display: open ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    ☰
                </button>
            )}

            {isMobile && open && (
                <div
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999 }}
                    onClick={() => setOpen(false)}
                />
            )}

            <aside
                style={{
                    width: 220,
                    minHeight: '100vh',
                    background: '#1f140f',
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '24px 14px',
                    flexShrink: 0,
                    position: isMobile ? 'fixed' : 'sticky',
                    top: 0,
                    left: isMobile ? (open ? 0 : '-280px') : 0,
                    height: '100vh',
                    overflowY: 'auto',
                    zIndex: 1000,
                    transition: 'left 0.3s ease',
                    borderRight: '1px solid #2d2015',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 36, paddingLeft: 6 }}>
                    <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={36} height={36} style={{ borderRadius: 8, objectFit: 'contain' }} />
                    <div>
                        <p style={{ color: '#fff', fontSize: 14, fontWeight: 700, lineHeight: 1, margin: 0 }}>FlareHQ</p>
                        <p style={{ color: '#4b5563', fontSize: 10, margin: '3px 0 0 0' }}>Stablecoin Payment Infrastructure</p>
                    </div>
                </div>

                <nav style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                    {SECTIONS.map((section) => (
                        <div key={section.group} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <p style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1, padding: '6px 12px 2px', margin: 0 }}>
                                {section.group}
                            </p>
                            {section.items.map((item) => {
                                const isActive = item.label === active;
                                if (item.disabled) {
                                    return (
                                        <span
                                            key={item.label}
                                            title="Coming soon"
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 10,
                                                padding: '9px 12px', borderRadius: 9,
                                                fontSize: 13, fontWeight: 500,
                                                color: '#3f3a35', cursor: 'not-allowed',
                                                border: '1px solid transparent',
                                            }}
                                        >
                                            {ICONS[item.label]}
                                            <span>{item.label}</span>
                                        </span>
                                    );
                                }
                                return (
                                    <a
                                        key={item.label}
                                        href={item.href}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 10,
                                            padding: '9px 12px', borderRadius: 9,
                                            textDecoration: 'none', fontSize: 13, fontWeight: 500,
                                            transition: 'all 0.15s',
                                            background: isActive ? 'rgba(34,211,238,0.18)' : 'transparent',
                                            color: isActive ? '#22d3ee' : '#6b7280',
                                            border: isActive ? '1px solid rgba(34,211,238,0.25)' : '1px solid transparent',
                                        }}
                                    >
                                        {ICONS[item.label]}
                                        <span>{item.label}</span>
                                    </a>
                                );
                            })}
                        </div>
                    ))}
                </nav>

                <div style={{ background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.2)', borderRadius: 12, padding: '14px 14px', marginTop: 16 }}>
                    <p style={{ color: '#4b5563', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 6px 0' }}>Signed in as</p>
                    <p style={{ color: '#fff', fontSize: 13, fontWeight: 700, margin: '0 0 2px 0' }}>{merchant?.businessName || '...'}</p>
                    <p style={{ color: '#4b5563', fontSize: 10, margin: '0 0 10px 0' }}>{merchant?.email || ''}</p>
                    <button
                        onClick={() => router.push('/merchant/settings')}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '7px 0', fontSize: 11, color: '#9ca3af', cursor: 'pointer', marginBottom: 6 }}
                    >
                        ⚙ Payout Settings
                    </button>
                    <button
                        onClick={signOut}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '7px 0', fontSize: 11, color: '#9ca3af', cursor: 'pointer' }}
                    >
                        Sign out
                    </button>
                </div>

                <div style={{ marginTop: 12, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 10, padding: '8px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                        <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>Arc Testnet Mode</span>
                    </div>
                </div>
            </aside>
        </>
    );
}