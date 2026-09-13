import Link from 'next/link';

// Neutral FlareHQ 404 — no merchant assumption. Theme tokens only.
export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--background)', color: 'var(--text)', padding: 24, textAlign: 'center' }}>
      <p style={{ fontSize: 40, margin: '0 0 8px' }} aria-hidden>🧭</p>
      <h2 style={{ fontSize: 32, fontWeight: 800, margin: '0 0 8px' }}>Page not found</h2>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 24px', maxWidth: 440 }}>The page you’re looking for doesn’t exist or was moved.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link href="/" style={{ background: 'var(--primary)', color: 'var(--background)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 700 }}>Home</Link>
        <Link href="/start" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Get started</Link>
        <Link href="/consumer" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Individual app</Link>
        <Link href="/merchant/login" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 600 }}>Business login</Link>
      </div>
    </div>
  );
}
