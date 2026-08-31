'use client';
import Link from 'next/link';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0e0b08', color: '#f0ece6', padding: 24, textAlign: 'center' }}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px' }}>Something went wrong</h2>
      <p style={{ color: '#6b5a45', margin: '0 0 24px', maxWidth: 480 }}>An unexpected error occurred. Please try again or return to the dashboard.</p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button onClick={() => reset()} style={{ background: '#c8975a', color: '#0e0b08', border: 'none', borderRadius: 10, padding: '10px 20px', fontWeight: 700, cursor: 'pointer' }}>Retry</button>
        <Link href="/merchant/dashboard" style={{ background: 'transparent', border: '1px solid #2d2015', color: '#c8975a', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Dashboard</Link>
      </div>
    </div>
  );
}
