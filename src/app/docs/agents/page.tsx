export default function AgentDocsPage() {
  const deploymentSteps = [
    'Create wallet set',
    'Create owner wallet',
    'Create validator wallet',
    'Register ERC-8004 identity',
    'Store agent in registry',
  ];

  const cctpSteps = [
    'Burn USDC on source chain',
    'Poll Iris API',
    'Receive COMPLETE attestation',
    'Submit attestation to Arc',
    'Mint USDC on Arc',
  ];

  return (
    <article className="space-y-8">
      <header className="rounded-[32px] border border-[#2d2019] bg-[#1a120d] p-8 shadow-2xl md:p-10">
        <div className="mb-6 inline-flex rounded-full border border-[#3a2a22] bg-[#1f140f] px-4 py-2 text-sm text-cyan-300">
          Autonomous payments
        </div>
        <h1 className="text-4xl font-bold leading-tight md:text-6xl">Agent Documentation</h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-gray-400">
          ERC-8004 identity, Circle SCA wallets and ERC-8183 jobs are separate capabilities.
          Mainnet job actions and job streams are unavailable; x402 is disabled.
        </p>
      </header>

      <section className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
        <h2 className="text-2xl font-bold">Mainnet availability — November 16, 2026</h2>
        <p className="mt-5 text-gray-400">A registry identity or SCA wallet does not enable ERC-8183. Read-only job lists and pre-chain postings remain available; protocol actions require a configured ERC-8183 contract. Mainnet escrow is unavailable and job streams additionally require a FUNDED job and a stream contract. No deployment or funded mainnet job was performed in this readiness run.</p>
      </section>

      <section className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
        <h2 className="text-2xl font-bold">Deploy Agent</h2>
        <p className="mt-3 text-gray-400">Merchant authentication and Circle authorization are required. Wallet provisioning and registration have separate failure states; do not treat a pending identity as active.</p>
        <pre className="mt-5 overflow-x-auto rounded-2xl border border-[#3a2a22] bg-[#241913] p-4 text-sm text-cyan-300">
          <code>POST /api/agent/deploy</code>
        </pre>
      </section>

      <section className="grid gap-8 xl:grid-cols-2">
        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Agent Deployment Flow</h2>
          <ol className="mt-5 space-y-3">
            {deploymentSteps.map((step, index) => (
              <li key={step} className="flex gap-4 rounded-2xl bg-[#241913] p-4 text-gray-300">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-400 text-sm font-bold text-black">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Circle CCTP V2</h2>
          <p className="mt-3 text-gray-400">Illustrative bridge sequence. Mainnet completion requires supported source configuration, funds, signing access and receipt verification; it has not been proved here.</p>
          <ol className="mt-5 space-y-3">
            {cctpSteps.map((step, index) => (
              <li key={step} className="flex gap-4 rounded-2xl bg-[#241913] p-4 text-gray-300">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-400 text-sm font-bold text-black">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Circle Programmable Wallets</h2>
          <p className="mt-5 text-gray-400">
            Agent treasury wallets are Circle Developer-Controlled SCAs. x402 payment
            proofs require a separate EOA; a Circle SCA cannot be an x402 payer. Mainnet
            x402 execution remains disabled even with a configured verifier.
          </p>
        </div>

        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Agent identifiers</h2>
          <ul className="mt-5 grid grid-cols-2 gap-3">
            {['Registry ID: database identity', 'ERC-8004 token ID: on-chain identity', 'SCA wallet: treasury address'].map((identifier) => (
              <li key={identifier} className="rounded-2xl bg-[#241913] p-4 text-sm text-gray-300">
                <span className="mr-2 text-cyan-300">-</span>
                {identifier}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </article>
  );
}
