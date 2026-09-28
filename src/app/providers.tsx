//src\app\providers.tsx
'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { ThemeProvider } from 'next-themes';
import { config } from '@/src/lib/wagmi';
import { NetworkProvider } from '@/src/components/NetworkContext';

export default function Providers({ children }: { children: React.ReactNode }) {
  // Safe initialization of QueryClient for your API calls
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <NetworkProvider>{children}</NetworkProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
