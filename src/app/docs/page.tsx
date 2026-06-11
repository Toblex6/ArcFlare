export default function DocsPage() {
  
  return (
    <main className="max-w-5xl mx-auto px-6 py-12 prose prose-invert">
      <h1>ArcFlare Documentation</h1>

      <p>
        Stablecoin Payment Infrastructure and Agentic Finance Layer on Arc.
      </p>

      <h2>Overview</h2>

      <p>
        ArcFlare is a full-stack stablecoin payment infrastructure platform
        built on the Arc blockchain.
      </p>

      <p>
        It enables merchants, developers, and autonomous AI agents to send,
        receive, escrow, settle, and automate USDC payments through a unified
        API layer powered by Circle infrastructure and Arc's deterministic
        finality.
      </p>

      <h2>Core Value Proposition</h2>

      <ul>
        <li>Generate shareable USDC checkout links with a single API call</li>
        <li>Deploy ERC-8004 agents with Circle SCA wallets</li>
        <li>Route USDC across chains using Circle CCTP V2</li>
        <li>Create trustless escrows</li>
        <li>Stream payments in real time</li>
        <li>Enable high-frequency nanopayments</li>
      </ul>

      <h2>Network Information</h2>

      <table>
        <tbody>
          <tr>
            <td>Network</td>
            <td>Arc Testnet</td>
          </tr>
          <tr>
            <td>Chain ID</td>
            <td>5042002</td>
          </tr>
          <tr>
            <td>CCTP Domain</td>
            <td>26</td>
          </tr>
          <tr>
            <td>RPC</td>
            <td>https://rpc.testnet.arc.network</td>
          </tr>
        </tbody>
      </table>

      <h2>Architecture</h2>

      <table>
        <thead>
          <tr>
            <th>Layer</th>
            <th>Technology</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Frontend</td>
            <td>Next.js 16</td>
          </tr>
          <tr>
            <td>Backend</td>
            <td>Next.js API Routes</td>
          </tr>
          <tr>
            <td>Database</td>
            <td>PostgreSQL + Prisma</td>
          </tr>
          <tr>
            <td>Blockchain</td>
            <td>Arc Testnet</td>
          </tr>
          <tr>
            <td>Payments</td>
            <td>Circle Developer Platform</td>
          </tr>
          <tr>
            <td>Contracts</td>
            <td>Solidity 0.8.20</td>
          </tr>
        </tbody>
      </table>

      <h2>Why Arc</h2>

      <ul>
        <li>Sub-second deterministic finality</li>
        <li>Efficient streaming payments</li>
        <li>Near-instant agent settlements</li>
        <li>Fast cross-chain USDC transfers via CCTP V2</li>
      </ul>
    </main>
  );
}