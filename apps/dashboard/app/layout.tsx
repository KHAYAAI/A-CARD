import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "A-CARD Dashboard",
  description: "Virtual cards for AI agents — ZAR first",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
