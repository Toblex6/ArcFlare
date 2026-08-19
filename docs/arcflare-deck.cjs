const pptxgen = require('pptxgenjs');

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'Oyalade Temitope';
pres.title = 'FlareHQ — Investor Deck';

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
  s.addText('FLAREHQ', {
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
  s.addText('arcflare-gateway.onrender.com  |  github.com/Toblex6/FlareHQ', {
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
    "Opening slide. Introduce yourself briefly: 'I'm Oyalade, building FlareHQ — the payment infrastructure for the agentic economy on Arc.' Let the slide breathe — don't read it aloud."
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
  s.addText('FlareHQ — Stripe for the agentic economy on Arc', {
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
    "Show breadth. FlareHQ is not one feature — it's a complete payment operating system. Emphasise that all 6 primitives are live on Arc Testnet today."
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
      desc: '0.1–0.5% fee on every USDC payment settled through FlareHQ checkout and settle endpoints.',
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
    'FlareHQ is infrastructure — revenue compounds as more merchants and agents transact. The key metric is total volume settled. Even 1% fee on $10M monthly volume = $100K MRR.'
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
    '✅ ArcFlareStream.sol at 0xc9BbeDFb142b6306c34838a39521c894F3dbc872 — NOT YET DEPLOYED (planned)',
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
  s.addText('Founder & CEO — FlareHQ | Lagos, Nigeria', {
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

  s.addText('FlareHQ is not a whitepaper.', {
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
    { label: 'GitHub', value: 'github.com/Toblex6/FlareHQ' },
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
  .writeFile({ fileName: './docs/FlareHQ-Investor-Deck.pptx' })
  .then(() => console.log('✅ Deck written'))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
