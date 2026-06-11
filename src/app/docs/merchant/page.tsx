export default function MerchantDocsPage() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-12 prose prose-invert">
      <h1>Merchant Documentation</h1>

      <h2>Payment Initialization</h2>

      <pre>
        <code>{`POST /api/payments/initialize`}</code>
      </pre>

      <pre>
        <code>{`
{
  "amount":"0.10",
  "currency":"USDC",
  "merchant":"Marketplace"
}
        `}</code>
      </pre>

      <h2>Escrow</h2>

      <p>
        Create trustless USDC escrows on ArcFlareEscrow.sol.
      </p>

      <pre>
        <code>{`
POST /api/escrow/create
        `}</code>
      </pre>

      <h2>Streaming Payments</h2>

      <p>
        Create continuous USDC payment streams.
      </p>

      <pre>
        <code>{`
POST /api/payments/stream
        `}</code>
      </pre>

      <h2>Nanopayments</h2>

      <p>
        Record micro-payments and batch settle automatically.
      </p>

      <pre>
        <code>{`
POST /api/payments/nano
        `}</code>
      </pre>
    </main>
  );
}