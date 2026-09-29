import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

export const metadata: Metadata = {
  title: 'FlareHQ | Agentic Stablecoin Infrastructure',
  description: 'Stablecoin payment infrastructure and agentic finance layer on Arc.',
  // FlareHQ brand icon (NOT the Next.js default): the production tab icon
  // resolves to the FlareHQ logo served from /public. Both the file-convention
  // src/app/favicon.ico and these explicit links point at FlareHQ assets.
  icons: {
    icon: [
      { url: '/arcflare-logo.png', type: 'image/png' },
    ],
    apple: [{ url: '/arcflare-logo.png', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased m-0 p-0">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
