export default function MerchantDocsPage() {
  const sections = [
    {
      title: 'Payment Initialization',
      description: 'Create a hosted USDC checkout link for a marketplace or merchant flow.',
      code: `POST /api/payments/initialize

{
  "amount": "0.10",
  "currency": "USDC",
  "merchant": "Marketplace"
}`,
    },
    {
      title: 'Escrow',
      description: 'Create trustless USDC escrows on ArcFlareEscrow.sol.',
      code: 'POST /api/escrow/create',
    },
    {
      title: 'Streaming Payments',
      description: 'Create continuous USDC payment streams.',
      code: 'POST /api/payments/stream',
    },
    {
      title: 'Nanopayments',
      description: 'Record micro-payments and batch settle automatically.',
      code: 'POST /api/payments/nano',
    },
  ];

  return (
    <article className="space-y-8">
      <header className="rounded-[32px] border border-[#2d2019] bg-[#1a120d] p-8 shadow-2xl md:p-10">
        <div className="mb-6 inline-flex rounded-full border border-[#3a2a22] bg-[#1f140f] px-4 py-2 text-sm text-cyan-300">
          Merchant flows
        </div>
        <h1 className="text-4xl font-bold leading-tight md:text-6xl">Merchant Documentation</h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-gray-400">
          Initialize checkout, escrow funds, and settle recurring or tiny USDC payments with
          ArcFlare's hosted APIs.
        </p>
      </header>

      <section className="grid gap-6">
        {sections.map((section) => (
          <div key={section.title} className="rounded-3xl border border-[#2d2019] bg-[#1a120d] p-8">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-2xl font-bold">{section.title}</h2>
                <p className="mt-3 max-w-2xl text-gray-400">{section.description}</p>
              </div>
              <span className="w-fit rounded-full bg-cyan-400/20 px-4 py-2 text-sm font-mono text-cyan-300">
                Live
              </span>
            </div>
            <pre className="mt-6 overflow-x-auto rounded-2xl border border-[#3a2a22] bg-[#241913] p-4 text-sm text-gray-300">
              <code>{section.code}</code>
            </pre>
          </div>
        ))}
      </section>
    </article>
  );
}
