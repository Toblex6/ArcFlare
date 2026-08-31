import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0e0b08', color: '#f0ece6', padding: 24, textAlign: 'center' }}>
      <h2 style={{ fontSize: 32, fontWeight: 800, margin: '0 0 8px' }}>404 — Not Found</h2>
      <p style={{ color: '#6b5a45', margin: '0 0 24px' }}>The page you’re looking for doesn’t exist.</p>
      <Link href="/merchant/dashboard" style={{ background: '#c8975a', color: '#0e0b08', borderRadius: 10, padding: '10px 20px', textDecoration: 'none', fontWeight: 700 }}>Back to Dashboard</Link>
    </div>
  );
}
