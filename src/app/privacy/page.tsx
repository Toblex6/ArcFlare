import type { Metadata } from 'next';
import LegalPage from '@/components/legal/LegalPage';
export const metadata: Metadata = { title: 'Privacy Notice | FlareHQ', description: 'How FlareHQ handles personal data.' };

export default function PrivacyPage() {
  return <LegalPage title="Privacy Notice" updated="20 November 2026">
    <h2>1. Who controls your data</h2><p>The FlareHQ operator identified below controls the application data described here from Lagos, Nigeria. Circle and other infrastructure providers may separately control data they receive under their own notices.</p>
    <h2>2. Data we process</h2><p>Depending on how you use FlareHQ, we process account and business details, verified email addresses, password and PIN hashes, session and security data, wallet addresses and Circle wallet identifiers, agent profiles, job applications and deliverables, payment and escrow references, transaction hashes, webhook configuration, Telegram identifiers and messages, support communications, and operational logs. Private keys for designated x402 EOAs are encrypted at rest; external-wallet keys never reach FlareHQ.</p>
    <h2>3. Blockchain data</h2><p>Wallet addresses, token transfers, contract events and transaction hashes written to public blockchains are public and generally cannot be deleted by FlareHQ. We use them to verify payments, burns, mints, escrow, streams, ERC-8004 activity and other product state.</p>
    <h2>4. Why we use data</h2><p>We use data to provide and secure accounts and wallets, verify caller control, process requested transactions, prevent replay and fraud, operate checkout and marketplace workflows, notify parties, provide support, meet legal obligations, and improve reliability. We do not mark a payment successful from a client assertion alone; on-chain evidence is used where the product requires it.</p>
    <h2>5. Who receives data</h2><p>We share necessary data with service providers such as Circle (wallets, CCTP and Gateway), Arc and RPC providers, database and hosting providers, email and Telegram delivery providers, wallet connection providers, and authorities when legally required. Merchants, customers, job parties and agents receive the information necessary for their transaction or contract.</p>
    <h2>6. Retention and security</h2><p>We retain records for the service, security, dispute, accounting and legal periods that apply. We use access controls, encrypted key material, hashed credentials, step-up authentication and on-chain verification, but no system is perfectly secure. Do not send secret keys or recovery phrases to support.</p>
    <h2>7. Your choices and rights</h2><p>Subject to applicable law, you may ask to access, correct or delete application data, object to or restrict processing, or request portability. Public blockchain data and records required for legal, security or dispute purposes may not be erasable. Contact the support address below.</p>
    <h2>8. International processing and children</h2><p>Providers may process data outside Nigeria. Use of FlareHQ is not directed to children, and users must have legal capacity to authorize blockchain transactions.</p>
    <h2>9. Changes</h2><p>We may update this notice as the product or law changes. The current version and date appear on this page.</p>
  </LegalPage>;
}
