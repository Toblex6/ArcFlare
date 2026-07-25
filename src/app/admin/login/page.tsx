'use client';

// src/app/admin/login/page.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Login failed.');
            router.replace('/admin');
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
            <div style={{ width: '100%', maxWidth: 360 }}>
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Admin</h1>
                <p style={{ color: '#6b5a45', fontSize: 13, margin: '0 0 28px' }}>Platform-wide analytics — restricted access.</p>

                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <input
                        type="email"
                        placeholder="Admin email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #2d2015', background: '#1a1410', color: '#f0ece6', fontSize: 14, outline: 'none' }}
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #2d2015', background: '#1a1410', color: '#f0ece6', fontSize: 14, outline: 'none' }}
                    />
                    {error && <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {error}</p>}
                    <button
                        type="submit"
                        disabled={loading}
                        style={{ padding: '12px 0', borderRadius: 10, border: 'none', background: '#c8975a', color: '#0e0b08', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer' }}
                    >
                        {loading ? 'Signing in...' : 'Sign in'}
                    </button>
                </form>
            </div>
        </main>
    );
}
