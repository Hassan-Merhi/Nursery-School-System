import { headers } from "next/headers";

const VIEW_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Keeps the user on the hub view they submitted a form from.
 *
 * Server actions redirect to a fixed hub URL such as `/settings?success=…`.
 * When the form was submitted from `/settings?view=access`, this appends
 * `view=access` so the page re-opens on the same button instead of the
 * first one. It never overrides a `view` the caller already chose.
 */
export async function withCurrentView(url: string): Promise<string> {
  try {
    const target = new URL(url, "http://hub.local");
    if (target.searchParams.has("view")) return url;
    const referer = (await headers()).get("referer");
    if (!referer) return url;
    const view = new URL(referer).searchParams.get("view");
    if (!view || !VIEW_RE.test(view)) return url;
    target.searchParams.set("view", view);
    return target.pathname + target.search + target.hash;
  } catch {
    return url;
  }
}
