import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/AppShell";
import { THEME_INIT_SCRIPT } from "@/components/ThemeToggle";
import { getAuthContext } from "@/lib/security";
import "./globals.css";

export const metadata: Metadata = {
  title: "Montikids School System",
  description: "Management system for Montikids Montessori Preschool & Nursery",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1417" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const auth = await getAuthContext();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{auth ? <AppShell auth={auth}>{children}</AppShell> : children}</body>
    </html>
  );
}
