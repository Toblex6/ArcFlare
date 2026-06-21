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

// ── Helpers ──────────────────────────────────────────────────────────────────
const copper = 'C8975A';
const dark = '1A1410';
const white = 'F0ECE6';

const h1 = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 120 },
    run: { color: copper, bold: true },
    shading: { type: ShadingType.SOLID, color: '1A1410', fill: '1A1410' },
  });

const h2 = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 80 },
    run: { color: copper },
  });

const h3 = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 180, after: 60 },
    run: { color: '8A7560' },
  });

const p = (text, opts = {}) =>
  new Paragraph({
    children: [new TextRun({ text, size: 22, color: opts.color || '1A1A1A', ...opts })],
    spacing: { before: 80, after: 80 },
  });

const code = (text) =>
  new Paragraph({
    children: [
      new TextRun({
        text,
        font: 'Courier New',
        size: 18,
        color: 'B45309',
      }),
    ],
    shading: { type: ShadingType.SOLID, fill: 'F5F0E8' },
    spacing: { before: 40, after: 40 },
    indent: { left: 360 },
  });

const bullet = (text, level = 0) =>
  new Paragraph({
    children: [new TextRun({ text, size: 22, color: '1A1A1A' })],
    bullet: { level },
    spacing: { before: 40, after: 40 },
  });

const divider = () =>
  new Paragraph({
    border: { bottom: { color: 'C8975A', size: 6, style: BorderStyle.SINGLE } },
    spacing: { before: 200, after: 200 },
  });

const kv = (key, value) =>
  new Paragraph({
    children: [
      new TextRun({ text: `${key}: `, bold: true, size: 22, color: '1A1A1A' }),
      new TextRun({ text: value, size: 22, color: '1A1A1A', font: 'Courier New' }),
    ],
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
                        size: ri === 0 ? 20 : 20,
                        bold: ri === 0,
                        color: ri === 0 ? 'FFFFFF' : '1A1A1A',
                        font: 'Calibri',
                      }),
                    ],
                    spacing: { before: 40, after: 40 },
                  }),
                ],
                shading: ri === 0 ? { type: ShadingType.SOLID, fill: '2D2015' } : {},
                margins: { top: 60, bottom: 60, left: 120, right: 120 },
                verticalAlign: VerticalAlign.CENTER,
              })
          ),
        })
    ),
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'C8975A' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C8975A' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'C8975A' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'C8975A' },
      insideH: { style: BorderStyle.SINGLE, size: 2, color: 'E2D5C0' },
      insideV: { style: BorderStyle.SINGLE, size: 2, color: 'E2D5C0' },
    },
  });

