export default function DocsPage() {
  return (
    <main className="max-w-4xl mx-auto px-6 py-16 prose prose-invert prose-blue">
      <header className="mb-12 border-b border-zinc-800 pb-8">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl mb-4">
          FlareHQ Documentation
        </h1>
        <p className="text-xl text-zinc-400">
          Stablecoin Payment Infrastructure and Agentic Finance Layer on Arc.
        </p>
      </header>

      <section className="mb-12">
        <h2 className="text-2xl font-bold border-l-4 border-blue-500 pl-4">Overview</h2>
        <p>
          FlareHQ is a full-stack stablecoin payment infrastructure platform built on the Arc
          blockchain.
        </p>
        <p>
          It enables merchants, developers, and autonomous AI agents to send, receive, escrow,
          settle, and automate USDC payments through a unified API layer powered by Circle
          infrastructure and Arc's deterministic finality.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-bold border-l-4 border-blue-500 pl-4">
          Core Value Proposition
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 not-prose">
          {[
            'Generate shareable USDC checkout links with a single API call',
            'Deploy ERC-8004 agents with Circle SCA wallets',
            'Route USDC across chains using Circle CCTP V2',
            'Create trustless escrows',
            'Stream payments in real time',
            'Enable high-frequency nanopayments',
          ].map((feature, i) => (
            <div
              key={i}
              className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 text-zinc-300 text-sm"
            >
              {feature}
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-bold border-l-4 border-blue-500 pl-4">Network Information</h2>
        <div className="overflow-x-auto mt-6">
          <table className="w-full text-left border-collapse">
            <tbody className="divide-y divide-zinc-800">
              <tr>
                <td className="py-3 font-medium text-zinc-500 w-1/3">Network</td>
                <td className="py-3 text-zinc-200">Arc Testnet</td>
              </tr>
              <tr>
                <td className="py-3 font-medium text-zinc-500">Chain ID</td>
                <td className="py-3 font-mono text-blue-400">5042002</td>
              </tr>
              <tr>
                <td className="py-3 font-medium text-zinc-500">CCTP Domain</td>
                <td className="py-3 text-zinc-200">26</td>
              </tr>
              <tr>
                <td className="py-3 font-medium text-zinc-500">RPC</td>
                <td className="py-3 font-mono text-xs break-all text-zinc-400">
                  https://rpc.testnet.arc.network
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-bold border-l-4 border-blue-500 pl-4">Architecture</h2>
        <table className="w-full mt-6">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="py-2 text-zinc-400">Layer</th>
              <th className="py-2 text-zinc-400">Technology</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {[
              { l: 'Frontend', t: 'Next.js 16' },
              { l: 'Backend', t: 'Next.js API Routes' },
              { l: 'Database', t: 'PostgreSQL + Prisma' },
              { l: 'Blockchain', t: 'Arc Testnet' },
              { l: 'Payments', t: 'Circle Developer Platform' },
              { l: 'Contracts', t: 'Solidity 0.8.20' },
            ].map((item, i) => (
              <tr key={i}>
                <td className="py-3 text-zinc-300 font-medium">{item.l}</td>
                <td className="py-3 text-zinc-500">{item.t}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-2xl font-bold border-l-4 border-blue-500 pl-4">Why Arc</h2>
        <ul className="mt-6 space-y-2">
          <li>Sub-second deterministic finality</li>
          <li>Efficient streaming payments</li>
          <li>Near-instant agent settlements</li>
          <li>Fast cross-chain USDC transfers via CCTP V2</li>
        </ul>
      </section>
    </main>
  );
}
