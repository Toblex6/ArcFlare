'use client';
import { useState } from 'react';

export default function ProcurementDemoPage() {
  const [log, setLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const add = (s: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${s}`]);

  const runDemo = async () => {
    setLog([]);
    setLoading(true);
    try {
      add('Demo: Autonomous Procurement + Assignment (Build 5)');
      add('Step 1: Discovering security-review agents...');
      const disc = await fetch('/api/agents/discover?skill=security-review&sortBy=trust&limit=10').then((r) => r.json());
      add(`Discovered ${disc.agents?.length ?? 0} agents`);
      (disc.agents || []).slice(0, 3).forEach((a: any) => add(`  - ${a.name} (#${a.id}) trust=${a.trust?.score ?? '-'} rep=${a.reputation} skill=${JSON.stringify(a.skills)}`));

      add('Step 2: Trust scores considered (via get_agent_trust for each)');
      for (const a of (disc.agents || []).slice(0, 2)) {
        const t = await fetch(`/api/agents/${a.id}/track-record`).then((r) => r.json());
        add(`  Agent ${a.id} trust=${t.trust?.score} confidence=${t.trust?.confidence} breakdown=${JSON.stringify(t.trust?.breakdown)}`);
      }

      add('Step 3: Check treasury for hiring agent (set clientAgentId below)');
      add('To run full loop, use the API directly: POST /api/procurement with your agent id, then apply/select/hire. This page shows the discovery→trust→treasury composition.');
      add('See console for transaction links when running via brain: "Find a trusted security-review provider. Budget: 2 USDC maximum."');
    } catch (e: any) {
      add(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-2">Autonomous Procurement — Build 5 Demo</h1>
      <p className="text-sm text-gray-500 mb-4">
        Flow: Need → discover → trust → treasury → select → assign → provider accepts (own wallet) → fund escrow → submit → validation → release → ledger → reputation → future trust.
        Provider assignment happens BEFORE the on-chain job (ERC-8183 provider immutable).
      </p>
      <section className="border rounded p-4 mb-4">
        <h2 className="font-semibold mb-2">Quick Discovery Demo</h2>
        <button onClick={runDemo} disabled={loading} className="bg-cyan-500 text-white px-4 py-2 rounded disabled:opacity-50">
          {loading ? 'Running…' : 'Run Discovery → Trust → Treasury Preview'}
        </button>
      </section>
      <section className="border rounded p-4 mb-4">
        <h2 className="font-semibold mb-2">API Steps (judge)</h2>
        <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto">
{`1. POST /api/procurement { clientAgentId, description, budgetMax, skill }
2. POST /api/procurement/[id]/apply { applicantAddress, pitch } (each provider)
3. GET  /api/procurement/[id]/applicants  (ranked by trust+price+completeness)
4. POST /api/procurement/[id]/select { providerAddress }  (or omit for top)
5. POST /api/procurement/[id]/hire { budget }  -> creates ERC-8183 job (trust/treasury/spend-limit gated)
6. POST /api/jobs/[jobId]/accept  (provider's own wallet signs setBudget; policy enforced)
7. POST /api/jobs/[jobId]/fund    (client funds escrow; treasury re-checked)
8. POST /api/jobs { action: 'submit' } -> POST /api/jobs { action: 'complete' } (existing flow)
9. GET  /api/agents/[id]/track-record  (trust changes after validated completion)
10. GET  /api/agents/[id]/ledger        (PAYROLL_SPEND/JOB_ESCROW_* etc. awaited)

Brain instruction: "Find a trusted security-review provider. Budget: 2 USDC maximum."
Brain composes: discover_agents -> get_agent_trust -> check_treasury -> create_procurement -> get_procurement_applicants -> select_procurement_provider -> hire_from_procurement -> provider_accept_job -> fund_job`}
        </pre>
      </section>
      <section className="border rounded p-4">
        <h2 className="font-semibold mb-2">Log</h2>
        <pre className="text-xs bg-black text-green-400 p-3 rounded h-64 overflow-auto whitespace-pre-wrap">{log.join('\n')}</pre>
      </section>
      <section className="border rounded p-4 mt-4">
        <h2 className="font-semibold mb-2">Acceptance Policy</h2>
        <p className="text-xs text-gray-600">Provider controls via POST /api/agents/[id]/acceptance-policy: minBudget, maxConcurrentJobs, minClientTrustScore, allowedSkills, autoAccept</p>
      </section>
    </main>
  );
}
