import type { Metadata } from 'next';
import LegalPage from '@/components/legal/LegalPage';
export const metadata: Metadata = { title: 'Terms of Service | FlareHQ', description: 'Terms for using FlareHQ.' };

export default function TermsPage() {
  return <LegalPage title="Terms of Service" updated="November 2026">
    <h2>1. Acceptance.</h2><p>By using FlareHQ ("the Service") you agree to these Terms. If you do not agree, do not use the Service.</p>
    <h2>2. Service.</h2><p>FlareHQ is a non-custodial stablecoin payment service built on Arc. It lets merchants create checkout links and invoices, accept USDC payments (including cross-chain payments via Circle's CCTP), and use escrow, jobs, streams and related tools.</p>
    <h2>3. Operator.</h2><p>FlareHQ is operated by Temitope Oyalade, trading as FlareHQ, Nigeria.</p>
    <h2>4. Eligibility.</h2><p>You must be at least 18 and legally allowed to use digital asset services where you live. You are responsible for following the laws that apply to you.</p>
    <h2>5. Self-custody.</h2><p>FlareHQ does not hold your funds. You are responsible for your wallet, your credentials, and every transaction you approve, including sending to a wrong address.</p>
    <h2>6. Fees.</h2><p>FlareHQ charges a 0.25% platform fee on checkout payments and escrow releases. Network and bridge fees are separate and are shown before you confirm. Fee rates may change with 30 days' notice.</p>
    <h2>7. Escrow and jobs.</h2><p>Escrow funds are held by a smart contract, not by FlareHQ. Releases and refunds follow the rules of the contract and the decisions of the buyer, seller and arbiter.</p>
    <h2>8. Prohibited use.</h2><p>No money laundering, terrorist financing, sanctions evasion, fraud, or anything illegal.</p>
    <h2>9. No advice.</h2><p>Nothing here is financial, legal or tax advice. Digital assets are risky and can lose value.</p>
    <h2>10. Liability.</h2><p>To the extent allowed by law, FlareHQ is not liable for indirect or consequential losses, or for losses from user error, network failures, smart contract bugs, or third-party outages.</p>
    <h2>11. Changes.</h2><p>We may update these Terms. Continued use means you accept the changes.</p>
    <h2>12. Contact.</h2><p>support@flarehq.xyz</p>
  </LegalPage>;
}
