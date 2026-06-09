"use client";
import { useEffect, useState } from "react";

export default function MerchantDashboard() {
  const [data, setData] = useState<any>(null);
  const [linkData, setLinkData] = useState({ amount: "", currency: "USDC" });
  const [generatedLink, setGeneratedLink] = useState("");

  useEffect(() => {
    fetchDashboard();
  }, []);

  const fetchDashboard = () => {
    const key = localStorage.getItem("arcflare_api_key");
    if (!key) {
      window.location.href = "/merchant/login";
      return;
    }
    fetch("/api/merchant/dashboard", { headers: { "x-api-key": key } })
      .then((res) => res.json())
      .then((json) => {
        if (json.error) window.location.href = "/merchant/login";
        else setData(json);
      });
  };

  const createLink = async () => {
    const key = localStorage.getItem("arcflare_api_key");
    const res = await fetch("/api/payments/initialize", {
      method: "POST",
      headers: { "x-api-key": key || "", "Content-Type": "application/json" },
      body: JSON.stringify(linkData),
    });
    const json = await res.json();
    if (json.checkoutUrl) setGeneratedLink(json.checkoutUrl);
  };

  const handleLogout = () => {
    localStorage.removeItem("arcflare_api_key");
    window.location.href = "/merchant/login";
  };

  if (!data) return <div className="p-10 text-slate-400 bg-slate-950 min-h-screen">Loading...</div>;

  return (
    <div className="min-h-screen bg-slate-950 p-10 text-white">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Welcome, {data.businessName}</h1>
        <button onClick={handleLogout} className="text-slate-500 hover:text-red-400 text-sm transition-colors">
          Logout
        </button>
      </div>
      
      {/* 1. Generator Section */}
      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 mb-8">
        <h2 className="text-lg font-bold mb-4">Create Payment Link</h2>
        <div className="flex gap-4">
          <input 
            placeholder="Amount" 
            className="bg-slate-800 p-2 rounded-lg border border-slate-700 focus:border-cyan-500 outline-none w-32" 
            onChange={(e) => setLinkData({ ...linkData, amount: e.target.value })} 
          />
          <button onClick={createLink} className="bg-cyan-600 hover:bg-cyan-500 px-6 py-2 rounded-lg font-bold transition-all">
            Generate
          </button>
        </div>

        {generatedLink && (
          <div className="mt-4 p-4 bg-slate-950 border border-cyan-800 rounded-lg flex items-center justify-between">
            <div className="overflow-hidden mr-4">
              <span className="text-sm text-cyan-300 truncate block font-mono">
                {generatedLink}
              </span>
            </div>
            <button 
              onClick={() => {
                navigator.clipboard.writeText(generatedLink);
                const btn = document.getElementById('copy-btn');
                if (btn) {
                  btn.innerText = "Copied!";
                  setTimeout(() => btn.innerText = "Copy Link", 2000);
                }
              }}
              id="copy-btn"
              className="bg-cyan-900 hover:bg-cyan-800 text-cyan-200 px-3 py-1 rounded-md text-xs font-bold transition-all shrink-0"
            >
              Copy Link
            </button>
          </div>
        )}
      </div>

      {/* 2. Transaction List */}
      <h2 className="text-xl font-bold mb-4">Your Transactions</h2>
      <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden">
        {data.payments.length > 0 ? (
          data.payments.map((p: any) => (
            <div key={p.id} className="p-4 border-b border-slate-800 flex justify-between items-center hover:bg-slate-800/50 transition-colors">
              <span className="font-mono text-sm text-slate-400">{p.reference}</span>
              <span className="text-cyan-400 font-bold">{p.amount} {p.currency}</span>
            </div>
          ))
        ) : (
          <div className="p-8 text-center text-slate-500">No transactions found yet.</div>
        )}
      </div>
    </div>
  );
}