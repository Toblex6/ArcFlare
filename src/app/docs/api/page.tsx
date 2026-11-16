export default function ApiDocsPage() {
  const endpointGroups = [
    {
      title: 'Payments',
      availability: 'Authenticated checkout flows. Mainnet payment execution still requires an owner-run test; customers pay merchants directly.',
      endpoints: [
        'POST /api/payments/initialize',
        'POST /api/payments/settle',
        'GET /api/payments/verify/:reference',
        'GET /api/payments/all',
      ],
    },
    {
      title: 'Agents',
      availability: 'ERC-8004 identity and SCA wallets do not enable mainnet ERC-8183 jobs or x402 payment proofs.',
      endpoints: ['POST /api/agent/deploy', 'GET /api/agent/status'],
    },
    {
      title: 'Escrow',
      availability: 'Unavailable on mainnet pending contract deployment and verification. Disabled operations return 503 escrow_unavailable.',
      endpoints: [
        'POST /api/escrow/create',
        'POST /api/escrow/release',
        'POST /api/escrow/dispute',
        'GET /api/escrow/status',
        'GET /api/escrow/list',
      ],
    },
    {
      title: 'Criterion-based job streams',
      availability: 'Unavailable on mainnet without ERC-8183 and a configured stream contract. Opening requires a FUNDED job; closing pays the remaining budget to the worker, not a refund to the poster.',
      endpoints: [
        'POST /api/jobs/nanopay/open',
        'POST /api/jobs/nanopay/release',
        'POST /api/jobs/nanopay/close',
        'GET /api/jobs/nanopay/status',
      ],
    },
    {
      title: 'Retired per-second streams',
      availability: 'Legacy create, stop and withdraw are disabled with 503 stream_unavailable. These are not the criterion-based job workflow.',
      endpoints: [
        'POST /api/payments/stream/create',
        'POST /api/payments/stream/stop',
        'POST /api/payments/stream/withdraw',
      ],
    },
    {
      title: 'Nanopayments',
      availability: 'Ledger batching is separate from x402 and job streams. Mainnet execution was not verified in this readiness run.',
      endpoints: ['POST /api/payments/nano', 'POST /api/payments/nano/settle'],
    },
    {
      title: 'x402',
      availability: 'Disabled on mainnet even when a verifier address is configured. Resource routes return 503 x402_unavailable before a challenge; buyer Gateway routes return 503 gateway_mainnet_unavailable, with endpoint-specific authentication. On a configured testnet, payers must be EOAs, not Circle SCAs.',
      endpoints: ['POST /api/agent/brain', 'POST /api/x402/pay'],
    },
    {
      title: 'CCTP bridge',
      availability: 'Requires supported mainnet source configuration, funds and wallet authorization. Successful mainnet completion is not yet verified.',
      endpoints: ['GET /api/cctp/transfer', 'POST /api/cctp/transfer', 'GET /api/cctp/transfer/status'],
    },
  ];

  return (
    <article className="space-y-8">
      <header className="rounded-[32px] border border-[#2d2019] bg-[#1a120d] p-8 shadow-2xl md:p-10">
        <div className="mb-6 inline-flex rounded-full border border-[#3a2a22] bg-[#1f140f] px-4 py-2 text-sm text-cyan-300">
          Developer surface
        </div>
        <h1 className="text-4xl font-bold leading-tight md:text-6xl">API Reference</h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-gray-400">
          Mainnet availability as of November 16, 2026. Check the endpoint-specific status
          before using it; a route listing is not a successful settlement claim.
        </p>
      </header>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Authentication</h2>
          <p className="mt-3 text-gray-400">Routes use their documented API key or merchant, consumer or admin session. These auth systems are distinct. Unavailable POST paths can return 503 before authentication; configured money paths still require ownership and step-up checks.</p>
          <pre className="mt-5 overflow-x-auto rounded-2xl border border-[#3a2a22] bg-[#241913] p-4 text-sm text-cyan-300">
            <code>{`x-api-key: YOUR_API_KEY`}</code>
          </pre>
        </div>

        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Base URL</h2>
          <pre className="mt-5 overflow-x-auto rounded-2xl border border-[#3a2a22] bg-[#241913] p-4 text-sm text-cyan-300">
            <code>https://flarehq.xyz</code>
          </pre>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        {endpointGroups.map((group) => (
          <div key={group.title} className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
            <h2 className="text-2xl font-bold">{group.title}</h2>
            <p className="mt-3 text-gray-400">{group.availability}</p>
            <ul className="mt-5 space-y-3">
              {group.endpoints.map((endpoint) => (
                <li
                  key={endpoint}
                  className="rounded-2xl bg-[#241913] px-4 py-3 font-mono text-sm text-gray-300"
                >
                  <span className="text-cyan-300">{endpoint.split(' ')[0]}</span>{' '}
                  {endpoint.substring(endpoint.indexOf(' ') + 1)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </article>
  );
}
