'use client';

import { useState } from 'react';

export default function AgentSimulator({ onRefresh }: { onRefresh: () => void }) {
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const runSimulation = async () => {
    setLoading(true);
    setLogs([]);

    const apiKey = process.env.NEXT_PUBLIC_API_KEY;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    };

    try {
      // 1. Deploy Agent
      setLogs((prev) => [...prev, '🤖 Initializing Agent via ERC-8004 Registry...']);
      const agentRes = await fetch('/api/agent/deploy', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agentName: `ArcBot-${Date.now()}`,
          ownerAddress: '0xFlareHQ...AutonomousAgent',
        }),
      });
      const agentData = await agentRes.json();

      if (!agentData.success) {
        throw new Error(agentData.error ?? 'Agent deploy failed');
      }

      const { agent } = agentData;
      setLogs((prev) => [...prev, `✅ Created SCA Wallet: ${agent.scaAddress}`]);
      setLogs((prev) => [...prev, `🔑 ERC-8004 Token ID: ${agent.tokenId}`]);

      // 2. Initialize Payment
      setLogs((prev) => [...prev, '💳 Constructing payment for 0.10 tUSDC...']);
      const initRes = await fetch('/api/payments/initialize', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          amount: '0.10',
          agentSCA: agent.scaAddress,
        }),
      });
      const initData = await initRes.json();

      if (!initData.success) {
        throw new Error(initData.error ?? 'Payment init failed');
      }

      const { reference } = initData;
      setLogs((prev) => [...prev, `📋 Payment Reference: ${reference}`]);

      // 3. Settle Payment
      setLogs((prev) => [...prev, '⚡ Polling Circle CCTP Attestation API...']);
      const settleRes = await fetch('/api/payments/settle', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reference,
          messageHash: process.env.NEXT_PUBLIC_TEST_MESSAGE_HASH ?? null,
        }),
      });
      const settleData = await settleRes.json();

      if (settleData.success) {
        setLogs((prev) => [...prev, '🎉 Settled: REDEEMED_AND_MINTED on Arc L1!']);
        if (settleData.arcTxHash) {
          setLogs((prev) => [...prev, `🔗 Tx: ${settleData.arcTxHash}`]);
        }
        onRefresh();
      } else {
        setLogs((prev) => [...prev, `⚠️ Settlement pending: ${settleData.error}`]);
        setLogs((prev) => [...prev, 'ℹ️ Pass a real CCTP messageHash to complete settlement.']);
        onRefresh();
      }
    } catch (err) {
      setLogs((prev) => [...prev, `❌ Error: ${(err as Error).message}`]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        padding: 24,
        background: '#120d08',
        borderRadius: 10,
        border: '1px solid #2a1f10',
        color: '#e8e0d0',
        fontFamily: 'monospace',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: '#6b5a45',
          letterSpacing: 2,
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        ERC-8004 Agent Provisioning Pipeline
      </div>
      <div style={{ fontSize: 12, color: '#6b5a45', marginBottom: 16 }}>
        Programmatically instantiate sandboxed SCA nodes
      </div>

      <button
        onClick={runSimulation}
        disabled={loading}
        style={{
          width: '100%',
          padding: '12px',
          background: loading ? '#1a1200' : '#0a0800',
          border: `1px solid ${loading ? '#3d2e00' : '#06b6d4'}`,
          color: loading ? '#d97706' : '#06b6d4',
          borderRadius: 6,
          cursor: loading ? 'not-allowed' : 'pointer',
          fontWeight: 'bold',
          fontSize: 12,
          fontFamily: 'monospace',
          letterSpacing: 1,
        }}
      >
        {loading ? 'PROCESSING AGENT LIFECYCLE...' : '⚡ LAUNCH AGENT LIFECYCLE'}
      </button>

      {logs.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: '#0a0800',
            border: '1px solid #2a1f10',
            borderRadius: 6,
            fontSize: 11,
            maxHeight: 160,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {logs.map((log, i) => (
            <div key={i} style={{ color: '#e8e0d0' }}>
              {log}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
