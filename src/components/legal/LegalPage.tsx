import Link from 'next/link';
import { LEGAL_OPERATOR, LEGAL_DETAILS_REQUIRED } from '@/lib/legal/operator';

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', padding: '48px 20px' }}>
    <article style={{ maxWidth: 820, margin: '0 auto', lineHeight: 1.7 }}>
      <Link href="/" style={{ color: '#c8975a', textDecoration: 'none' }}>← FlareHQ</Link>
      <h1 style={{ fontSize: 40, marginBottom: 4 }}>{title}</h1><p style={{ color: '#8f8171' }}>Last updated: {updated}</p>
      {LEGAL_DETAILS_REQUIRED && <div role="alert" style={{ border: '1px solid #d97706', background: '#2a1c09', padding: 14, borderRadius: 10, margin: '20px 0' }}><strong>Operator details required before launch.</strong><br/>The owner must replace the REQUIRED values in <code>src/lib/legal/operator.ts</code>. No legal entity name has been invented.</div>}
      <section style={{ color: '#d8cfc4' }}>{children}</section>
      <hr style={{ borderColor: '#3d2e1a', margin: '32px 0' }}/>
      <p><strong>Operator:</strong> {LEGAL_OPERATOR.legalName}<br/><strong>Location:</strong> {LEGAL_OPERATOR.location}<br/><strong>Support:</strong> {LEGAL_OPERATOR.supportContact}</p>
      <p><Link href="/terms" style={{ color: '#c8975a' }}>Terms</Link> · <Link href="/privacy" style={{ color: '#c8975a' }}>Privacy</Link></p>
    </article>
  </main>;
}
