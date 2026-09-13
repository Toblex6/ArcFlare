'use client';
import Link from 'next/link';

// Neutral FlareHQ error state — no merchant assumption. Theme tokens only.
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--background)', color: 'var(--text)', padding: 24, textAlign: 'center' }}>
      <p style={{ fontSize: 40, margin: '0 0 8px' }} aria-hidden>⚠️</p>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px' }}>Something went wrong</h2>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 24px', maxWidth: 480 }}>An unexpected error occurred. Try again, or head back to safety.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={() => reset()} style={{ background: 'var(--primary)', color: 'var(--background)', border: 'none', borderRadius: 10, padding: '10px 20px', fontWeight: 700, cursor: 'pointer' }}>Retry</button>
        <Link href="/" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Home</Link>
        <Link href="/consumer" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Individual app</Link>
        <Link href="/merchant/login" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Business login</Link>
      </div>
    </div>
  );
}