// ════════════════════════════════════════════════════════════════════
// DOCUMENT
// ════════════════════════════════════════════════════════════════════
const doc = new Document({
  title: 'ArcFlare Technical Documentation',
  creator: 'Oyalade Temitope',
  description: 'ArcFlare stablecoin payment infrastructure — full technical reference',
  styles: {
    paragraphStyles: [
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        run: { size: 36, bold: true, color: copper, font: 'Cambria' },
        paragraph: { spacing: { before: 400, after: 120 } },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        run: { size: 28, bold: true, color: copper, font: 'Cambria' },
        paragraph: { spacing: { before: 280, after: 80 } },
      },
      {
        id: 'Heading3',
        name: 'Heading 3',
        basedOn: 'Normal',
        run: { size: 24, bold: true, color: '8A7560', font: 'Calibri' },
        paragraph: { spacing: { before: 180, after: 60 } },
      },
    ],
  },
  sections: [
    {
      properties: {
        page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: 'ArcFlare — Technical Documentation  |  ',
                  size: 18,
                  color: '8A7560',
                  font: 'Calibri',
                }),
                new TextRun({
                  text: 'arcflare-gateway.onrender.com',
                  size: 18,
                  color: copper,
                  font: 'Calibri',
                }),
              ],
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C8975A' } },
              spacing: { after: 120 },
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: 'Confidential  |  Oyalade Temitope  |  tobilade12@gmail.com  |  Page ',
                  size: 16,
                  color: '8A7560',
                  font: 'Calibri',
                }),
                new PageNumber(),
              ],
              alignment: AlignmentType.CENTER,
              border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'C8975A' } },
              spacing: { before: 120 },
            }),
          ],
        }),
      },
      children: [
        // ── COVER ────────────────────────────────────────────────────────────
        new Paragraph({
          children: [
            new TextRun({
              text: 'ARCFLARE',
              size: 72,
              bold: true,
              color: copper,
              font: 'Cambria',
              charSpacing: 200,
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 600, after: 120 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: 'Stablecoin Payment Infrastructure and Agentic Finance Layer on Arc',
              size: 28,
              color: '8A7560',
              font: 'Calibri',
              italics: true,
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 240 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: 'Technical Documentation & Developer Reference',
              size: 22,
              color: '8A7560',
              font: 'Calibri',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 480 },
        }),
        apiTable([
          ['Field', 'Value'],
          ['Founder', 'Oyalade Temitope'],
          ['Email', 'tobilade12@gmail.com'],
          ['Location', 'Lagos, Nigeria'],
          ['Live URL', 'arcflare-gateway.onrender.com'],
          ['GitHub', 'github.com/Toblex6/ArcFlare'],
          ['Stack', 'Next.js 16 / Prisma / PostgreSQL / Arc Testnet'],
          ['Circle Products', 'CCTP V2, Programmable Wallets, SCA, Iris API, Webhooks'],
          ['Status', 'Live on Arc Testnet — Circle 2026 Cohort 2 Grant Applicant'],
        ]),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 1. OVERVIEW ──────────────────────────────────────────────────────
        h1('1. Project Overview'),
        p(
          "ArcFlare is a full-stack stablecoin payment infrastructure platform built on the Arc blockchain. It enables merchants, developers, and autonomous AI agents to send, receive, escrow, settle, and automate USDC payments through a unified API layer — powered by Circle's infrastructure and Arc's sub-second deterministic finality."
        ),
        p(
          'Think of it as Stripe for programmable commerce and AI agents. One API call initializes a payment. Two API calls complete an agent-to-agent settlement with zero human involvement.'
        ),

        h2('1.1 Core Value Proposition'),
        bullet('Merchants generate shareable USDC checkout links via one API call'),
        bullet('AI agents get onchain identities (ERC-8004) and real Circle SCA wallets'),
        bullet(
          'Cross-chain USDC routes automatically from Arbitrum, Base, Ethereum → Arc via CCTP V2'
        ),
        bullet('Trustless escrow, streaming payments, and nanopayments built in as primitives'),
        bullet('All infrastructure is live on Arc Testnet today'),

        h2('1.2 Why Arc'),
        p(
          "Arc's sub-second deterministic finality makes ArcFlare's payment primitives viable at scale:"
        ),
        bullet('Streaming payments drip USDC per second with real-time accuracy'),
        bullet('Nanopayments settle efficiently without long block wait times'),
        bullet('Cross-chain USDC arrives on Arc in seconds via CCTP V2, not minutes'),
        bullet('Agent-to-agent payments confirm near-instantly'),
        bullet('Arc Testnet Chain ID: 5042002 | CCTP V2 Domain: 26'),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 2. ARCHITECTURE ──────────────────────────────────────────────────
        h1('2. Technical Architecture'),

        h2('2.1 Stack'),
        apiTable([
          ['Layer', 'Technology', 'Purpose'],
          ['Frontend', 'Next.js 16 (App Router)', 'Merchant dashboard, hosted checkout, escrow UI'],
          ['Backend', 'Next.js API Routes', 'All payment, agent, escrow, stream, nano endpoints'],
          ['Database', 'PostgreSQL + Prisma', 'Payment logs, agent registry, escrow, streams'],
          [
            'Blockchain',
            'Arc Testnet (Chain ID 5042002)',
            'Smart contract execution, USDC settlement',
          ],
          ['Payments', 'Circle Developer Platform', 'CCTP V2, Programmable Wallets, SCA, Iris API'],
          ['Smart Contracts', 'Solidity 0.8.20', 'ArcFlareEscrow.sol + ArcFlareStream.sol'],
          ['Security', 'Upstash Redis + Zod', 'Rate limiting + input validation'],
          ['Monitoring', 'Render Logs + Sentry', 'Production error tracking'],
          ['Deployment', 'Render.com', 'Auto-deploy from GitHub main branch'],
        ]),

        h2('2.2 Key Technical Constants'),
        kv('Arc Testnet RPC', 'https://rpc.testnet.arc.network'),
        kv('Chain ID', '5042002'),
        kv('CCTP V2 Domain', '26'),
        kv('MessageTransmitterV2', '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'),
        kv('USDC on Arc Testnet', '0x3600000000000000000000000000000000000000'),
        kv('Iris API V2', 'https://iris-api-sandbox.circle.com/v2'),
        kv('ArcFlareEscrow', '0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F'),
        kv('ArcFlareStream', '0xc9BbeDFb142b6306c34838a39521c894F3dbc872'),
        kv('ERC-8004 IdentityRegistry', '0x8004A818BFB912233c491871b3d84c89A494BD9e'),
        kv('Developer Wallet', '0x902C565bE31c146a79350387C1f77d6896814B58'),

        h2('2.3 Database Schema (Prisma Models)'),
        p("Seven models power ArcFlare's persistence layer:"),
        bullet(
          'PaymentLog — all payment records with reference, amount, status, idempotency key, expiry'
        ),
        bullet('AgentRegistry — ERC-8004 agents with scaAddress, circleWalletId, tokenId, status'),
        bullet('ApiKey — developer API keys with usage tracking and active/inactive state'),
        bullet('Agent — job-based agents with capabilities and pricePerJob'),
        bullet('Escrow — trustless escrow records with depositor/beneficiary, condition, deadline'),
        bullet('Stream — streaming payment records with ratePerSecond, contractStreamId, status'),
        bullet('NanoPayment — micro-payment records with batchRef and settled flag'),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 3. API REFERENCE ─────────────────────────────────────────────────
        h1('3. API Reference'),
        p(
          'All API routes require the x-api-key header. Rate limiting is enforced via Upstash Redis. All inputs are validated with Zod schemas.'
        ),
        p('Base URL: https://arcflare-gateway.onrender.com'),

        h2('3.1 Payment Routes'),

        h3('POST /api/payments/initialize'),
        p('Creates a new payment record and returns a checkout URL.'),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['amount', 'string', '✅', "USDC amount e.g. '0.10'"],
          ['currency', 'string', '✅', "Always 'USDC'"],
          [
            'agentSCA',
            'address',
            'optional',
            'ERC-8004 agent SCA address — verified against AgentRegistry',
          ],
          ['email', 'string', 'optional', 'Human payer email (used if no agentSCA)'],
          ['merchant', 'string', 'optional', 'Merchant name or address'],
          ['webhookUrl', 'string', 'optional', 'URL to receive settlement notification'],
        ]),
        code('curl -X POST https://arcflare-gateway.onrender.com/api/payments/initialize \\'),
        code('  -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \\'),
        code(
          '  -d \'{"amount":"0.10","currency":"USDC","agentSCA":"0x7a82...","merchant":"Marketplace"}\''
        ),

        h3('POST /api/payments/settle'),
        p(
          'Settles a pending payment. Uses M2M auto-settle path on testnet or full CCTP V2 on mainnet.'
        ),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['reference', 'string', '✅', 'Payment reference from initialize'],
          ['messageHash', 'string', 'optional', 'CCTP V2 burn tx hash for cross-chain path'],
        ]),

        h3('GET /api/payments/verify/:reference'),
        p('Returns full payment status including CCTP attestation state and gateway response.'),

        h3('GET /api/payments/all'),
        p('Returns all payment logs with metrics — totalVolume, successRate, totalTransactions.'),

        h2('3.2 Agent Routes'),

        h3('POST /api/agent/deploy'),
        p('Deploys a new ERC-8004 agent with a Circle SCA wallet on Arc Testnet.'),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['agentName', 'string', 'optional', 'Agent display name'],
          ['metadataUri', 'string', 'optional', 'IPFS metadata URI for ERC-8004 identity'],
          ['ownerNode', 'string', 'optional', 'Owner node address'],
        ]),

        h3('GET /api/agent/status'),
        p('Fetch agent details by scaAddress, tokenId, or name query param.'),
        code(
          'curl "https://arcflare-gateway.onrender.com/api/agent/status?scaAddress=0x7a82..." \\'
        ),
        code('  -H "x-api-key: YOUR_KEY"'),

        h2('3.3 Escrow Routes'),

        h3('POST /api/escrow/create'),
        p('Creates a trustless USDC escrow on ArcFlareEscrow.sol.'),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['depositorSCA', 'address', '✅', 'Depositor Circle SCA wallet address'],
          ['depositorWalletId', 'uuid', '✅', 'Circle wallet ID for signing'],
          ['beneficiarySCA', 'address', '✅', 'Beneficiary SCA address'],
          ['amount', 'string', '✅', 'USDC amount to lock'],
          ['deadlineHours', 'number', 'optional', 'Hours until deadline (default: 24)'],
          ['condition', 'string', 'optional', 'Release condition description'],
          ['webhookUrl', 'string', 'optional', 'Webhook for escrow events'],
        ]),

        h3('POST /api/escrow/release'),
        p('Releases escrowed USDC to beneficiary when both parties confirm.'),

        h3('POST /api/escrow/dispute'),
        p('Raises a dispute — admin resolves onchain.'),

        h3('GET /api/escrow/status'),
        p('Returns escrow status, confirmations, time remaining, and explorer URL.'),

        h3('GET /api/escrow/list'),
        p('Lists all escrows with metrics — totalLocked, totalReleased, disputed, refunded.'),

        h2('3.4 Streaming Payment Routes'),

        h3('POST /api/payments/stream'),
        p(
          'Creates a USDC stream — USDC drips per second from sender to receiver via ArcFlareStream.sol.'
        ),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['senderSCA', 'address', '✅', 'Sender Circle SCA wallet address'],
          ['receiverSCA', 'address', '✅', 'Receiver SCA address'],
          ['ratePerSecond', 'string', '✅', "USDC per second e.g. '0.001'"],
          ['totalDeposited', 'string', '✅', "Total USDC to lock e.g. '0.01'"],
          ['webhookUrl', 'string', 'optional', 'Webhook for stream events'],
        ]),

        h3('POST /api/payments/stream/stop'),
        p('Stops an active stream. Sender gets refund, receiver gets earned USDC.'),
        code('curl -X POST .../api/payments/stream/stop \\'),
        code('  -d \'{"reference":"stream_xxx","callerSCA":"0xSenderAddress"}\''),

        h3('POST /api/payments/stream/withdraw'),
        p('Receiver withdraws earned USDC from an active stream.'),

        h2('3.5 Nanopayment Routes'),

        h3('POST /api/payments/nano'),
        p('Records a micro-payment. Batches automatically until threshold (1.0 USDC) is reached.'),
        apiTable([
          ['Field', 'Type', 'Required', 'Description'],
          ['agentSCA', 'address', '✅', 'Agent paying (consumer)'],
          ['merchantSCA', 'address', '✅', 'Merchant receiving (provider)'],
          ['amount', 'string', '✅', "Micro amount e.g. '0.0001'"],
          ['description', 'string', 'optional', "'1 API call', '100 tokens' etc."],
        ]),

        h3('POST /api/payments/nano/settle'),
        p('Batch settles all unsettled nanopayments for an agent-merchant pair.'),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 4. SMART CONTRACTS ───────────────────────────────────────────────
        h1('4. Smart Contracts'),

        h2('4.1 ArcFlareEscrow.sol'),
        kv('Address', '0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F'),
        kv('Network', 'Arc Testnet (Chain ID 5042002)'),
        kv('USDC', '0x3600000000000000000000000000000000000000'),
        p('Trustless USDC escrow contract. Key functions:'),
        bullet('createEscrow(beneficiary, amount, deadlineHours, condition) → escrowId'),
        bullet('confirmDelivery(escrowId) — depositor or beneficiary confirms'),
        bullet('releaseEscrow(escrowId) — releases on dual confirmation'),
        bullet('disputeEscrow(escrowId, reason) — flags for admin resolution'),
        bullet('refundEscrow(escrowId) — admin refunds depositor on valid dispute'),

        h2('4.2 ArcFlareStream.sol'),
        kv('Address', '0xc9BbeDFb142b6306c34838a39521c894F3dbc872'),
        kv('Network', 'Arc Testnet (Chain ID 5042002)'),
        p('Streaming payment contract. USDC drips per second. Key functions:'),
        bullet('createStream(receiver, ratePerSecond, totalDeposited, ref) → bytes32 streamId'),
        bullet('withdraw(streamId) — receiver withdraws earned USDC'),
        bullet('stopStream(streamId) — sender stops stream, refund calculated'),
        bullet('topUp(streamId, amount) — add more USDC to active stream'),
        p(
          "StreamCreated event emits three indexed params: streamId, sender, receiver. The stop and withdraw routes read streamId from topics[1] of the original createStream tx receipt via viem's getTransactionReceipt on Arc Testnet RPC."
        ),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 5. CIRCLE INTEGRATION ────────────────────────────────────────────
        h1('5. Circle Integration Details'),

        h2('5.1 Circle CCTP V2'),
        p('ArcFlare uses Circle CCTP V2 for native USDC cross-chain routing. The full flow:'),
        bullet('Step 1: Customer burns USDC on source chain (Arbitrum, Base, Ethereum)'),
        bullet('Step 2: ArcFlare calls Iris API V2 — polls every 3 seconds for attestation'),
        bullet('Step 3: On COMPLETE status, submits attestation to Arc MessageTransmitterV2'),
        bullet('Step 4: USDC mints on Arc L1 — merchant receives webhook confirmation'),
        kv('Iris API', 'https://iris-api-sandbox.circle.com/v2'),
        kv('MessageTransmitterV2', '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'),
        kv('Arc CCTP Domain', '26'),

        h2('5.2 Circle Programmable Wallets'),
        p(
          'All agent wallets are Circle Developer-Controlled Wallets (SCA) on ARC-TESTNET. The deploy flow:'
        ),
        bullet('Step 1: Create wallet set via initiateDeveloperControlledWalletsClient'),
        bullet('Step 2: Create 2 wallets (owner + validator) on ARC-TESTNET blockchain'),
        bullet('Step 3: Register ERC-8004 identity on Arc IdentityRegistry contract'),
        bullet('Step 4: Store agent in AgentRegistry Prisma model'),

        h2('5.3 Webhook Infrastructure'),
        p(
          'Circle V2 webhooks are received at /api/webhooks/circle. Signature verification is enforced using CIRCLE_WEBHOOK_SECRET. Events auto-route to appropriate handlers:'
        ),
        bullet('transfer.complete → triggers CCTP attestation polling'),
        bullet('mint.complete → updates PaymentLog status to SUCCESS'),
        bullet('settlement.completed → marks nanopayment batch as settled'),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 6. SECURITY ──────────────────────────────────────────────────────
        h1('6. Security Architecture (Week 1 Complete)'),

        apiTable([
          ['Security Feature', 'Implementation', 'Status'],
          ['Rate Limiting', 'Upstash Redis slidingWindow — per API key per route', '✅ Live'],
          ['Input Validation', 'Zod schemas on all 8 route types', '✅ Live'],
          ['Webhook Signatures', 'Circle CIRCLE_WEBHOOK_SECRET enforced — 401 on fail', '✅ Live'],
          [
            'Idempotency Keys',
            'Unique idempotencyKey field on all models — prevents duplicates',
            '✅ Live',
          ],
          [
            'Payment Expiry',
            'expiresAt field on PaymentLog — stale refs blocked on settle',
            '✅ Live',
          ],
          ['API Key Security', 'Keys removed from codebase — env var only', '✅ Live'],
          ['Error Monitoring', 'Sentry integrated — real-time error alerts', '✅ Live'],
        ]),

        h2('6.1 Rate Limit Configuration'),
        apiTable([
          ['Route Type', 'Limit', 'Window'],
          ['payments', '30 requests', 'per minute'],
          ['agent', '10 requests', 'per minute'],
          ['escrow', '20 requests', 'per minute'],
          ['stream', '20 requests', 'per minute'],
          ['nano', '100 requests', 'per minute'],
          ['keys', '5 requests', 'per minute'],
          ['default', '50 requests', 'per minute'],
        ]),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 7. DEPLOYMENT ────────────────────────────────────────────────────
        h1('7. Deployment'),

        h2('7.1 Render Configuration'),
        kv(
          'Build Command',
          'npm install && npx prisma generate && npx prisma db push && next build'
        ),
        kv('Start Command', 'next start'),
        kv('Database', 'Render PostgreSQL (free tier)'),
        kv('Node Version', '18+'),

        h2('7.2 Required Environment Variables'),
        apiTable([
          ['Variable', 'Description'],
          ['DATABASE_URL', 'Render PostgreSQL connection string'],
          ['CIRCLE_API_KEY', 'Circle Developer API key (TEST_API_KEY:id:secret format)'],
          ['CIRCLE_ENTITY_SECRET', 'Circle entity secret for SCA wallet signing'],
          ['ARC_ADMIN_PRIVATE_KEY', 'Admin wallet private key for contract deployment'],
          ['ADMIN_SECRET', 'Dashboard admin password'],
          ['CIRCLE_WEBHOOK_SECRET', 'Circle webhook signature verification secret'],
          ['UPSTASH_REDIS_REST_URL', 'Upstash Redis URL for rate limiting'],
          ['UPSTASH_REDIS_REST_TOKEN', 'Upstash Redis token'],
          ['ARCFLARE_ESCROW_CONTRACT_ADDRESS', 'Deployed ArcFlareEscrow.sol address'],
          ['ARCFLARE_STREAM_CONTRACT_ADDRESS', 'Deployed ArcFlareStream.sol address'],
          ['NEXT_PUBLIC_DASHBOARD_API_KEY', 'Public API key for dashboard UI calls'],
          ['INTERNAL_API_KEY', 'Internal API key for server-to-server calls'],
        ]),

        h2('7.3 Getting Started (Local)'),
        code('git clone https://github.com/Toblex6/ArcFlare.git'),
        code('cd ArcFlare && npm install'),
        code('cp .env.example .env  # Fill in your env vars'),
        code('npx prisma db push'),
        code('npm run dev'),
        p('Open http://localhost:3000 to see the result.'),

        divider(),
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

        // ── 8. ROADMAP ───────────────────────────────────────────────────────
        h1('8. Production Roadmap'),

        apiTable([
          ['Phase', 'Timeline', 'Key Deliverables'],
          [
            'Week 1 — Security',
            'COMPLETE',
            'Rate limiting, Zod validation, webhook signatures, idempotency, expiry',
          ],
          [
            'Week 2 — Agent Wallet',
            'In Progress',
            'Full Circle SCA signing, agent auth, checkout integration',
          ],
          [
            'Week 3 — Contracts',
            'Upcoming',
            'ArcFlareEscrow audit, CCTP V2 real burn test end-to-end',
          ],
          ['Week 4 — Dev Tools', 'Upcoming', 'Docs page, API key signup, SDK v0.1 npm package'],
          ['Arc Mainnet', 'When Arc launches', 'Switch all configs to mainnet — product is ready'],
        ]),

        divider(),

        // ── 9. VISION ────────────────────────────────────────────────────────
        h1('9. Vision'),
        new Paragraph({
          children: [
            new TextRun({
              text: 'ArcFlare aims to become the financial infrastructure layer for programmable commerce on Arc — where merchants, developers, and autonomous AI agents can seamlessly accept, route, escrow, settle, and automate stablecoin payments across multiple blockchain networks through a unified payment operating system.',
              size: 24,
              color: '1A1A1A',
              italics: true,
              font: 'Cambria',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 240 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: 'ArcFlare is not a whitepaper. It is running infrastructure. When Arc Mainnet launches, the payment layer is ready.',
              size: 28,
              color: copper,
              bold: true,
              font: 'Cambria',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 480 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: 'Oyalade Temitope  |  ',
              size: 20,
              color: '8A7560',
              font: 'Calibri',
            }),
            new TextRun({
              text: 'tobilade12@gmail.com  |  ',
              size: 20,
              color: '8A7560',
              font: 'Calibri',
            }),
            new TextRun({
              text: 'arcflare-gateway.onrender.com',
              size: 20,
              color: copper,
              font: 'Calibri',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 120 },
        }),
      ],
    },
  ],
});

