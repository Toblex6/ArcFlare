import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

export const metadata: Metadata = {
  title: 'FlareHQ | Agentic Stablecoin Infrastructure',
  description: 'Stablecoin payment infrastructure and agentic finance layer on Arc.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-[#120b08]">
      <body className="font-sans antialiased m-0 p-0">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
