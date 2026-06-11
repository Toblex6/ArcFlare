const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  PageBreak, Header, Footer, VerticalAlign,
} = require("docx");
const fs = require("fs");

// ── Helpers ──────────────────────────────────────────────────────────────────
const copper = "C8975A";
const dark   = "1A1410";
const white  = "F0ECE6";

const h1 = (text) => new Paragraph({
  text,
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 400, after: 120 },
  run: { color: copper, bold: true },
  shading: { type: ShadingType.SOLID, color: "1A1410", fill: "1A1410" },
});

const h2 = (text) => new Paragraph({
  text,
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 280, after: 80 },
  run: { color: copper },
});

const h3 = (text) => new Paragraph({
  text,
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 180, after: 60 },
  run: { color: "8A7560" },
});

const p = (text, opts = {}) => new Paragraph({
  children: [new TextRun({ text, size: 22, color: opts.color || "1A1A1A", ...opts })],
  spacing: { before: 80, after: 80 },
});

const code = (text) => new Paragraph({
  children: [new TextRun({
    text,
    font: "Courier New",
    size: 18,
    color: "B45309",
  })],
  shading: { type: ShadingType.SOLID, fill: "F5F0E8" },
  spacing: { before: 40, after: 40 },
  indent: { left: 360 },
});

const bullet = (text, level = 0) => new Paragraph({
  children: [new TextRun({ text, size: 22, color: "1A1A1A" })],
  bullet: { level },
  spacing: { before: 40, after: 40 },
});

const divider = () => new Paragraph({
  border: { bottom: { color: "C8975A", size: 6, style: BorderStyle.SINGLE } },
  spacing: { before: 200, after: 200 },
});

const kv = (key, value) => new Paragraph({
  children: [
    new TextRun({ text: `${key}: `, bold: true, size: 22, color: "1A1A1A" }),
    new TextRun({ text: value, size: 22, color: "1A1A1A", font: "Courier New" }),
  ],
  spacing: { before: 40, after: 40 },
});

const apiTable = (rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: rows.map((row, ri) => new TableRow({
    children: row.map((cell) => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({
          text: cell,
          size: ri === 0 ? 20 : 20,
          bold: ri === 0,
          color: ri === 0 ? "FFFFFF" : "1A1A1A",
          font: "Calibri",
        })],
        spacing: { before: 40, after: 40 },
      })],
      shading: ri === 0 ? { type: ShadingType.SOLID, fill: "2D2015" } : {},
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      verticalAlign: VerticalAlign.CENTER,
    })),
  })),
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: "C8975A" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "C8975A" },
    left:   { style: BorderStyle.SINGLE, size: 4, color: "C8975A" },
    right:  { style: BorderStyle.SINGLE, size: 4, color: "C8975A" },
    insideH:{ style: BorderStyle.SINGLE, size: 2, color: "E2D5C0" },
    insideV:{ style: BorderStyle.SINGLE, size: 2, color: "E2D5C0" },
  },
});

