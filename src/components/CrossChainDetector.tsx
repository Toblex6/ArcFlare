'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

// Define explicit types for complete safety and autocomplete
interface ChainData {
  balance: number;
}

interface CrossChainApiResponse {
  balances: Record<string, ChainData>;
  gasPrices: Record<string, number>;
  optimalChain?: string;
  totalBalance?: number;
}

export default function CrossChainDetector({ userAddress }: { userAddress: string }) {
  const [selectedChain, setSelectedChain] = useState<string>('');

  const { data, isLoading, error } = useQuery<CrossChainApiResponse>({
    queryKey: ['crossChainBalances', userAddress],
    queryFn: async () => {
      // 1. Added backticks for string interpolation
      const res = await fetch(`/api/cross-chain/detect?address=${userAddress}`);
      
      // 2. Force fetch to throw on 4xx/5xx codes so TanStack registers the error
      if (!res.ok) {
        throw new Error('Failed to fetch telemetry from server.');
      }
      return res.json();
    },
    enabled: !!userAddress,
  });

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500 font-mono text-xs">Detecting USDC balances across chains...</p>
      </div>
    );
  }

  // 3. Render the error fallback if the query failed or the structural payload is missing
  if (error || !data || !data.balances) {
    return (
      <div className="bg-red-50 rounded-lg shadow p-6 border border-red-200">
        <p className="text-red-600 font-mono text-xs">Failed to detect valid cross-chain matrix.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-xl font-bold mb-4">💎 Cross-Chain USDC Balances</h2>

      {Object.entries(data.balances).length === 0 ? (
        <p className="text-gray-500">No USDC found on any chain</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Object.entries(data.balances).map(([chain, details]) => (
            <div
              key={chain}
              onClick={() => setSelectedChain(chain)}
              className={`p-4 rounded-lg border cursor-pointer transition ${
                selectedChain === chain
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <p className="text-sm font-semibold text-gray-700 uppercase">{chain}</p>
              <p className="text-lg font-bold text-gray-900">${details.balance.toFixed(2)}</p>
              <p className="text-xs text-gray-500">
                Gas: {data.gasPrices[chain] ? `${data.gasPrices[chain].toFixed(2)} gwei` : 'N/A'}
              </p>
            </div>
          ))}
        </div>
      )}

      {data.optimalChain && (
        <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-700">
            ✅ <strong>Optimal Chain:</strong> {data.optimalChain.toUpperCase()}{' '}
            (Best gas price + balance available)
          </p>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-500">
        Total Balance: <strong>${data.totalBalance?.toFixed(2) ?? '0.00'}</strong> USDC
      </p>
    </div>
  );
}