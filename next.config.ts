import type { NextConfig } from "next";

/**
 * Every workspace is now one page with buttons that switch the content.
 * Old bookmarks and links keep working: the query string (for example a
 * success message or a search) is carried over automatically.
 */
const legacyRoutes: Record<string, string> = {
  "/billing": "/money?view=payments",
  "/billing/admin": "/money?view=fees",
  "/operations": "/money?view=suppliers",
  "/rentals": "/money?view=rent",
  "/accounting": "/money?view=accounting",
  "/payroll": "/staff?view=payroll",
  "/food/plans": "/food?view=plans",
  "/food/packages": "/food?view=packages",
  "/food/admin": "/food?view=packages",
  "/food/purchases": "/food?view=purchases",
  "/food/inventory": "/food?view=inventory",
  "/food/alerts": "/food?view=inventory",
  "/inventory": "/food?view=inventory",
  "/analytics": "/reports?view=analytics",
  "/notifications": "/dashboard?view=alerts",
  "/classroom": "/students?view=classroom",
  "/students/admissions": "/students?view=enroll",
};

const nextConfig: NextConfig = {
  async redirects() {
    return Object.entries(legacyRoutes).map(([source, destination]) => ({
      source,
      destination,
      permanent: false,
    }));
  },
};

export default nextConfig;
