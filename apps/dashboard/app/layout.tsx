import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "a·card — console",
  description: "Virtual cards for AI agents — ZAR & USD",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
