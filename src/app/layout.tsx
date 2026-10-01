import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Montikids School System",
  description: "Management system for Montikids Montessori Preschool & Nursery",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