Packer.toBuffer(doc)
  .then((buf) => {
    fs.writeFileSync('./arcflare-Documentation.docx', buf);
    console.log('✅ Doc written');
  })
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
const pptxgen = require('pptxgenjs');

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'Oyalade Temitope';
pres.title = 'ArcFlare — Investor Deck';

// ── Color palette (matches brand)
const C = {
  bg: '0E0B08', // near-black
  card: '1A1410', // dark card
  border: '2D2015', // border
  copper: 'C8975A', // primary accent
  cyan: '06B6D4', // secondary
  white: 'F0ECE6', // warm white
  muted: '6B5A45', // muted text
  dark: '251C12', // darker card
  green: '0D7C5F', // success green
};

const makeShadow = () => ({
  type: 'outer',
  color: '000000',
  blur: 8,
  offset: 3,
  angle: 45,
  opacity: 0.25,
});

// ════════════════════════════════════════════════════════════════════
// SLIDE 1 — COVER
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Top label
  s.addText('CONFIDENTIAL — INVESTOR BRIEF', {
    x: 0.5,
    y: 0.25,
    w: 9,
    h: 0.25,
    fontSize: 8,
    color: C.muted,
    bold: true,
    charSpacing: 3,
    align: 'center',
    fontFace: 'Calibri',
  });

  // Large AF monogram circle
  s.addShape(pres.shapes.OVAL, {
    x: 4.1,
    y: 0.8,
    w: 1.8,
    h: 1.8,
    fill: { color: C.card },
    line: { color: C.copper, width: 2 },
    shadow: makeShadow(),
  });
  s.addText('AF', {
    x: 4.1,
    y: 0.85,
    w: 1.8,
    h: 1.7,
    fontSize: 42,
    color: C.copper,
    bold: true,
    align: 'center',
    valign: 'middle',
    fontFace: 'Cambria',
    margin: 0,
  });

  // Company name
  s.addText('ARCFLARE', {
    x: 0.5,
    y: 2.75,
    w: 9,
    h: 0.7,
    fontSize: 52,
    color: C.white,
    bold: true,
    align: 'center',
    charSpacing: 8,
    fontFace: 'Cambria',
    margin: 0,
  });

  // Tagline
  s.addText('Stablecoin Payment Infrastructure and Agentic Finance Layer on Arc', {
    x: 1,
    y: 3.55,
    w: 8,
    h: 0.45,
    fontSize: 16,
    color: C.copper,
    align: 'center',
    fontFace: 'Calibri',
    margin: 0,
  });

  // Divider
  s.addShape(pres.shapes.RECTANGLE, {
    x: 3.5,
    y: 4.1,
    w: 3,
    h: 0.03,
    fill: { color: C.copper },
    line: { color: C.copper, width: 0 },
  });

  // Bottom pills
  const pills = ['Arc Testnet — Live', 'Circle CCTP V2', 'ERC-8004 Agents', '5 Payment Primitives'];
  pills.forEach((p, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.5 + i * 2.3,
      y: 4.3,
      w: 2.1,
      h: 0.35,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.05,
    });
    s.addText(p, {
      x: 0.5 + i * 2.3,
      y: 4.3,
      w: 2.1,
      h: 0.35,
      fontSize: 9,
      color: C.copper,
      align: 'center',
      valign: 'middle',
      fontFace: 'Calibri',
      margin: 0,
      charSpacing: 1,
    });
  });

  // Founder + contact
  s.addText('Oyalade Temitope — Founder & CEO  |  tobilade12@gmail.com  |  Lagos, Nigeria', {
    x: 0.5,
    y: 4.9,
    w: 9,
    h: 0.3,
    fontSize: 9,
    color: C.muted,
    align: 'center',
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('arcflare-gateway.onrender.com  |  github.com/Toblex6/ArcFlare', {
    x: 0.5,
    y: 5.2,
    w: 9,
    h: 0.25,
    fontSize: 8,
    color: C.muted,
    align: 'center',
    fontFace: 'Calibri',
    margin: 0,
  });

  s.addNotes(
    "Opening slide. Introduce yourself briefly: 'I'm Oyalade, building ArcFlare — the payment infrastructure for the agentic economy on Arc.' Let the slide breathe — don't read it aloud."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 2 — THE PROBLEM
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('THE PROBLEM', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('The agentic economy has no payment layer', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 28,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // Two columns
  const col1 = [
    {
      heading: 'For Merchants',
      items: [
        'No native USDC checkout on Arc',
        'Manual cross-chain bridging required',
        'Build payment logic from scratch every time',
        'No webhook notifications on settlement',
        '2-5 day fiat settlement delays',
      ],
    },
    {
      heading: 'For AI Agents',
      items: [
        'Agents cannot own wallets natively',
        'No M2M payment standard exists',
        'Cannot escrow funds autonomously',
        'No per-API-call billing infrastructure',
        'Machine-to-machine commerce is blocked',
      ],
    },
  ];

  col1.forEach((col, ci) => {
    const x = 0.5 + ci * 4.7;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y: 1.4,
      w: 4.4,
      h: 3.9,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.08,
      shadow: makeShadow(),
    });
    s.addText(col.heading, {
      x: x + 0.2,
      y: 1.55,
      w: 4,
      h: 0.35,
      fontSize: 13,
      color: C.copper,
      bold: true,
      fontFace: 'Cambria',
      margin: 0,
    });
    col.items.forEach((item, ii) => {
      // red X circle
      s.addShape(pres.shapes.OVAL, {
        x: x + 0.22,
        y: 2.05 + ii * 0.6,
        w: 0.22,
        h: 0.22,
        fill: { color: '4A1A1A' },
        line: { color: '8B2020', width: 1 },
      });
      s.addText('✕', {
        x: x + 0.22,
        y: 2.03 + ii * 0.6,
        w: 0.22,
        h: 0.22,
        fontSize: 8,
        color: 'CC3333',
        bold: true,
        align: 'center',
        valign: 'middle',
        fontFace: 'Calibri',
        margin: 0,
      });
      s.addText(item, {
        x: x + 0.52,
        y: 2.02 + ii * 0.6,
        w: 3.7,
        h: 0.28,
        fontSize: 11,
        color: C.white,
        fontFace: 'Calibri',
        valign: 'middle',
        margin: 0,
      });
    });
  });

  s.addNotes(
    "Paint the pain clearly. Most developers building on Arc today have to rebuild payment infrastructure from scratch every time. AI agents are even worse off — they literally can't pay each other."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 3 — THE SOLUTION
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('THE SOLUTION', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('ArcFlare — Stripe for the agentic economy on Arc', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 26,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // 6 solution cards
  const cards = [
    {
      icon: '🛒',
      title: 'Hosted Checkout',
      desc: 'Shareable USDC payment links via one API call. Webhooks fire on every settlement.',
    },
    {
      icon: '⚡',
      title: 'M2M Auto-Settlement',
      desc: 'Agents pay agents in 2 API calls. Zero human involvement. Fully autonomous.',
    },
    {
      icon: '🌐',
      title: 'CCTP V2 Cross-Chain',
      desc: 'Auto-route USDC from Arbitrum, Base, Ethereum → Arc via Circle Iris V2 API.',
    },
    {
      icon: '🔒',
      title: 'Trustless Escrow',
      desc: 'ArcFlareEscrow.sol locks USDC until both parties confirm. No middleman.',
    },
    {
      icon: '💧',
      title: 'Streaming Payments',
      desc: 'USDC drips per second via ArcFlareStream.sol. Real-time on Arc L1.',
    },
    {
      icon: '🔬',
      title: 'Nanopayments',
      desc: 'Per-API-call billing. Batches auto-settle via CCTP V2 at threshold.',
    },
  ];

  cards.forEach((card, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.4 + col * 3.1;
    const y = 1.45 + row * 1.95;

    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w: 2.9,
      h: 1.8,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.08,
      shadow: makeShadow(),
    });
    s.addText(card.icon, {
      x: x + 0.15,
      y: y + 0.12,
      w: 0.45,
      h: 0.45,
      fontSize: 20,
      align: 'center',
      valign: 'middle',
      margin: 0,
    });
    s.addText(card.title, {
      x: x + 0.62,
      y: y + 0.12,
      w: 2.15,
      h: 0.38,
      fontSize: 12,
      color: C.copper,
      bold: true,
      fontFace: 'Cambria',
      valign: 'middle',
      margin: 0,
    });
    s.addText(card.desc, {
      x: x + 0.15,
      y: y + 0.6,
      w: 2.6,
      h: 1.05,
      fontSize: 10,
      color: C.white,
      fontFace: 'Calibri',
      valign: 'top',
      margin: 0,
    });
  });

  s.addNotes(
    "Show breadth. ArcFlare is not one feature — it's a complete payment operating system. Emphasise that all 6 primitives are live on Arc Testnet today."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 4 — PRODUCT DEMO / LIVE
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('LIVE PRODUCT', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('Running on Arc Testnet. Not a whitepaper.', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 26,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // Left — flow diagram
  const steps = [
    { label: '1. Agent Deploy', sub: 'Circle SCA + ERC-8004 identity' },
    { label: '2. Initialize Payment', sub: 'POST /api/payments/initialize' },
    { label: '3. Checkout Page', sub: 'Hosted UI with real agent identity' },
    { label: '4. Settle', sub: 'M2M_AUTO_SETTLE in 2 API calls' },
    { label: '5. Webhook', sub: 'Fires to merchant instantly' },
  ];

  steps.forEach((step, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.4,
      y: 1.4 + i * 0.77,
      w: 4,
      h: 0.62,
      fill: { color: C.card },
      line: { color: i === 3 ? C.copper : C.border, width: i === 3 ? 1.5 : 1 },
      rectRadius: 0.06,
    });
    s.addText(step.label, {
      x: 0.6,
      y: 1.44 + i * 0.77,
      w: 3.6,
      h: 0.28,
      fontSize: 11,
      color: i === 3 ? C.copper : C.white,
      bold: true,
      fontFace: 'Calibri',
      margin: 0,
    });
    s.addText(step.sub, {
      x: 0.6,
      y: 1.72 + i * 0.77,
      w: 3.6,
      h: 0.22,
      fontSize: 9,
      color: C.muted,
      fontFace: 'Calibri',
      margin: 0,
    });
    if (i < steps.length - 1) {
      s.addShape(pres.shapes.LINE, {
        x: 2.4,
        y: 2.02 + i * 0.77,
        w: 0,
        h: 0.15,
        line: { color: C.copper, width: 1.5 },
      });
    }
  });

  // Right — live metrics
  const metrics = [
    { label: 'Contracts Deployed', value: '2', sub: 'ArcFlareEscrow + ArcFlareStream' },
    { label: 'API Routes Live', value: '20+', sub: 'All endpoints healthy' },
    { label: 'Payment Primitives', value: '5', sub: 'Checkout, Escrow, Stream, Nano, M2M' },
    {
      label: 'Circle Products Integrated',
      value: '5',
      sub: 'CCTP V2, Wallets, SCA, Iris, Webhooks',
    },
  ];

  metrics.forEach((m, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 5.3,
      y: 1.4 + i * 1.05,
      w: 4.2,
      h: 0.9,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.06,
      shadow: makeShadow(),
    });
    s.addText(m.value, {
      x: 5.45,
      y: 1.44 + i * 1.05,
      w: 1.2,
      h: 0.55,
      fontSize: 32,
      color: C.copper,
      bold: true,
      fontFace: 'Cambria',
      align: 'center',
      valign: 'middle',
      margin: 0,
    });
    s.addText(m.label, {
      x: 6.75,
      y: 1.46 + i * 1.05,
      w: 2.6,
      h: 0.28,
      fontSize: 11,
      color: C.white,
      bold: true,
      fontFace: 'Calibri',
      margin: 0,
    });
    s.addText(m.sub, {
      x: 6.75,
      y: 1.74 + i * 1.05,
      w: 2.6,
      h: 0.22,
      fontSize: 9,
      color: C.muted,
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    'This is your strongest slide. Show the live product. Open arcflare-gateway.onrender.com during your pitch if possible. The numbers are real — not projected.'
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 5 — CIRCLE INTEGRATION
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('CIRCLE INTEGRATION', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText("Built on top of Circle's full infrastructure stack", {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 26,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  const integrations = [
    {
      product: 'CCTP V2',
      description:
        'Cross-chain USDC routing from Arbitrum, Base, Ethereum → Arc L1 via Circle Iris V2 attestation API. Auto-routing on burn detection.',
      status: 'LIVE',
    },
    {
      product: 'Programmable Wallets',
      description:
        'Developer-controlled wallet sets provision SCA wallets for every AI agent on ARC-TESTNET. Agents sign and execute contract calls autonomously.',
      status: 'LIVE',
    },
    {
      product: 'Smart Contract Accounts',
      description:
        'Every ERC-8004 agent gets a real Circle SCA wallet. Used for USDC approvals, stream creation, escrow funding, and nanopayment settlement.',
      status: 'LIVE',
    },
    {
      product: 'Iris API V2',
      description:
        'Attestation polling at iris-api-sandbox.circle.com/v2. Auto-submits to Arc MessageTransmitterV2 on COMPLETE status.',
      status: 'LIVE',
    },
    {
      product: 'Webhook Infrastructure',
      description:
        'Circle V2 webhooks received and auto-routed. Signature verification enforced in production. Fires settlement events to merchants.',
      status: 'LIVE',
    },
  ];

  integrations.forEach((item, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.4,
      y: 1.4 + i * 0.82,
      w: 9.2,
      h: 0.72,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.06,
    });
    // Status badge
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.6,
      y: 1.52 + i * 0.82,
      w: 0.65,
      h: 0.22,
      fill: { color: '0D2E20' },
      line: { color: C.green, width: 1 },
      rectRadius: 0.04,
    });
    s.addText(item.status, {
      x: 0.6,
      y: 1.52 + i * 0.82,
      w: 0.65,
      h: 0.22,
      fontSize: 7,
      color: C.green,
      bold: true,
      align: 'center',
      valign: 'middle',
      fontFace: 'Calibri',
      charSpacing: 1,
      margin: 0,
    });
    s.addText(item.product, {
      x: 1.35,
      y: 1.48 + i * 0.82,
      w: 2,
      h: 0.3,
      fontSize: 12,
      color: C.copper,
      bold: true,
      fontFace: 'Cambria',
      margin: 0,
    });
    s.addText(item.description, {
      x: 1.35,
      y: 1.77 + i * 0.82,
      w: 8.1,
      h: 0.28,
      fontSize: 10,
      color: C.white,
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    "Emphasise: we don't wrap Circle — we build on top of it. Every payment primitive depends on Circle infrastructure. This is a deep integration, not a surface-level one."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 6 — WHY ARC
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('WHY ARC', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText("Arc's architecture unlocks payment primitives impossible on other chains", {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 22,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // Big stats row
  const stats = [
    {
      value: '<1s',
      label: 'Block Finality',
      sub: 'Enables streaming payments at second-level granularity',
    },
    {
      value: '5042002',
      label: 'Chain ID',
      sub: 'Arc Testnet — full Circle CCTP V2 support, domain 26',
    },
    {
      value: '500ms',
      label: 'Batch Windows',
      sub: 'Viable for nanopayment batching at sub-second intervals',
    },
    {
      value: 'ERC-8004',
      label: 'Agent Identity',
      sub: 'Native onchain identity standard for AI agents on Arc',
    },
  ];

  stats.forEach((stat, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.4 + i * 2.35,
      y: 1.5,
      w: 2.15,
      h: 2,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.08,
      shadow: makeShadow(),
    });
    s.addText(stat.value, {
      x: 0.4 + i * 2.35,
      y: 1.65,
      w: 2.15,
      h: 0.7,
      fontSize: i === 1 ? 18 : 28,
      color: C.copper,
      bold: true,
      align: 'center',
      fontFace: 'Cambria',
      margin: 0,
    });
    s.addText(stat.label, {
      x: 0.4 + i * 2.35,
      y: 2.38,
      w: 2.15,
      h: 0.3,
      fontSize: 11,
      color: C.white,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      margin: 0,
    });
    s.addText(stat.sub, {
      x: 0.5 + i * 2.35,
      y: 2.72,
      w: 1.95,
      h: 0.65,
      fontSize: 9,
      color: C.muted,
      align: 'center',
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  // Arc benefits
  const benefits = [
    'Near real-time payment confirmation for merchants and agents',
    "Streaming payments viable at second-level granularity — unique to Arc's finality",
    "Nanopayments economically feasible — Arc's gas efficiency keeps micro-tx costs low",
    'Cross-chain USDC from Arbitrum, Base, Ethereum lands on Arc automatically via CCTP V2',
    'ERC-8004 provides native onchain agent identity — Circle SCA wallets provision on Arc',
  ];

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.4,
    y: 3.65,
    w: 9.2,
    h: 1.65,
    fill: { color: C.card },
    line: { color: C.border, width: 1 },
    rectRadius: 0.08,
  });
  s.addText('Why this only works on Arc', {
    x: 0.65,
    y: 3.75,
    w: 5,
    h: 0.3,
    fontSize: 11,
    color: C.copper,
    bold: true,
    fontFace: 'Calibri',
    margin: 0,
  });
  benefits.forEach((b, i) => {
    s.addShape(pres.shapes.OVAL, {
      x: 0.6,
      y: 4.12 + i * 0.24,
      w: 0.13,
      h: 0.13,
      fill: { color: C.copper },
      line: { color: C.copper, width: 0 },
    });
    s.addText(b, {
      x: 0.82,
      y: 4.09 + i * 0.24,
      w: 8.6,
      h: 0.22,
      fontSize: 9.5,
      color: C.white,
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    "Arc's sub-second finality is the key differentiator. Streaming payments and nanopayments are only viable because Arc confirms in under a second. This can't be replicated on Ethereum mainnet."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 7 — BUSINESS MODEL
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('BUSINESS MODEL', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('Infrastructure charges — like Stripe, but for programmable commerce', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 22,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  const streams = [
    {
      icon: '💳',
      title: 'Transaction Fees',
      desc: '0.1–0.5% fee on every USDC payment settled through ArcFlare checkout and settle endpoints.',
      color: C.copper,
    },
    {
      icon: '🔑',
      title: 'API Subscription',
      desc: 'Monthly developer tiers — Free, Pro, Enterprise — for access to higher rate limits, priority settlement, and dedicated support.',
      color: C.cyan,
    },
    {
      icon: '🤖',
      title: 'Agent Provisioning',
      desc: 'One-time fee per agent deployed. Agents with Circle SCA wallets and ERC-8004 identity charged on creation.',
      color: 'A78BFA',
    },
    {
      icon: '🏦',
      title: 'Escrow Fees',
      desc: '0.25% of escrow value on creation. Additional fee on dispute resolution. Zero fee on standard release.',
      color: C.green,
    },
  ];

  streams.forEach((item, i) => {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const x = 0.4 + col * 4.8;
    const y = 1.45 + row * 2.05;

    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w: 4.5,
      h: 1.85,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.08,
      shadow: makeShadow(),
    });
    s.addText(item.icon, {
      x: x + 0.15,
      y: y + 0.15,
      w: 0.55,
      h: 0.55,
      fontSize: 24,
      align: 'center',
      valign: 'middle',
      margin: 0,
    });
    s.addText(item.title, {
      x: x + 0.78,
      y: y + 0.18,
      w: 3.5,
      h: 0.35,
      fontSize: 14,
      color: item.color,
      bold: true,
      fontFace: 'Cambria',
      margin: 0,
    });
    s.addText(item.desc, {
      x: x + 0.2,
      y: y + 0.65,
      w: 4.1,
      h: 1.1,
      fontSize: 10.5,
      color: C.white,
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    'ArcFlare is infrastructure — revenue compounds as more merchants and agents transact. The key metric is total volume settled. Even 1% fee on $10M monthly volume = $100K MRR.'
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 8 — ROADMAP
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('ROADMAP', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText("From testnet to the payment layer for Arc's agentic economy", {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 22,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  const phases = [
    {
      phase: 'NOW',
      label: 'Arc Testnet',
      color: C.green,
      items: [
        'All 5 payment primitives live',
        'Circle CCTP V2 + SCA + ERC-8004',
        'Security hardening complete',
        '20+ API routes deployed',
      ],
    },
    {
      phase: 'Q3 2026',
      label: 'Mainnet Launch',
      color: C.copper,
      items: [
        'Arc Mainnet contracts deployed',
        'Production Circle APIs live',
        'First 10 merchants onboarded',
        'SDK v1.0 released',
      ],
    },
    {
      phase: 'Q4 2026',
      label: 'Developer Platform',
      color: C.cyan,
      items: [
        'Self-service API key signup',
        'Full developer documentation',
        'Agent marketplace launch',
        '$10K+ monthly volume target',
      ],
    },
    {
      phase: '2027',
      label: 'Scale',
      color: 'A78BFA',
      items: [
        'Multi-chain expansion',
        'Enterprise merchant accounts',
        'Compliance & KYB layer',
        '$1M+ monthly volume target',
      ],
    },
  ];

  // Connecting line
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.85,
    y: 2.3,
    w: 8.3,
    h: 0.04,
    fill: { color: C.border },
    line: { color: C.border, width: 0 },
  });

  phases.forEach((p, i) => {
    const x = 0.4 + i * 2.35;

    // Circle on timeline
    s.addShape(pres.shapes.OVAL, {
      x: x + 0.6,
      y: 2.1,
      w: 0.4,
      h: 0.4,
      fill: { color: p.color },
      line: { color: p.color, width: 0 },
    });

    // Phase label above
    s.addText(p.phase, {
      x,
      y: 1.55,
      w: 2.15,
      h: 0.28,
      fontSize: 10,
      color: p.color,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      charSpacing: 2,
      margin: 0,
    });
    s.addText(p.label, {
      x,
      y: 1.83,
      w: 2.15,
      h: 0.25,
      fontSize: 11,
      color: C.white,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      margin: 0,
    });

    // Card below
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y: 2.65,
      w: 2.15,
      h: 2.6,
      fill: { color: C.card },
      line: { color: i === 0 ? p.color : C.border, width: i === 0 ? 1.5 : 1 },
      rectRadius: 0.08,
    });
    p.items.forEach((item, ii) => {
      s.addShape(pres.shapes.OVAL, {
        x: x + 0.18,
        y: 2.82 + ii * 0.58,
        w: 0.13,
        h: 0.13,
        fill: { color: p.color },
        line: { color: p.color, width: 0 },
      });
      s.addText(item, {
        x: x + 0.38,
        y: 2.78 + ii * 0.58,
        w: 1.68,
        h: 0.4,
        fontSize: 9,
        color: C.white,
        fontFace: 'Calibri',
        margin: 0,
      });
    });
  });

  s.addNotes(
    "The first phase is already done. We're not asking you to bet on a plan — we're asking you to back what's already built and fund the next stage."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 9 — TRACTION
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('TRACTION', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('Real infrastructure. Live transactions. Verified attestations.', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 24,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // Big wins
  const wins = [
    {
      stat: 'REDEEMED_AND_MINTED',
      label: 'CCTP V2 Status',
      sub: 'Real cross-chain settlement confirmed on Arc Testnet',
    },
    {
      stat: 'SUCCESS',
      label: 'M2M Settlement',
      sub: 'Agent-to-agent payments settling autonomously end to end',
    },
    {
      stat: '20+',
      label: 'API Routes',
      sub: 'All routes live, rate-limited, and Zod-validated in production',
    },
    {
      stat: '2',
      label: 'Smart Contracts',
      sub: 'ArcFlareEscrow + ArcFlareStream deployed and tested on Arc',
    },
  ];

  wins.forEach((w, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.4 + i * 2.35,
      y: 1.45,
      w: 2.15,
      h: 1.7,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.08,
      shadow: makeShadow(),
    });
    s.addText(w.stat, {
      x: 0.4 + i * 2.35,
      y: 1.55,
      w: 2.15,
      h: 0.6,
      fontSize: i === 0 ? 11 : 28,
      color: C.copper,
      bold: true,
      align: 'center',
      fontFace: 'Cambria',
      valign: 'middle',
      margin: 0,
    });
    s.addText(w.label, {
      x: 0.4 + i * 2.35,
      y: 2.2,
      w: 2.15,
      h: 0.28,
      fontSize: 10,
      color: C.white,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      margin: 0,
    });
    s.addText(w.sub, {
      x: 0.5 + i * 2.35,
      y: 2.5,
      w: 1.95,
      h: 0.52,
      fontSize: 8.5,
      color: C.muted,
      align: 'center',
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  // Technical achievements
  const achievements = [
    '✅ Circle CCTP V2 attestation polling via Iris API V2 — fully integrated',
    '✅ Circle SCA wallet provisioning on ARC-TESTNET — agents get real wallets',
    '✅ ERC-8004 identity registration on Arc — every agent has an onchain identity',
    '✅ ArcFlareEscrow.sol at 0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F',
    '✅ ArcFlareStream.sol at 0xc9BbeDFb142b6306c34838a39521c894F3dbc872',
    '✅ Week 1 security hardening — rate limiting, Zod validation, webhook signatures, idempotency keys',
    '✅ Stream create → stop → withdraw — end-to-end confirmed working on Arc Testnet',
    '✅ Nanopayments — 10 × 0.0001 USDC → batch settled in one tx confirmed',
  ];

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.4,
    y: 3.3,
    w: 9.2,
    h: 2,
    fill: { color: C.card },
    line: { color: C.border, width: 1 },
    rectRadius: 0.08,
  });
  s.addText('Technical Milestones Completed', {
    x: 0.65,
    y: 3.4,
    w: 5,
    h: 0.3,
    fontSize: 11,
    color: C.copper,
    bold: true,
    fontFace: 'Calibri',
    margin: 0,
  });
  achievements.forEach((a, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    s.addText(a, {
      x: 0.6 + col * 4.6,
      y: 3.78 + row * 0.33,
      w: 4.4,
      h: 0.28,
      fontSize: 9,
      color: C.white,
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    'Show the Render deploy URL and the ArcScan transaction links if asked. Every item on this slide has a real transaction hash backing it.'
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 10 — THE ASK
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('THE ASK', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('Seeking Circle 2026 Cohort 2 Grant to fund mainnet launch', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 22,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // How grant is used
  const uses = [
    {
      icon: '📋',
      title: 'Arc Mainnet Deployment',
      pct: '30%',
      desc: 'Smart contract audit, mainnet deployment, gas funding, and RPC infrastructure',
    },
    {
      icon: '🔧',
      title: 'Developer Tools',
      pct: '25%',
      desc: 'SDK v1.0 npm package, full documentation site, API key self-service signup',
    },
    {
      icon: '📣',
      title: 'Merchant Onboarding',
      pct: '20%',
      desc: 'First 10 merchants integrated, agent marketplace MVP, community building',
    },
    {
      icon: '⚙️',
      title: 'Infrastructure',
      pct: '15%',
      desc: 'Render scaling, Upstash Redis, Sentry monitoring, production Circle API access',
    },
    {
      icon: '⚖️',
      title: 'Legal & Compliance',
      pct: '10%',
      desc: 'Incorporation, Terms of Service, basic compliance framework for stablecoin payments',
    },
  ];

  uses.forEach((u, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.4,
      y: 1.45 + i * 0.8,
      w: 9.2,
      h: 0.7,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.06,
    });
    s.addText(u.icon, {
      x: 0.55,
      y: 1.49 + i * 0.8,
      w: 0.45,
      h: 0.45,
      fontSize: 18,
      align: 'center',
      valign: 'middle',
      margin: 0,
    });
    s.addText(u.title, {
      x: 1.1,
      y: 1.5 + i * 0.8,
      w: 3.5,
      h: 0.3,
      fontSize: 12,
      color: C.copper,
      bold: true,
      fontFace: 'Cambria',
      margin: 0,
    });
    s.addText(u.desc, {
      x: 1.1,
      y: 1.79 + i * 0.8,
      w: 6.5,
      h: 0.25,
      fontSize: 9.5,
      color: C.white,
      fontFace: 'Calibri',
      margin: 0,
    });
    s.addText(u.pct, {
      x: 8.1,
      y: 1.5 + i * 0.8,
      w: 1.3,
      h: 0.55,
      fontSize: 20,
      color: C.copper,
      bold: true,
      align: 'center',
      valign: 'middle',
      fontFace: 'Cambria',
      margin: 0,
    });
  });

  s.addNotes(
    'Be specific about what the grant buys. The most important use is the smart contract audit — without it we cannot go to mainnet safely. Everything else accelerates developer adoption.'
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 11 — TEAM
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText('THE TEAM', {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.4,
    fontSize: 11,
    color: C.copper,
    bold: true,
    charSpacing: 4,
    fontFace: 'Calibri',
    margin: 0,
  });
  s.addText('Builder who ships', {
    x: 0.5,
    y: 0.75,
    w: 9,
    h: 0.55,
    fontSize: 28,
    color: C.white,
    bold: true,
    fontFace: 'Cambria',
    margin: 0,
  });

  // Founder card
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 2.5,
    y: 1.5,
    w: 5,
    h: 2.2,
    fill: { color: C.card },
    line: { color: C.copper, width: 1.5 },
    rectRadius: 0.1,
    shadow: makeShadow(),
  });

  // Avatar circle
  s.addShape(pres.shapes.OVAL, {
    x: 4.2,
    y: 1.65,
    w: 1.6,
    h: 1.6,
    fill: { color: C.dark },
    line: { color: C.copper, width: 2 },
  });
  s.addText('OT', {
    x: 4.2,
    y: 1.65,
    w: 1.6,
    h: 1.6,
    fontSize: 28,
    color: C.copper,
    bold: true,
    align: 'center',
    valign: 'middle',
    fontFace: 'Cambria',
    margin: 0,
  });

  s.addText('Oyalade Temitope', {
    x: 2.6,
    y: 3.3,
    w: 4.8,
    h: 0.35,
    fontSize: 16,
    color: C.white,
    bold: true,
    align: 'center',
    fontFace: 'Cambria',
    margin: 0,
  });
  s.addText('Founder & CEO — ArcFlare | Lagos, Nigeria', {
    x: 2.6,
    y: 3.65,
    w: 4.8,
    h: 0.25,
    fontSize: 10,
    color: C.muted,
    align: 'center',
    fontFace: 'Calibri',
    margin: 0,
  });

  // What founder built
  const built = [
    'Built all 5 payment primitives solo — checkout, escrow, streaming, nanopayments, M2M',
    'Integrated 5 Circle products: CCTP V2, Programmable Wallets, SCA, Iris API, Webhooks',
    'Deployed 2 smart contracts on Arc Testnet — ERC-8004 + CCTP V2 integrations',
    'Applied to Circle 2026 Cohort 2 Grant with a live, working product demo',
  ];

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.4,
    y: 3.85,
    w: 9.2,
    h: 1.55,
    fill: { color: C.card },
    line: { color: C.border, width: 1 },
    rectRadius: 0.08,
  });
  built.forEach((b, i) => {
    s.addShape(pres.shapes.OVAL, {
      x: 0.6,
      y: 4.02 + i * 0.35,
      w: 0.13,
      h: 0.13,
      fill: { color: C.copper },
      line: { color: C.copper, width: 0 },
    });
    s.addText(b, {
      x: 0.83,
      y: 3.99 + i * 0.35,
      w: 8.6,
      h: 0.28,
      fontSize: 10,
      color: C.white,
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    "Founders who ship solo are underrated. Every feature in this deck was built by one person in weeks. The question is not 'can they build it' — it already exists."
  );
}

// ════════════════════════════════════════════════════════════════════
// SLIDE 12 — CLOSING
// ════════════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Big circle
  s.addShape(pres.shapes.OVAL, {
    x: 3.8,
    y: 0.5,
    w: 2.4,
    h: 2.4,
    fill: { color: C.card },
    line: { color: C.copper, width: 2 },
    shadow: makeShadow(),
  });
  s.addText('AF', {
    x: 3.8,
    y: 0.55,
    w: 2.4,
    h: 2.3,
    fontSize: 56,
    color: C.copper,
    bold: true,
    align: 'center',
    valign: 'middle',
    fontFace: 'Cambria',
    margin: 0,
  });

  s.addText('ArcFlare is not a whitepaper.', {
    x: 0.5,
    y: 3.05,
    w: 9,
    h: 0.5,
    fontSize: 26,
    color: C.white,
    bold: true,
    align: 'center',
    fontFace: 'Cambria',
    margin: 0,
  });
  s.addText('It is running infrastructure.', {
    x: 0.5,
    y: 3.55,
    w: 9,
    h: 0.5,
    fontSize: 26,
    color: C.copper,
    bold: true,
    align: 'center',
    fontFace: 'Cambria',
    margin: 0,
  });
  s.addText('When Arc Mainnet launches, the payment layer is ready.', {
    x: 1,
    y: 4.12,
    w: 8,
    h: 0.35,
    fontSize: 14,
    color: C.muted,
    align: 'center',
    fontFace: 'Calibri',
    margin: 0,
  });

  // Contact row
  const contacts = [
    { label: 'Founder', value: 'Oyalade Temitope' },
    { label: 'Email', value: 'tobilade12@gmail.com' },
    { label: 'Live Product', value: 'arcflare-gateway.onrender.com' },
    { label: 'GitHub', value: 'github.com/Toblex6/ArcFlare' },
  ];

  contacts.forEach((c, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.3 + i * 2.38,
      y: 4.65,
      w: 2.2,
      h: 0.65,
      fill: { color: C.card },
      line: { color: C.border, width: 1 },
      rectRadius: 0.06,
    });
    s.addText(c.label, {
      x: 0.3 + i * 2.38,
      y: 4.67,
      w: 2.2,
      h: 0.24,
      fontSize: 8,
      color: C.muted,
      align: 'center',
      charSpacing: 1,
      fontFace: 'Calibri',
      margin: 0,
    });
    s.addText(c.value, {
      x: 0.3 + i * 2.38,
      y: 4.9,
      w: 2.2,
      h: 0.27,
      fontSize: 9,
      color: C.copper,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      margin: 0,
    });
  });

  s.addNotes(
    'End strong. Invite them to open arcflare-gateway.onrender.com right now. Let them click through the checkout. Real product, real transactions, real Arc.'
  );
}

// ── Write file
pres
  .writeFile({ fileName: './ArcFlare-Investor-Deck.pptx' })
  .then(() => console.log('✅ Deck written'))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