// ════════════════════════════════════════════════════════════════════
// DOCUMENT
// ════════════════════════════════════════════════════════════════════
const doc = new Document({
  title: "ArcFlare Technical Documentation",
  creator: "Oyalade Temitope",
  description: "ArcFlare stablecoin payment infrastructure — full technical reference",
  styles: {
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal",
        run: { size: 36, bold: true, color: copper, font: "Cambria" },
        paragraph: { spacing: { before: 400, after: 120 } },
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal",
        run: { size: 28, bold: true, color: copper, font: "Cambria" },
        paragraph: { spacing: { before: 280, after: 80 } },
      },
      {
        id: "Heading3", name: "Heading 3", basedOn: "Normal",
        run: { size: 24, bold: true, color: "8A7560", font: "Calibri" },
        paragraph: { spacing: { before: 180, after: 60 } },
      },
    ],
  },
  sections: [{
    properties: {
      page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          children: [
            new TextRun({ text: "ArcFlare — Technical Documentation  |  ", size: 18, color: "8A7560", font: "Calibri" }),
            new TextRun({ text: "arcflare-gateway.onrender.com", size: 18, color: copper, font: "Calibri" }),
          ],
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "C8975A" } },
          spacing: { after: 120 },
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
          text: "ArcFlare Documentation",
          alignment: AlignmentType.CENTER,
         }),
        ],
      }),
    },
    children: [

      // ── COVER ────────────────────────────────────────────────────────────
      new Paragraph({
        children: [new TextRun({ text: "ARCFLARE", size: 72, bold: true, color: copper, font: "Cambria", charSpacing: 200 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 600, after: 120 },
      }),
      new Paragraph({
        children: [new TextRun({ text: "Stablecoin Payment Infrastructure and Agentic Finance Layer on Arc", size: 28, color: "8A7560", font: "Calibri", italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 240 },
      }),
      new Paragraph({
        children: [new TextRun({ text: "Technical Documentation & Developer Reference", size: 22, color: "8A7560", font: "Calibri" })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 480 },
      }),
      apiTable([
        ["Field", "Value"],
        ["Founder", "Oyalade Temitope"],
        ["Email", "tobilade12@gmail.com"],
        ["Location", "Lagos, Nigeria"],
        ["Live URL", "arcflare-gateway.onrender.com"],
        ["GitHub", "github.com/Toblex6/ArcFlare"],
        ["Stack", "Next.js 16 / Prisma / PostgreSQL / Arc Testnet"],
        ["Circle Products", "CCTP V2, Programmable Wallets, SCA, Iris API, Webhooks"],
        ["Status", "Live on Arc Testnet — Circle 2026 Cohort 2 Grant Applicant"],
      ]),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 1. OVERVIEW ──────────────────────────────────────────────────────
      h1("1. Project Overview"),
      p("ArcFlare is a full-stack stablecoin payment infrastructure platform built on the Arc blockchain. It enables merchants, developers, and autonomous AI agents to send, receive, escrow, settle, and automate USDC payments through a unified API layer — powered by Circle's infrastructure and Arc's sub-second deterministic finality."),
      p("Think of it as Stripe for programmable commerce and AI agents. One API call initializes a payment. Two API calls complete an agent-to-agent settlement with zero human involvement."),

      h2("1.1 Core Value Proposition"),
      bullet("Merchants generate shareable USDC checkout links via one API call"),
      bullet("AI agents get onchain identities (ERC-8004) and real Circle SCA wallets"),
      bullet("Cross-chain USDC routes automatically from Arbitrum, Base, Ethereum → Arc via CCTP V2"),
      bullet("Trustless escrow, streaming payments, and nanopayments built in as primitives"),
      bullet("All infrastructure is live on Arc Testnet today"),

      h2("1.2 Why Arc"),
      p("Arc's sub-second deterministic finality makes ArcFlare's payment primitives viable at scale:"),
      bullet("Streaming payments drip USDC per second with real-time accuracy"),
      bullet("Nanopayments settle efficiently without long block wait times"),
      bullet("Cross-chain USDC arrives on Arc in seconds via CCTP V2, not minutes"),
      bullet("Agent-to-agent payments confirm near-instantly"),
      bullet("Arc Testnet Chain ID: 5042002 | CCTP V2 Domain: 26"),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 2. ARCHITECTURE ──────────────────────────────────────────────────
      h1("2. Technical Architecture"),

      h2("2.1 Stack"),
      apiTable([
        ["Layer", "Technology", "Purpose"],
        ["Frontend", "Next.js 16 (App Router)", "Merchant dashboard, hosted checkout, escrow UI"],
        ["Backend", "Next.js API Routes", "All payment, agent, escrow, stream, nano endpoints"],
        ["Database", "PostgreSQL + Prisma", "Payment logs, agent registry, escrow, streams"],
        ["Blockchain", "Arc Testnet (Chain ID 5042002)", "Smart contract execution, USDC settlement"],
        ["Payments", "Circle Developer Platform", "CCTP V2, Programmable Wallets, SCA, Iris API"],
        ["Smart Contracts", "Solidity 0.8.20", "ArcFlareEscrow.sol + ArcFlareStream.sol"],
        ["Security", "Upstash Redis + Zod", "Rate limiting + input validation"],
        ["Monitoring", "Render Logs + Sentry", "Production error tracking"],
        ["Deployment", "Render.com", "Auto-deploy from GitHub main branch"],
      ]),

      h2("2.2 Key Technical Constants"),
      kv("Arc Testnet RPC", "https://rpc.testnet.arc.network"),
      kv("Chain ID", "5042002"),
      kv("CCTP V2 Domain", "26"),
      kv("MessageTransmitterV2", "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"),
      kv("USDC on Arc Testnet", "0x3600000000000000000000000000000000000000"),
      kv("Iris API V2", "https://iris-api-sandbox.circle.com/v2"),
      kv("ArcFlareEscrow", "0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F"),
      kv("ArcFlareStream", "0xc9BbeDFb142b6306c34838a39521c894F3dbc872"),
      kv("ERC-8004 IdentityRegistry", "0x8004A818BFB912233c491871b3d84c89A494BD9e"),
      kv("Developer Wallet", "0x902C565bE31c146a79350387C1f77d6896814B58"),

      h2("2.3 Database Schema (Prisma Models)"),
      p("Seven models power ArcFlare's persistence layer:"),
      bullet("PaymentLog — all payment records with reference, amount, status, idempotency key, expiry"),
      bullet("AgentRegistry — ERC-8004 agents with scaAddress, circleWalletId, tokenId, status"),
      bullet("ApiKey — developer API keys with usage tracking and active/inactive state"),
      bullet("Agent — job-based agents with capabilities and pricePerJob"),
      bullet("Escrow — trustless escrow records with depositor/beneficiary, condition, deadline"),
      bullet("Stream — streaming payment records with ratePerSecond, contractStreamId, status"),
      bullet("NanoPayment — micro-payment records with batchRef and settled flag"),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 3. API REFERENCE ─────────────────────────────────────────────────
      h1("3. API Reference"),
      p("All API routes require the x-api-key header. Rate limiting is enforced via Upstash Redis. All inputs are validated with Zod schemas."),
      p("Base URL: https://arcflare-gateway.onrender.com"),

      h2("3.1 Payment Routes"),

      h3("POST /api/payments/initialize"),
      p("Creates a new payment record and returns a checkout URL."),
      apiTable([
        ["Field", "Type", "Required", "Description"],
        ["amount", "string", "✅", "USDC amount e.g. '0.10'"],
        ["currency", "string", "✅", "Always 'USDC'"],
        ["agentSCA", "address", "optional", "ERC-8004 agent SCA address — verified against AgentRegistry"],
        ["email", "string", "optional", "Human payer email (used if no agentSCA)"],
        ["merchant", "string", "optional", "Merchant name or address"],
        ["webhookUrl", "string", "optional", "URL to receive settlement notification"],
      ]),
      code('curl -X POST https://arcflare-gateway.onrender.com/api/payments/initialize \\'),
      code('  -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \\'),
      code('  -d \'{"amount":"0.10","currency":"USDC","agentSCA":"0x7a82...","merchant":"Marketplace"}\''),

      h3("POST /api/payments/settle"),
      p("Settles a pending payment. Uses M2M auto-settle path on testnet or full CCTP V2 on mainnet."),
      apiTable([
        ["Field", "Type", "Required", "Description"],
        ["reference", "string", "✅", "Payment reference from initialize"],
        ["messageHash", "string", "optional", "CCTP V2 burn tx hash for cross-chain path"],
      ]),

      h3("GET /api/payments/verify/:reference"),
      p("Returns full payment status including CCTP attestation state and gateway response."),

      h3("GET /api/payments/all"),
      p("Returns all payment logs with metrics — totalVolume, successRate, totalTransactions."),

      h2("3.2 Agent Routes"),

      h3("POST /api/agent/deploy"),
      p("Deploys a new ERC-8004 agent with a Circle SCA wallet on Arc Testnet."),
      apiTable([
        ["Field", "Type", "Required", "Description"],
        ["agentName", "string", "optional", "Agent display name"],
        ["metadataUri", "string", "optional", "IPFS metadata URI for ERC-8004 identity"],
        ["ownerNode", "string", "optional", "Owner node address"],
      ]),

      h3("GET /api/agent/status"),
      p("Fetch agent details by scaAddress, tokenId, or name query param."),
      code('curl "https://arcflare-gateway.onrender.com/api/agent/status?scaAddress=0x7a82..." \\'),
      code('  -H "x-api-key: YOUR_KEY"'),

      h2("3.3 Escrow Routes"),

      h3("POST /api/escrow/create"),
      p("Creates a trustless USDC escrow on ArcFlareEscrow.sol."),
      apiTable([
        ["Field", "Type", "Required", "Description"],
        ["depositorSCA", "address", "✅", "Depositor Circle SCA wallet address"],
        ["depositorWalletId", "uuid", "✅", "Circle wallet ID for signing"],
        ["beneficiarySCA", "address", "✅", "Beneficiary SCA address"],
        ["amount", "string", "✅", "USDC amount to lock"],
        ["deadlineHours", "number", "optional", "Hours until deadline (default: 24)"],
        ["condition", "string", "optional", "Release condition description"],
        ["webhookUrl", "string", "optional", "Webhook for escrow events"],
      ]),

      h3("POST /api/escrow/release"),
      p("Releases escrowed USDC to beneficiary when both parties confirm."),

      h3("POST /api/escrow/dispute"),
      p("Raises a dispute — admin resolves onchain."),

      h3("GET /api/escrow/status"),
      p("Returns escrow status, confirmations, time remaining, and explorer URL."),

      h3("GET /api/escrow/list"),
      p("Lists all escrows with metrics — totalLocked, totalReleased, disputed, refunded."),

      h2("3.4 Streaming Payment Routes"),

      h3("POST /api/payments/stream"),
      p("Creates a USDC stream — USDC drips per second from sender to receiver via ArcFlareStream.sol."),
      apiTable([
        ["Field", "Type", "Required", "Description"],
        ["senderSCA", "address", "✅", "Sender Circle SCA wallet address"],
        ["receiverSCA", "address", "✅", "Receiver SCA address"],
        ["ratePerSecond", "string", "✅", "USDC per second e.g. '0.001'"],
        ["totalDeposited", "string", "✅", "Total USDC to lock e.g. '0.01'"],
        ["webhookUrl", "string", "optional", "Webhook for stream events"],
      ]),

      h3("POST /api/payments/stream/stop"),
      p("Stops an active stream. Sender gets refund, receiver gets earned USDC."),
      code('curl -X POST .../api/payments/stream/stop \\'),
      code('  -d \'{"reference":"stream_xxx","callerSCA":"0xSenderAddress"}\''),

      h3("POST /api/payments/stream/withdraw"),
      p("Receiver withdraws earned USDC from an active stream."),

      h2("3.5 Nanopayment Routes"),

      h3("POST /api/payments/nano"),
      p("Records a micro-payment. Batches automatically until threshold (1.0 USDC) is reached."),
      apiTable([
        ["Field", "Type", "Required", "Description"],
        ["agentSCA", "address", "✅", "Agent paying (consumer)"],
        ["merchantSCA", "address", "✅", "Merchant receiving (provider)"],
        ["amount", "string", "✅", "Micro amount e.g. '0.0001'"],
        ["description", "string", "optional", "'1 API call', '100 tokens' etc."],
      ]),

      h3("POST /api/payments/nano/settle"),
      p("Batch settles all unsettled nanopayments for an agent-merchant pair."),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 4. SMART CONTRACTS ───────────────────────────────────────────────
      h1("4. Smart Contracts"),

      h2("4.1 ArcFlareEscrow.sol"),
      kv("Address", "0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F"),
      kv("Network", "Arc Testnet (Chain ID 5042002)"),
      kv("USDC", "0x3600000000000000000000000000000000000000"),
      p("Trustless USDC escrow contract. Key functions:"),
      bullet("createEscrow(beneficiary, amount, deadlineHours, condition) → escrowId"),
      bullet("confirmDelivery(escrowId) — depositor or beneficiary confirms"),
      bullet("releaseEscrow(escrowId) — releases on dual confirmation"),
      bullet("disputeEscrow(escrowId, reason) — flags for admin resolution"),
      bullet("refundEscrow(escrowId) — admin refunds depositor on valid dispute"),

      h2("4.2 ArcFlareStream.sol"),
      kv("Address", "0xc9BbeDFb142b6306c34838a39521c894F3dbc872"),
      kv("Network", "Arc Testnet (Chain ID 5042002)"),
      p("Streaming payment contract. USDC drips per second. Key functions:"),
      bullet("createStream(receiver, ratePerSecond, totalDeposited, ref) → bytes32 streamId"),
      bullet("withdraw(streamId) — receiver withdraws earned USDC"),
      bullet("stopStream(streamId) — sender stops stream, refund calculated"),
      bullet("topUp(streamId, amount) — add more USDC to active stream"),
      p("StreamCreated event emits three indexed params: streamId, sender, receiver. The stop and withdraw routes read streamId from topics[1] of the original createStream tx receipt via viem's getTransactionReceipt on Arc Testnet RPC."),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 5. CIRCLE INTEGRATION ────────────────────────────────────────────
      h1("5. Circle Integration Details"),

      h2("5.1 Circle CCTP V2"),
      p("ArcFlare uses Circle CCTP V2 for native USDC cross-chain routing. The full flow:"),
      bullet("Step 1: Customer burns USDC on source chain (Arbitrum, Base, Ethereum)"),
      bullet("Step 2: ArcFlare calls Iris API V2 — polls every 3 seconds for attestation"),
      bullet("Step 3: On COMPLETE status, submits attestation to Arc MessageTransmitterV2"),
      bullet("Step 4: USDC mints on Arc L1 — merchant receives webhook confirmation"),
      kv("Iris API", "https://iris-api-sandbox.circle.com/v2"),
      kv("MessageTransmitterV2", "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"),
      kv("Arc CCTP Domain", "26"),

      h2("5.2 Circle Programmable Wallets"),
      p("All agent wallets are Circle Developer-Controlled Wallets (SCA) on ARC-TESTNET. The deploy flow:"),
      bullet("Step 1: Create wallet set via initiateDeveloperControlledWalletsClient"),
      bullet("Step 2: Create 2 wallets (owner + validator) on ARC-TESTNET blockchain"),
      bullet("Step 3: Register ERC-8004 identity on Arc IdentityRegistry contract"),
      bullet("Step 4: Store agent in AgentRegistry Prisma model"),

      h2("5.3 Webhook Infrastructure"),
      p("Circle V2 webhooks are received at /api/webhooks/circle. Signature verification is enforced using CIRCLE_WEBHOOK_SECRET. Events auto-route to appropriate handlers:"),
      bullet("transfer.complete → triggers CCTP attestation polling"),
      bullet("mint.complete → updates PaymentLog status to SUCCESS"),
      bullet("settlement.completed → marks nanopayment batch as settled"),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 6. SECURITY ──────────────────────────────────────────────────────
      h1("6. Security Architecture (Week 1 Complete)"),

      apiTable([
        ["Security Feature", "Implementation", "Status"],
        ["Rate Limiting", "Upstash Redis slidingWindow — per API key per route", "✅ Live"],
        ["Input Validation", "Zod schemas on all 8 route types", "✅ Live"],
        ["Webhook Signatures", "Circle CIRCLE_WEBHOOK_SECRET enforced — 401 on fail", "✅ Live"],
        ["Idempotency Keys", "Unique idempotencyKey field on all models — prevents duplicates", "✅ Live"],
        ["Payment Expiry", "expiresAt field on PaymentLog — stale refs blocked on settle", "✅ Live"],
        ["API Key Security", "Keys removed from codebase — env var only", "✅ Live"],
        ["Error Monitoring", "Sentry integrated — real-time error alerts", "✅ Live"],
      ]),

      h2("6.1 Rate Limit Configuration"),
      apiTable([
        ["Route Type", "Limit", "Window"],
        ["payments", "30 requests", "per minute"],
        ["agent", "10 requests", "per minute"],
        ["escrow", "20 requests", "per minute"],
        ["stream", "20 requests", "per minute"],
        ["nano", "100 requests", "per minute"],
        ["keys", "5 requests", "per minute"],
        ["default", "50 requests", "per minute"],
      ]),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 7. DEPLOYMENT ────────────────────────────────────────────────────
      h1("7. Deployment"),

      h2("7.1 Render Configuration"),
      kv("Build Command", "npm install && npx prisma generate && npx prisma db push && next build"),
      kv("Start Command", "next start"),
      kv("Database", "Render PostgreSQL (free tier)"),
      kv("Node Version", "18+"),

      h2("7.2 Required Environment Variables"),
      apiTable([
        ["Variable", "Description"],
        ["DATABASE_URL", "Render PostgreSQL connection string"],
        ["CIRCLE_API_KEY", "Circle Developer API key (TEST_API_KEY:id:secret format)"],
        ["CIRCLE_ENTITY_SECRET", "Circle entity secret for SCA wallet signing"],
        ["ARC_ADMIN_PRIVATE_KEY", "Admin wallet private key for contract deployment"],
        ["ADMIN_SECRET", "Dashboard admin password"],
        ["CIRCLE_WEBHOOK_SECRET", "Circle webhook signature verification secret"],
        ["UPSTASH_REDIS_REST_URL", "Upstash Redis URL for rate limiting"],
        ["UPSTASH_REDIS_REST_TOKEN", "Upstash Redis token"],
        ["ARCFLARE_ESCROW_CONTRACT_ADDRESS", "Deployed ArcFlareEscrow.sol address"],
        ["ARCFLARE_STREAM_CONTRACT_ADDRESS", "Deployed ArcFlareStream.sol address"],
        ["NEXT_PUBLIC_DASHBOARD_API_KEY", "Public API key for dashboard UI calls"],
        ["INTERNAL_API_KEY", "Internal API key for server-to-server calls"],
      ]),

      h2("7.3 Getting Started (Local)"),
      code("git clone https://github.com/Toblex6/ArcFlare.git"),
      code("cd ArcFlare && npm install"),
      code("cp .env.example .env  # Fill in your env vars"),
      code("npx prisma db push"),
      code("npm run dev"),
      p("Open http://localhost:3000 to see the result."),

      divider(),
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ── 8. ROADMAP ───────────────────────────────────────────────────────
      h1("8. Production Roadmap"),

      apiTable([
        ["Phase", "Timeline", "Key Deliverables"],
        ["Week 1 — Security", "COMPLETE", "Rate limiting, Zod validation, webhook signatures, idempotency, expiry"],
        ["Week 2 — Agent Wallet", "In Progress", "Full Circle SCA signing, agent auth, checkout integration"],
        ["Week 3 — Contracts", "Upcoming", "ArcFlareEscrow audit, CCTP V2 real burn test end-to-end"],
        ["Week 4 — Dev Tools", "Upcoming", "Docs page, API key signup, SDK v0.1 npm package"],
        ["Arc Mainnet", "When Arc launches", "Switch all configs to mainnet — product is ready"],
      ]),

      divider(),

      // ── 9. VISION ────────────────────────────────────────────────────────
      h1("9. Vision"),
      new Paragraph({
        children: [new TextRun({
          text: "ArcFlare aims to become the financial infrastructure layer for programmable commerce on Arc — where merchants, developers, and autonomous AI agents can seamlessly accept, route, escrow, settle, and automate stablecoin payments across multiple blockchain networks through a unified payment operating system.",
          size: 24,
          color: "1A1A1A",
          italics: true,
          font: "Cambria",
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 240 },
      }),
      new Paragraph({
        children: [new TextRun({
          text: "ArcFlare is not a whitepaper. It is running infrastructure. When Arc Mainnet launches, the payment layer is ready.",
          size: 28,
          color: copper,
          bold: true,
          font: "Cambria",
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 480 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "Oyalade Temitope  |  ", size: 20, color: "8A7560", font: "Calibri" }),
          new TextRun({ text: "tobilade12@gmail.com  |  ", size: 20, color: "8A7560", font: "Calibri" }),
          new TextRun({ text: "arcflare-gateway.onrender.com", size: 20, color: copper, font: "Calibri" }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 120 },
      }),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("./docs/ArcFlare-Documentation.docx", buf);
  console.log("✅ Doc written");
}).catch((e) => { console.error("❌", e); process.exit(1); });
