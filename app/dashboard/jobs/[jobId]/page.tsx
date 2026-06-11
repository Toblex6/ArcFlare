"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface JobDetail {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: string;
  expiredAt: string;
  status: string;
  statusCode: number;
}

export default function JobDetailPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchJob = async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const data = await res.json();
      if (data.success) setJob(data.job);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (jobId) fetchJob();
  }, [jobId]);

  const setBudget = async () => {
    const providerWalletId = prompt("Enter your Circle Wallet ID (provider):");
    const budgetUsd = prompt("Budget in USDC (e.g., 10):");
    if (!providerWalletId || !budgetUsd) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/jobs/set-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          providerWalletId,
          budget: (parseFloat(budgetUsd) * 1e6).toString(),
        }),
      });
      const data = await res.json();
      if (data.success) fetchJob();
      else alert("Error: " + data.error);
    } catch (err: any) {
      alert(err.message);
    }
    setActionLoading(false);
  };

  const fundJob = async () => {
    const clientWalletId = prompt("Enter your Circle Wallet ID (client):");
    if (!clientWalletId) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/jobs/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, clientWalletId }),
      });
      const data = await res.json();
      if (data.success) fetchJob();
      else alert("Error: " + data.error);
    } catch (err: any) {
      alert(err.message);
    }
    setActionLoading(false);
  };

  const submitDeliverable = async () => {
    const providerWalletId = prompt("Enter your Circle Wallet ID (provider):");
    const deliverable = prompt("Deliverable description or hash:");
    if (!providerWalletId || !deliverable) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/jobs/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, providerWalletId, deliverableData: deliverable }),
      });
      const data = await res.json();
      if (data.success) fetchJob();
      else alert("Error: " + data.error);
    } catch (err: any) {
      alert(err.message);
    }
    setActionLoading(false);
  };

  const completeJob = async () => {
    const evaluatorWalletId = prompt("Enter your Circle Wallet ID (evaluator):");
    if (!evaluatorWalletId) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/jobs/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, evaluatorWalletId }),
      });
      const data = await res.json();
      if (data.success) fetchJob();
      else alert("Error: " + data.error);
    } catch (err: any) {
      alert(err.message);
    }
    setActionLoading(false);
  };

  if (loading) {
    return <div className="animate-pulse text-copper">Loading job details...</div>;
  }
  if (!job) {
    return <div className="text-red-400">Job not found.</div>;
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-copper">Job #{jobId}</h1>
        <span className={`text-sm px-2 py-0.5 rounded-full ${
          job.status === "OPEN" ? "bg-yellow-900 text-yellow-300" :
          job.status === "FUNDED" ? "bg-blue-900 text-blue-300" :
          job.status === "SUBMITTED" ? "bg-purple-900 text-purple-300" :
          job.status === "COMPLETED" ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-400"
        }`}>
          {job.status}
        </span>
      </div>

      <div className="bg-cardbg border border-copper/20 rounded-lg p-5 space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-copper/70 uppercase">Client</label>
            <p className="font-mono text-sm break-all">{job.client}</p>
          </div>
          <div>
            <label className="text-xs text-copper/70 uppercase">Provider</label>
            <p className="font-mono text-sm break-all">{job.provider}</p>
          </div>
          <div>
            <label className="text-xs text-copper/70 uppercase">Evaluator</label>
            <p className="font-mono text-sm break-all">{job.evaluator}</p>
          </div>
          <div>
            <label className="text-xs text-copper/70 uppercase">Budget</label>
            <p className="text-lg font-semibold text-copper">{job.budget} USDC</p>
          </div>
        </div>
        <div>
          <label className="text-xs text-copper/70 uppercase">Description</label>
          <p className="text-gray-300 mt-1">{job.description}</p>
        </div>
        <div>
          <label className="text-xs text-copper/70 uppercase">Expires</label>
          <p>{new Date(job.expiredAt).toLocaleString()}</p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {job.status === "OPEN" && (
          <>
            <button
              onClick={setBudget}
              disabled={actionLoading}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md disabled:opacity-50"
            >
              Set Budget
            </button>
            <button
              onClick={fundJob}
              disabled={actionLoading}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-md disabled:opacity-50"
            >
              Fund Escrow
            </button>
          </>
        )}
        {job.status === "FUNDED" && (
          <button
            onClick={submitDeliverable}
            disabled={actionLoading}
            className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-md"
          >
            Submit Deliverable
          </button>
        )}
        {job.status === "SUBMITTED" && (
          <button
            onClick={completeJob}
            disabled={actionLoading}
            className="bg-copper text-darkbg hover:bg-copper/90 px-4 py-2 rounded-md font-medium"
          >
            Complete Job
          </button>
        )}
        {actionLoading && <span className="text-sm text-gray-400">Processing...</span>}
      </div>
    </div>
  );
}