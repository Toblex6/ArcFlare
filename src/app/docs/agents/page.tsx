export default function AgentDocsPage() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-12 prose prose-invert">
      <h1>Agent Documentation</h1>

      <h2>Deploy Agent</h2>

      <pre>
        <code>{`
POST /api/agent/deploy
        `}</code>
      </pre>

      <h2>Agent Deployment Flow</h2>

      <ol>
        <li>Create wallet set</li>
        <li>Create owner wallet</li>
        <li>Create validator wallet</li>
        <li>Register ERC-8004 identity</li>
        <li>Store agent in registry</li>
      </ol>

      <h2>Circle Programmable Wallets</h2>

      <p>
        All agent wallets are Circle Developer-Controlled Wallets.
      </p>

      <h2>Circle CCTP V2</h2>

      <ol>
        <li>Burn USDC on source chain</li>
        <li>Poll Iris API</li>
        <li>Receive COMPLETE attestation</li>
        <li>Submit attestation to Arc</li>
        <li>Mint USDC on Arc</li>
      </ol>

      <h2>Supported Networks</h2>

      <ul>
        <li>Ethereum</li>
        <li>Arbitrum</li>
        <li>Base</li>
        <li>Arc</li>
      </ul>
    </main>
  );
}