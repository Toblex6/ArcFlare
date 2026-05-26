import "@/app/globals.css";
import Providers from "./providers";
// ── 1. Import the new widget safely ──────────────────────────────────
import FlowFiFeedback from "@/components/FlowFiFeedback"; 

export const metadata = {
  title: "ArcFlare",
  description: "Stablecoin Payment Gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          {children}
          
          {/* ── 2. Add the component right here inside your providers ── */}
          <FlowFiFeedback />
        </Providers>
      </body>
    </html>
  );
}