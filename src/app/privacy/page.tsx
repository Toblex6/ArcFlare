import type { Metadata } from 'next';
import LegalPage from '@/components/legal/LegalPage';
export const metadata: Metadata = { title: 'Privacy Policy | FlareHQ', description: 'How FlareHQ handles personal data.' };

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" updated="November 2026">
    <h2>1. What we collect.</h2><p>Account details you give us (such as email and business name), public wallet addresses and on-chain transactions, invoice and payment records, and basic device and usage data.</p>
    <h2>2. What we do not collect.</h2><p>Private keys, seed phrases, passwords in plain text, or card details.</p>
    <h2>3. How we use it.</h2><p>To run and improve the Service, show your payments and invoices, send notifications, prevent fraud, and meet legal duties.</p>
    <h2>4. Services we use.</h2><p>Circle (wallets and payments), Render (hosting), Neon (database), and Resend (email). Each has its own privacy policy.</p>
    <h2>5. Sharing.</h2><p>We do not sell your data. We share it only with these providers or when the law requires it.</p>
    <h2>6. Retention and deletion.</h2><p>We keep your data while your account is active. You can ask us to delete it by emailing support@flarehq.xyz. Blockchain transactions are public and cannot be deleted.</p>
    <h2>7. Your rights.</h2><p>You can ask to see, correct or delete your data.</p>
    <h2>8. Security.</h2><p>We use reasonable security measures, but no system is completely secure.</p>
    <h2>9. Children.</h2><p>FlareHQ is not for people under 18.</p>
    <h2>10. Changes.</h2><p>We may update this policy. Continued use means you accept the changes.</p>
    <h2>11. Contact.</h2><p>support@flarehq.xyz</p>
  </LegalPage>;
}
