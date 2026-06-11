"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface Job {
  id: string;
  jobId: string;
  clientSCA: string;
  providerSCA: string;
  description: string;
  budget: string;
  status: string;
  createdAt: string;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    clientWalletId: "",
    providerAddress: "",
    evaluatorAddress: "",
    description: "",
  });

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/jobs/list");
      const data = await res.json();
      if (data.success) setJobs(data.jobs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  const createJob = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) {
        setShowCreate(false);
        fetchJobs();
      } else {
        alert("Error: " + data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      OPEN: "bg-yellow-900 text-yellow-300",
      FUNDED: "bg-blue-900 text-blue-300",
      SUBMITTED: "bg-purple-900 text-purple-300",
      COMPLETED: "bg-green-900 text-green-300",
      REJECTED: "bg-red-900 text-red-300",
      EXPIRED: "bg-gray-800 text-gray-400",
    };
    return styles[status] || "bg-gray-800 text-gray-300";
  };

  if (loading) {
    return <div className="animate-pulse text-copper">Loading jobs...</div>;
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-copper">ERC‑8183 Job Marketplace</h2>
        <p className="text-gray-400 mt-1">Create and manage autonomous service agreements</p>
      </div>

      <div className="flex justify-end mb-6">
        <button
          onClick={() => setShowCreate(true)}
          className="bg-copper text-darkbg px-4 py-2 rounded-md font-medium hover:bg-copper/80 transition"
        >
          + New Job
        </button>
      </div>

      <div className="grid gap-5">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="bg-cardbg border border-copper/20 rounded-lg p-5 hover:border-copper/50 transition"
          >
            <div className="flex flex-wrap justify-between items-start gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-copper/70">Job #{job.jobId}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadge(job.status)}`}>
                    {job.status}
                  </span>
                </div>
                <p className="font-medium text-white">{job.description}</p>
                <div className="text-sm text-gray-400">
                  <span>Client: {job.clientSCA.slice(0, 8)}...{job.clientSCA.slice(-6)}</span>
                  <span className="mx-2">•</span>
                  <span>Provider: {job.providerSCA.slice(0, 8)}...{job.providerSCA.slice(-6)}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-copper font-semibold">{Number(job.budget) / 1e6} USDC</div>
                <div className="text-xs text-gray-500 mt-1">
                  {new Date(job.createdAt).toLocaleDateString()}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-copper/10 flex gap-3">
              {job.status === "OPEN" && (
                <Link
                  href={`/dashboard/jobs/${job.jobId}`}
                  className="text-sm bg-copper/10 text-copper px-3 py-1 rounded-md hover:bg-copper/20"
                >
                  Set Budget & Fund
                </Link>
              )}
              {job.status === "FUNDED" && (
                <Link
                  href={`/dashboard/jobs/${job.jobId}`}
                  className="text-sm bg-purple-600/20 text-purple-300 px-3 py-1 rounded-md"
                >
                  Submit Deliverable
                </Link>
              )}
              {job.status === "SUBMITTED" && (
                <Link
                  href={`/dashboard/jobs/${job.jobId}`}
                  className="text-sm bg-green-600/20 text-green-300 px-3 py-1 rounded-md"
                >
                  Complete Job
                </Link>
              )}
              <Link
                href={`/dashboard/jobs/${job.jobId}`}
                className="text-sm text-gray-400 hover:text-white"
              >
                Details →
              </Link>
            </div>
          </div>
        ))}
      </div>

      {jobs.length === 0 && (
        <div className="text-center py-12 text-gray-500 border border-dashed border-copper/30 rounded-lg">
          No jobs yet. Create your first ERC‑8183 job.
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-cardbg border border-copper/30 rounded-lg max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-copper mb-4">Create New Job</h3>
            <form onSubmit={createJob} className="space-y-4">
              <input
                type="text"
                placeholder="Client Circle Wallet ID"
                className="w-full bg-darkbg border border-copper/30 rounded px-3 py-2 text-white focus:outline-none focus:border-copper"
                value={form.clientWalletId}
                onChange={(e) => setForm({ ...form, clientWalletId: e.target.value })}
                required
              />
              <input
                type="text"
                placeholder="Provider Ethereum Address"
                className="w-full bg-darkbg border border-copper/30 rounded px-3 py-2 text-white focus:outline-none focus:border-copper"
                value={form.providerAddress}
                onChange={(e) => setForm({ ...form, providerAddress: e.target.value })}
                required
              />
              <input
                type="text"
                placeholder="Evaluator Ethereum Address"
                className="w-full bg-darkbg border border-copper/30 rounded px-3 py-2 text-white focus:outline-none focus:border-copper"
                value={form.evaluatorAddress}
                onChange={(e) => setForm({ ...form, evaluatorAddress: e.target.value })}
                required
              />
              <textarea
                placeholder="Job description"
                rows={3}
                className="w-full bg-darkbg border border-copper/30 rounded px-3 py-2 text-white focus:outline-none focus:border-copper"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                required
              />
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 border border-copper/40 rounded text-gray-300 hover:bg-copper/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-copper text-darkbg rounded font-medium hover:bg-copper/90"
                >
                  Create Job
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
