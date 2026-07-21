const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  PageBreak,
  Header,
  Footer,
  PageNumber,
  VerticalAlign,
} = require('docx');
const fs = require('fs');
const pptxgen = require('pptxgenjs');

// Colors
const copper = 'C8975A';

// Helper functions
const h1 = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 120 },
    run: { color: copper, bold: true },
  });
const h2 = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 80 },
    run: { color: copper },
  });
const p = (text) =>
  new Paragraph({
    children: [new TextRun({ text, size: 22 })],
    spacing: { before: 80, after: 80 },
  });
const bullet = (text) =>
  new Paragraph({
    children: [new TextRun({ text, size: 22 })],
    bullet: { level: 0 },
    spacing: { before: 40, after: 40 },
  });

const apiTable = (rows) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (row, ri) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: cell,
                        size: 20,
                        bold: ri === 0,
                        color: ri === 0 ? 'FFFFFF' : '1A1A1A',
                      }),
                    ],
                  }),
                ],
                shading: ri === 0 ? { type: ShadingType.SOLID, fill: '2D2015' } : {},
              })
          ),
        })
    ),
  });

// Create DOCX
const doc = new Document({
  title: 'FlareHQ Technical Documentation',
  sections: [
    {
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children: [
        new Paragraph({
          children: [new TextRun({ text: 'FLAREHQ', size: 72, bold: true, color: copper })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 600, after: 120 },
        }),
        new Paragraph({
          children: [new TextRun({ text: 'Technical Documentation', size: 28, color: copper })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 240 },
        }),
        apiTable([
          ['Field', 'Value'],
          ['Founder', 'Oyalade Temitope'],
          ['Email', 'tobilade12@gmail.com'],
          ['Live URL', 'arcflare-gateway.onrender.com'],
          ['GitHub', 'github.com/Toblex6/FlareHQ'],
          ['Stack', 'Next.js / Prisma / PostgreSQL / Arc Testnet'],
          ['Status', 'Live on Arc Testnet'],
        ]),
        new Paragraph({ children: [new PageBreak()] }),

        h1('1. Project Overview'),
        p(
          'FlareHQ is a stablecoin payment infrastructure platform built on the Arc blockchain. It enables merchants, developers, and AI agents to send, receive, escrow, and settle USDC payments.'
        ),

        h1('2. API Reference'),
        p('Base URL: https://arcflare-gateway.onrender.com'),

        h2('POST /api/payments/initialize'),
        p('Creates a new payment record.'),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['amount', 'string', '✅', 'USDC amount'],
          ['currency', 'string', '✅', "Always 'USDC'"],
        ]),

        h2('GET /api/payments/verify/:reference'),
        p('Returns payment status.'),

        h2('POST /api/payments/settle'),
        p('Settles a pending payment.'),

        h1('3. Smart Contracts'),
        p('ArcFlareEscrow.sol: 0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F'),
        p('ArcFlareStream.sol: 0xc9BbeDFb142b6306c34838a39521c894F3dbc872'),

        h1('4. Vision'),
        p(
          'FlareHQ aims to become the financial infrastructure layer for programmable commerce on Arc.'
        ),
      ],
    },
  ],
});

// Create PPTX
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'Oyalade Temitope';
pres.title = 'FlareHQ — Investor Deck';

const C = { bg: '0E0B08', card: '1A1410', copper: 'C8975A', white: 'F0ECE6', muted: '6B5A45' };

// Slide 1 - Cover
let s = pres.addSlide();
s.background = { color: C.bg };
s.addText('FLAREHQ', {
  x: 0.5,
  y: 2,
  w: 9,
  h: 0.8,
  fontSize: 52,
  color: C.white,
  bold: true,
  align: 'center',
});
s.addText('Stablecoin Payment Infrastructure for Arc', {
  x: 1,
  y: 3,
  w: 8,
  h: 0.5,
  fontSize: 18,
  color: C.copper,
  align: 'center',
});
s.addText('Oyalade Temitope | tobilade12@gmail.com', {
  x: 0.5,
  y: 5,
  w: 9,
  h: 0.3,
  fontSize: 10,
  color: C.muted,
  align: 'center',
});

