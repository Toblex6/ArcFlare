export default function ApiDocsPage() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-12 prose prose-invert">
      <h1>API Reference</h1>

      <h2>Authentication</h2>

      <pre>
        <code>{`x-api-key: YOUR_API_KEY`}</code>
      </pre>

      <h2>Base URL</h2>

      <pre>
        <code>
          https://arcflare-gateway.onrender.com
        </code>
      </pre>

      <h2>Payments</h2>

      <ul>
        <li>POST /api/payments/initialize</li>
        <li>POST /api/payments/settle</li>
        <li>GET /api/payments/verify/:reference</li>
        <li>GET /api/payments/all</li>
      </ul>

      <h2>Agents</h2>

      <ul>
        <li>POST /api/agent/deploy</li>
        <li>GET /api/agent/status</li>
      </ul>

      <h2>Escrow</h2>

      <ul>
        <li>POST /api/escrow/create</li>
        <li>POST /api/escrow/release</li>
        <li>POST /api/escrow/dispute</li>
        <li>GET /api/escrow/status</li>
        <li>GET /api/escrow/list</li>
      </ul>

      <h2>Streaming Payments</h2>

      <ul>
        <li>POST /api/payments/stream</li>
        <li>POST /api/payments/stream/stop</li>
        <li>POST /api/payments/stream/withdraw</li>
      </ul>

      <h2>Nanopayments</h2>

      <ul>
        <li>POST /api/payments/nano</li>
        <li>POST /api/payments/nano/settle</li>
      </ul>
    </main>
  );
}