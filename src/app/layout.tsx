import type { Metadata } from "next";
import { AppNavigation } from "@/components/app-navigation";
import { getAuthContext } from "@/lib/security";
import "./globals.css";

export const metadata: Metadata = {
  title: "Montikids School System",
  description: "Management system for Montikids Montessori Preschool & Nursery",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const auth = await getAuthContext();

  return (
    <html lang="en">
      <body>
        {auth ? <AppNavigation permissions={auth.permissions} /> : null}
        {children}
      </body>
    </html>
  );
}
