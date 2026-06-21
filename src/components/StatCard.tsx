// src/components/StatCard.tsx
import React from 'react';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode; // Upgraded to support strings, emojis, or SVG components
}

export default function StatCard({ title, value, icon }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-600">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        </div>
        {/* Changed to a flex div to keep SVGs and emojis uniformly aligned */}
        <div className="text-3xl flex items-center justify-center text-gray-500">{icon}</div>
      </div>
    </div>
  );
}
