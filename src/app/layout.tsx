import type { Metadata } from "next";
import { AppNavigation } from "@/components/app-navigation";
import { getAuthContext } from "@/lib/security";
import { UiInteractionGuard } from "@/components/ui-interaction-guard";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Montikids School System",
  description: "Management system for Montikids Montessori Preschool & Nursery",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const auth = await getAuthContext();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var saved=localStorage.getItem("montikids-theme");var theme=saved==="dark"||saved==="light"?saved:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;}catch(e){document.documentElement.dataset.theme="light";}})();`,
          }}
        />
      </head>
      <body>
        {auth ? <AppNavigation permissions={auth.permissions} roles={auth.roles} /> : <div className="theme-toggle-floating no-print"><ThemeToggle /></div>}
        {children}
        <UiInteractionGuard />
      </body>
    </html>
  );
}
