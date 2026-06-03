// src/components/TransactionList.tsx
interface Transaction {
  id: string;
  type: string;
  amount: number;
  status: string;
  createdAt: string;
  counterpartyAddress: string;
}

interface TransactionListProps {
  transactions: Transaction[];
}

export default function TransactionList({ transactions }: TransactionListProps) {
  if (transactions.length === 0) {
    return <p className="text-gray-500 text-center py-8">No transactions yet</p>;
  }

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'active':
        return 'bg-blue-100 text-blue-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      escrow: '🔒',
      stream: '💧',
      cctp: '🌉',
      nano: '💥',
      payment: '💳',
    };
    return icons[type.toLowerCase()] || '📋';
  };

  // Helper to format addresses into standard clean Web3 layout (0x1234...abcd)
  const formatAddress = (addr: string) => {
    if (!addr) return '0x000...0000';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="space-y-3">
      {transactions.map((tx) => (
        <div 
          key={tx.id} 
          className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200 hover:bg-gray-100 transition"
        >
          {/* Left Column: Icon & Identity details */}
          <div className="flex items-center gap-3">
            <span className="text-2xl flex items-center justify-center">{getTypeIcon(tx.type)}</span>
            <div>
              <p className="font-semibold text-gray-900 text-sm tracking-wide">{tx.type.toUpperCase()}</p>
              <p className="text-xs text-gray-500 font-mono">{formatAddress(tx.counterpartyAddress)}</p>
            </div>
          </div>

          {/* Right Column: Financial Telemetry & Timestamps grouped cleanly */}
          <div className="text-right space-y-1">
            <p className="font-semibold text-gray-900">${tx.amount.toFixed(2)}</p>
            <div className="flex items-center justify-end gap-2">
              {/* Added suppressHydrationWarning to dodge server vs client timezone mismatches */}
              <span className="text-[10px] text-gray-400 font-medium" suppressHydrationWarning>
                {new Date(tx.createdAt).toLocaleDateString()}
              </span>
              <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase rounded ${getStatusColor(tx.status)}`}>
                {tx.status}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}