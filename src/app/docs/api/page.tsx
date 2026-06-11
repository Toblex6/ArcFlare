export default function ApiDocsPage() {
  const endpointGroups = [
    {
      title: "Payments",
      endpoints: [
        "POST /api/payments/initialize",
        "POST /api/payments/settle",
        "GET /api/payments/verify/:reference",
        "GET /api/payments/all",
      ],
    },
    {
      title: "Agents",
      endpoints: ["POST /api/agent/deploy", "GET /api/agent/status"],
    },
    {
      title: "Escrow",
      endpoints: [
        "POST /api/escrow/create",
        "POST /api/escrow/release",
        "POST /api/escrow/dispute",
        "GET /api/escrow/status",
        "GET /api/escrow/list",
      ],
    },
    {
      title: "Streaming Payments",
      endpoints: [
        "POST /api/payments/stream",
        "POST /api/payments/stream/stop",
        "POST /api/payments/stream/withdraw",
      ],
    },
    {
      title: "Nanopayments",
      endpoints: ["POST /api/payments/nano", "POST /api/payments/nano/settle"],
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
          Authenticate requests, target the hosted gateway, and compose payment,
          agent, escrow, streaming, and nanopayment endpoints.
        </p>
      </header>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Authentication</h2>
          <pre className="mt-5 overflow-x-auto rounded-2xl border border-[#3a2a22] bg-[#241913] p-4 text-sm text-cyan-300">
            <code>{`x-api-key: YOUR_API_KEY`}</code>
          </pre>
        </div>

        <div className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
          <h2 className="text-2xl font-bold">Base URL</h2>
          <pre className="mt-5 overflow-x-auto rounded-2xl border border-[#3a2a22] bg-[#241913] p-4 text-sm text-cyan-300">
            <code>https://arcflare-gateway.onrender.com</code>
          </pre>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        {endpointGroups.map((group) => (
          <div key={group.title} className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
            <h2 className="text-2xl font-bold">{group.title}</h2>
            <ul className="mt-5 space-y-3">
              {group.endpoints.map((endpoint) => (
                <li
                  key={endpoint}
                  className="rounded-2xl bg-[#241913] px-4 py-3 font-mono text-sm text-gray-300"
                >
                  <span className="text-cyan-300">{endpoint.split(" ")[0]}</span>{" "}
                  {endpoint.substring(endpoint.indexOf(" ") + 1)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </article>
  );
}