// Slide 2 - Problem
s = pres.addSlide();
s.background = { color: C.bg };
s.addText('THE PROBLEM', {
  x: 0.5,
  y: 0.3,
  w: 9,
  h: 0.4,
  fontSize: 11,
  color: C.copper,
  bold: true,
});
s.addText('The agentic economy has no payment layer', {
  x: 0.5,
  y: 0.75,
  w: 9,
  h: 0.55,
  fontSize: 28,
  color: C.white,
  bold: true,
});
s.addText(
  '• AI agents cannot own wallets or pay autonomously\n• No native USDC checkout on Arc\n• Manual cross-chain bridging required\n• Machine-to-machine commerce is blocked',
  { x: 0.5, y: 1.5, w: 9, h: 2, fontSize: 14, color: C.white }
);

// Slide 3 - Solution
s = pres.addSlide();
s.background = { color: C.bg };
s.addText('THE SOLUTION', {
  x: 0.5,
  y: 0.3,
  w: 9,
  h: 0.4,
  fontSize: 11,
  color: C.copper,
  bold: true,
});
s.addText('FlareHQ — Stripe for the agentic economy', {
  x: 0.5,
  y: 0.75,
  w: 9,
  h: 0.55,
  fontSize: 26,
  color: C.white,
  bold: true,
});
s.addText(
  '• Hosted Checkout - Shareable USDC payment links\n• M2M Auto-Settlement - Agents pay agents in 2 API calls\n• CCTP V2 Cross-Chain - Auto-route USDC to Arc\n• Trustless Escrow - Lock funds until conditions met\n• Streaming Payments - USDC drips per second\n• Nanopayments - Per-API-call billing',
  { x: 0.5, y: 1.5, w: 9, h: 2.5, fontSize: 13, color: C.white }
);

// Slide 4 - Live Product
s = pres.addSlide();
s.background = { color: C.bg };
s.addText('LIVE PRODUCT', {
  x: 0.5,
  y: 0.3,
  w: 9,
  h: 0.4,
  fontSize: 11,
  color: C.copper,
  bold: true,
});
s.addText('Running on Arc Testnet. Not a whitepaper.', {
  x: 0.5,
  y: 0.75,
  w: 9,
  h: 0.55,
  fontSize: 26,
  color: C.white,
  bold: true,
});
s.addText(
  '✅ 20+ API Routes Live\n✅ 2 Smart Contracts Deployed\n✅ 5 Payment Primitives\n✅ 5 Circle Products Integrated\n✅ CCTP V2 Attestation Working',
  { x: 0.5, y: 1.5, w: 9, h: 2, fontSize: 14, color: C.white }
);

// Slide 5 - The Ask
s = pres.addSlide();
s.background = { color: C.bg };
s.addText('THE ASK', { x: 0.5, y: 0.3, w: 9, h: 0.4, fontSize: 11, color: C.copper, bold: true });
s.addText('Seeking Circle 2026 Cohort 2 Grant', {
  x: 0.5,
  y: 0.75,
  w: 9,
  h: 0.55,
  fontSize: 26,
  color: C.white,
  bold: true,
});
s.addText(
  'Funding uses:\n• Smart contract audit\n• Mainnet deployment\n• Developer SDK & documentation\n• First 10 merchants',
  { x: 0.5, y: 1.5, w: 9, h: 2, fontSize: 14, color: C.white }
);

// Slide 6 - Closing
s = pres.addSlide();
s.background = { color: C.bg };
s.addText('FlareHQ is not a whitepaper.', {
  x: 0.5,
  y: 2,
  w: 9,
  h: 0.5,
  fontSize: 28,
  color: C.white,
  bold: true,
  align: 'center',
});
s.addText('It is running infrastructure.', {
  x: 0.5,
  y: 2.6,
  w: 9,
  h: 0.5,
  fontSize: 28,
  color: C.copper,
  bold: true,
  align: 'center',
});
s.addText('When Arc Mainnet launches, the payment layer is ready.', {
  x: 0.5,
  y: 3.5,
  w: 9,
  h: 0.4,
  fontSize: 14,
  color: C.muted,
  align: 'center',
});
s.addText('tobilade12@gmail.com | github.com/Toblex6/FlareHQ', {
  x: 0.5,
  y: 5,
  w: 9,
  h: 0.3,
  fontSize: 10,
  color: C.copper,
  align: 'center',
});

// Generate both files
Packer.toBuffer(doc)
  .then((buf) => {
    fs.writeFileSync('./FlareHQ-Documentation.docx', buf);
    console.log('✅ Doc written');
  })
  .catch((e) => {
    console.error('❌ Doc error:', e);
  });

pres
  .writeFile({ fileName: './FlareHQ-Investor-Deck.pptx' })
  .then(() => console.log('✅ Deck written'))
  .catch((e) => {
    console.error('❌ Deck error:', e);
  });
