import type { Metadata } from "next";
import "./globals.css";

// Every page is rendered per request so it can carry that request's CSP nonce (statically prerendered HTML cannot).
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Command Center", description: "Personal AI company operating system" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
