import Link from "next/link";
import type { ReactNode } from "react";
import type { AuthContext } from "@/lib/security";

/** Raw Next.js search params as delivered to a page. */
export type SearchParams = Record<string, string | string[] | undefined>;
/** Flattened search params handed to a hub view. */
export type ViewParams = Record<string, string | undefined>;

export type ViewProps = { auth: AuthContext; params: ViewParams };

export type HubView = {
  key: string;
  label: string;
  show: boolean;
  /** Small count or status shown on the button, e.g. open alerts. */
  badge?: ReactNode;
};

export function flattenParams(params: SearchParams): ViewParams {
  const flat: ViewParams = {};
  for (const [key, value] of Object.entries(params)) {
    flat[key] = Array.isArray(value) ? value[0] : value;
  }
  return flat;
}

export function pickView<T extends HubView>(views: T[], requested: string | undefined): T {
  return views.find((view) => view.key === requested) ?? views[0];
}

export function HubHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="hub-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="hub-header-actions no-print">{actions}</div> : null}
    </header>
  );
}

/**
 * One row of buttons that swaps the content below it. Every button is a plain
 * link to `?view=<key>` so the browser back button, bookmarks and refresh keep
 * working. Extra query keys in `keep` (for example a report period) survive
 * the switch.
 */
export function ViewSwitcher({
  base,
  views,
  active,
  keep = {},
  label = "Sections",
}: {
  base: string;
  views: HubView[];
  active: string;
  keep?: ViewParams;
  label?: string;
}) {
  if (views.length < 2) return null;
  const href = (key: string) => {
    const search = new URLSearchParams();
    search.set("view", key);
    for (const [name, value] of Object.entries(keep)) {
      if (value) search.set(name, value);
    }
    return `${base}?${search.toString()}`;
  };
  return (
    <nav className="view-switcher no-print" aria-label={label}>
      {views.map((view) => (
        <Link
          key={view.key}
          href={href(view.key)}
          className={view.key === active ? "view-button active" : "view-button"}
          aria-current={view.key === active ? "page" : undefined}
        >
          <span>{view.label}</span>
          {view.badge !== undefined && view.badge !== null && view.badge !== 0 && view.badge !== "" ? (
            <span className="view-badge">{view.badge}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function Notices({ error, success }: { error?: string; success?: string }) {
  return (
    <>
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      {success ? <div className="notice success" role="status">{success}</div> : null}
    </>
  );
}
