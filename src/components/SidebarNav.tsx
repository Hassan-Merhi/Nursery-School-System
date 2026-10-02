"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";
import type { NavGroup } from "./nav";

function closeDrawer() {
  const toggle = document.getElementById("nav-toggle") as HTMLInputElement | null;
  if (toggle) toggle.checked = false;
}

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <nav className="side-nav" aria-label="Main">
      {groups.map((group) => (
        <div className="side-group" key={group.label}>
          <p className="side-group-label">{group.label}</p>
          <ul>
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={active ? "side-link active" : "side-link"}
                    aria-current={active ? "page" : undefined}
                    onClick={closeDrawer}
                    title={item.hint}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
