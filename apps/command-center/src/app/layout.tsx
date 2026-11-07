import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Command Center", description: "Personal AI company operating system" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
