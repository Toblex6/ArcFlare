// src/components/AgentDeployer.tsx
"use client";

import React, { useState } from "react";

interface DeploymentResult {
  success: boolean;
  agent?: {
    name: string;
    tokenId: string;
    scaAddress: string;
    status: string;
  };
  txHash?: string;
  explorerUrl?: string;
  wallets?: {
    owner: string;
    validator: string;
  };
}

export default function AgentDeployer() {
  const [agentName, setAgentName] = useState("");
  const [ownerNode, setOwnerNode] = useState("0xbD3FAD84e7a41D222c7C36947B0A3B1592F42154"); 
  const [metadataUri, setMetadataUri] = useState("");
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeploymentResult | null>(null);

  const handleProvisionAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    if (!agentName.trim()) {
      setError("Please specify an identity name for the autonomous machine.");
      setLoading(false);
      return;
    }

    try {
      // ⚡ AUTOMATIC GATEWAY HOOK: Passes the request directly down your secure pipeline
      const response = await fetch("/api/agent/deploy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The backend reads this securely from Render's environment config variables
        },
        body: JSON.stringify({
          agentName,
          ownerNode,
          metadataUri: metadataUri || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Server responded with status code ${response.status}`);
      }

      setResult(data);
      setAgentName(""); 
    } catch (err: any) {
      setError(err.message || "An unforeseen crash occurred during processing.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 shadow-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-white mb-2">
          Provision Agent Lifecycle Layer
        </h2>
        <p className="text-sm text-slate-400">
          Deploy genuine Circle Smart Contract Accounts (SCA) and mint on-chain ERC-8004 Identity tokens instantly. **Protected by Admin Layer Middleware.**
        </p>
      </div>

      <form onSubmit={handleProvisionAgent} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Agent Identity Profile Name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Agent Identity Name
            </label>
            <input
              type="text"
              placeholder="e.g., Siggy Mascot Engine"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              className="w-full p-3 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>

          {/* Node Owner Execution Address */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Owner Node Operator Address
            </label>
            <input
              type="text"
              placeholder="0x..."
              value={ownerNode}
              onChange={(e) => setOwnerNode(e.target.value)}
              className="w-full p-3 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
        </div>

        {/* Optional Metadata Link */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
            Custom IPFS Metadata URI (Optional)
          </label>
          <input
            type="text"
            placeholder="ipfs://bafkreib..."
            value={metadataUri}
            onChange={(e) => setMetadataUri(e.target.value)}
            className="w-full p-3 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        {/* Action Trigger Submit Mechanism */}
        <button
          type="submit"
          disabled={loading}
          className="w-full p-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 font-semibold rounded-lg text-sm text-white transition-all shadow-md active:scale-[0.99]"
        >
          {loading ? "🔄 Deploying Secure Wallets & Minting Identity..." : "⚡ Provision Autonomous Machine Agent"}
        </button>
      </form>

      {/* Dynamic Feedback Error Banner */}
      {error && (
        <div className="mt-4 p-4 bg-red-950/50 border border-red-900 rounded-lg text-sm text-red-400">
          <strong>System Message:</strong> {error}
        </div>
      )}

      {/* Structured Output Dashboard Result Cards */}
      {result && result.success && (
        <div className="mt-6 p-5 bg-slate-950 border border-emerald-900/50 rounded-lg space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wide">
              ✓ Agent Deployed & Logged to Registry
            </h3>
            <span className="text-xs px-2 py-0.5 bg-emerald-950 text-emerald-400 border border-emerald-800 rounded-full">
              {result.agent?.status}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono text-slate-300">
            <p><span className="text-slate-500 font-sans font-semibold inline-block w-28">Registry Token ID:</span> {result.agent?.tokenId}</p>
            <p><span className="text-slate-500 font-sans font-semibold inline-block w-28">Owner SCA Wallet:</span> <span className="text-white select-all">{result.wallets?.owner}</span></p>
            <p><span className="text-slate-500 font-sans font-semibold inline-block w-28">Validator Wallet:</span> <span className="text-slate-400 select-all">{result.wallets?.validator}</span></p>
            <p><span className="text-slate-500 font-sans font-semibold inline-block w-28">Arc L1 Tx Hash:</span> <span className="text-slate-400 truncate">{result.txHash}</span></p>
          </div>

          {result.explorerUrl && (
            <div className="pt-2 border-t border-slate-900 flex justify-end">
              <a
                href={result.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-emerald-400 hover:text-emerald-300 underline font-semibold flex items-center gap-1"
              >
                Inspect Agent Generation on Arcscan ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}