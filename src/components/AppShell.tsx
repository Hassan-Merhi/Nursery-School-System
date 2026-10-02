import type { AuthContext } from "@/lib/security";
import { logoutAction } from "@/app/settings/actions";
import { Icon } from "./Icon";
import { visibleNav } from "./nav";
import { PageSections } from "./PageSections";
import { SidebarNav } from "./SidebarNav";
import { ThemeToggle } from "./ThemeToggle";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
}

export function AppShell({ auth, children }: { auth: AuthContext; children: React.ReactNode }) {
  const groups = visibleNav(auth.permissions);
  return (
    <div className="shell">
      <input type="checkbox" id="nav-toggle" className="nav-toggle" aria-hidden="true" tabIndex={-1} />
      <aside className="sidebar no-print">
        <a href="/dashboard" className="sidebar-brand">
          <span className="brand-dot">M</span>
          <span>
            <strong>Montikids</strong>
            <small>School system</small>
          </span>
        </a>
        <SidebarNav groups={groups} />
        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="avatar">{initials(auth.fullName)}</span>
            <span>
              <strong>{auth.fullName}</strong>
              <small>{auth.roles.join(", ") || "No role"}</small>
            </span>
          </div>
          <form action={logoutAction}>
            <button type="submit" className="ghost-button full">
              <Icon name="logout" size={18} />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </aside>
      <label htmlFor="nav-toggle" className="scrim no-print" aria-hidden="true" />
      <div className="shell-main">
        <header className="shell-topbar no-print">
          <label htmlFor="nav-toggle" className="ghost-button menu-button" aria-label="Open menu">
            <Icon name="menu" />
            <span>Menu</span>
          </label>
          <span className="topbar-school">Montikids Montessori Preschool &amp; Nursery</span>
          <ThemeToggle />
        </header>
        <div className="page-content">
          <PageSections />
          {children}
        </div>
      </div>
    </div>
  );
}
