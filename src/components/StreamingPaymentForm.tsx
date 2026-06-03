'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

interface StreamFormProps {
  senderSCA: string;
}

// 1. Explicitly type the mutation payload for strict type checking
interface CreateStreamPayload {
  senderSCA: string;
  receiverSCA: string;
  amountPerMonth: number;
  durationMonths: number;
}

export default function StreamingPaymentForm({ senderSCA }: StreamFormProps) {
  const [formData, setFormData] = useState({
    receiverSCA: '',
    amountPerMonth: '',
    durationMonths: '',
  });
  const [success, setSuccess] = useState(false);

  // 2. Added payload and return type parameters to useMutation
  const mutation = useMutation<any, Error, CreateStreamPayload>({
    mutationFn: async (payload) => {
      const res = await fetch('/api/streaming/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // 3. Force fetch to throw an error so TanStack triggers onError instead of onSuccess
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to instantiate payment stream node.');
      }

      return res.json();
    },
    onSuccess: () => {
      setSuccess(true);
      setFormData({ receiverSCA: '', amountPerMonth: '', durationMonths: '' });
      setTimeout(() => setSuccess(false), 5000);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Safely parse numbers right at the submission boundary
    const amount = parseFloat(formData.amountPerMonth);
    const duration = parseInt(formData.durationMonths, 10);

    if (isNaN(amount) || isNaN(duration) || duration <= 0) return;

    mutation.mutate({
      senderSCA,
      receiverSCA: formData.receiverSCA,
      amountPerMonth: amount,
      durationMonths: duration,
    });
  };

  // Keep rendering math safe and cheap
  const parsedAmount = parseFloat(formData.amountPerMonth) || 0;
  const parsedDuration = parseInt(formData.durationMonths, 10) || 0;
  const totalAmount = parsedAmount * parsedDuration;
  const rateDisplay = parsedDuration > 0 ? totalAmount / parsedDuration : 0;

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-md">
      <h2 className="text-xl font-bold mb-4">💧 Create Payment Stream</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Receiver SCA Address</label>
          <input
            type="text"
            placeholder="0x..."
            value={formData.receiverSCA}
            onChange={(e) => setFormData({ ...formData, receiverSCA: e.target.value })}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Per Month (USDC)</label>
            <input
              type="number"
              step="0.01"
              placeholder="1000"
              value={formData.amountPerMonth}
              onChange={(e) => setFormData({ ...formData, amountPerMonth: e.target.value })}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Duration (Months)</label>
            <input
              type="number"
              placeholder="12"
              value={formData.durationMonths}
              onChange={(e) => setFormData({ ...formData, durationMonths: e.target.value })}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black"
              required
            />
          </div>
        </div>

        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-sm text-blue-900">
            Total Deposit: <strong>${totalAmount.toFixed(2)} USDC</strong>
          </p>
          <p className="text-xs text-blue-700 mt-1">
            Rate: ${rateDisplay.toFixed(2)}/month
          </p>
        </div>

        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
        >
          {mutation.isPending ? 'Creating Stream Framework...' : 'Create Stream'}
        </button>
      </form>

      {/* 4. Added visibility UI for network or validation failures */}
      {mutation.isError && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700 font-mono text-xs">❌ {mutation.error.message}</p>
        </div>
      )}

      {success && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-700">✅ Stream created successfully!</p>
        </div>
      )}
    </div>
  );
}