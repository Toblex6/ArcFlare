// Pure rendering/static checks. No database, signing, or network requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TermsPage from '../src/app/terms/page';
import PrivacyPage from '../src/app/privacy/page';
import { LEGAL_OPERATOR, LEGAL_DETAILS_REQUIRED } from '../src/lib/legal/operator';

const read = (path: string) => readFileSync(path, 'utf8');
const operatorName = 'Temitope Oyalade, trading as FlareHQ';
const supportEmail = 'support@flarehq.xyz';
const plainText = (html: string) => html.replace(/<[^>]*>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const termsSections = [
  ['1. Acceptance.', 'By using FlareHQ ("the Service") you agree to these Terms. If you do not agree, do not use the Service.'],
  ['2. Service.', "FlareHQ is a non-custodial stablecoin payment service built on Arc. It lets merchants create checkout links and invoices, accept USDC payments (including cross-chain payments via Circle's CCTP), and use escrow, jobs, streams and related tools."],
  ['3. Operator.', 'FlareHQ is operated by Temitope Oyalade, trading as FlareHQ, Nigeria.'],
  ['4. Eligibility.', 'You must be at least 18 and legally allowed to use digital asset services where you live. You are responsible for following the laws that apply to you.'],
  ['5. Self-custody.', 'FlareHQ does not hold your funds. You are responsible for your wallet, your credentials, and every transaction you approve, including sending to a wrong address.'],
  ['6. Fees.', "FlareHQ charges a 0.25% platform fee on checkout payments and escrow releases. Network and bridge fees are separate and are shown before you confirm. Fee rates may change with 30 days' notice."],
  ['7. Escrow and jobs.', 'Escrow funds are held by a smart contract, not by FlareHQ. Releases and refunds follow the rules of the contract and the decisions of the buyer, seller and arbiter.'],
  ['8. Prohibited use.', 'No money laundering, terrorist financing, sanctions evasion, fraud, or anything illegal.'],
  ['9. No advice.', 'Nothing here is financial, legal or tax advice. Digital assets are risky and can lose value.'],
  ['10. Liability.', 'To the extent allowed by law, FlareHQ is not liable for indirect or consequential losses, or for losses from user error, network failures, smart contract bugs, or third-party outages.'],
  ['11. Changes.', 'We may update these Terms. Continued use means you accept the changes.'],
  ['12. Contact.', supportEmail],
];

const privacySections = [
  ['1. What we collect.', 'Account details you give us (such as email and business name), public wallet addresses and on-chain transactions, invoice and payment records, and basic device and usage data.'],
  ['2. What we do not collect.', 'Private keys, seed phrases, passwords in plain text, or card details.'],
  ['3. How we use it.', 'To run and improve the Service, show your payments and invoices, send notifications, prevent fraud, and meet legal duties.'],
  ['4. Services we use.', 'Circle (wallets and payments), Render (hosting), Neon (database), and Resend (email). Each has its own privacy policy.'],
  ['5. Sharing.', 'We do not sell your data. We share it only with these providers or when the law requires it.'],
  ['6. Retention and deletion.', 'We keep your data while your account is active. You can ask us to delete it by emailing support@flarehq.xyz. Blockchain transactions are public and cannot be deleted.'],
  ['7. Your rights.', 'You can ask to see, correct or delete your data.'],
  ['8. Security.', 'We use reasonable security measures, but no system is completely secure.'],
  ['9. Children.', 'FlareHQ is not for people under 18.'],
  ['10. Changes.', 'We may update this policy. Continued use means you accept the changes.'],
  ['11. Contact.', supportEmail],
];

test('operator configuration contains the supplied identity, country and support email', () => {
  assert.deepEqual(LEGAL_OPERATOR, {
    legalName: operatorName,
    supportContact: supportEmail,
    location: 'Nigeria',
  });
  assert.equal(LEGAL_DETAILS_REQUIRED, false);
});

for (const { title, component, sections } of [
  { title: 'Terms of Service', component: TermsPage, sections: termsSections },
  { title: 'Privacy Policy', component: PrivacyPage, sections: privacySections },
]) {
  const html = renderToStaticMarkup(createElement(component));
  const text = plainText(html);

  test(`${title} actually renders the title, November 2026, operator and contact`, () => {
    assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`));
    assert.ok(text.includes('Last updated: November 2026'));
    assert.ok(text.includes(`Operator: ${operatorName}`));
    assert.ok(text.includes('Location: Nigeria'));
    assert.ok(text.includes(`Support: ${supportEmail}`));
    assert.doesNotMatch(text, /\bTODO\b|\bTBD\b|to be provided|REQUIRED|placeholder|Lagos/i);
    assert.doesNotMatch(text, /registration number|registered address|legal@flarehq\.xyz/i);
    assert.ok(html.includes('href="/terms"'));
    assert.ok(html.includes('href="/privacy"'));
  });

  test(`${title} renders exactly the requested sections, in order, without extras`, () => {
    const section = html.match(/<section\b[^>]*>([\s\S]*?)<\/section>/);
    assert.ok(section, 'Legal content section must render');
    const headings = Array.from(html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g), match => plainText(match[1]));
    assert.deepEqual(headings, sections.map(([heading]) => heading));
    assert.equal(plainText(section[1]), sections.map(([heading, body]) => `${heading} ${body}`).join(' '));
  });
}

test('home footer and sitemap retain links to both legal pages', () => {
  const footer = read('src/components/home/ClosingCTA.tsx');
  const sitemap = read('src/app/sitemap.ts');
  assert.ok(footer.includes('href="/terms"'));
  assert.ok(footer.includes('href="/privacy"'));
  assert.ok(sitemap.includes("'/terms'"));
  assert.ok(sitemap.includes("'/privacy'"));
});
