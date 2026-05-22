import "@/app/globals.css";
import Providers from "./providers";

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
        </Providers>
      </body>
    </html>
  );
}