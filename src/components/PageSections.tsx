"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Section = { id: string; label: string };

function slug(text: string) {
  return text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Builds a "Jump to" bar from the section headings on long pages, so people
// don't have to scroll through every form to find the one they need.
export function PageSections() {
  const pathname = usePathname();
  const [sections, setSections] = useState<Section[]>([]);

  useEffect(() => {
    const headings = Array.from(
      document.querySelectorAll<HTMLElement>(".page-content .section-heading h2"),
    );
    const found: Section[] = [];
    const claimed = new Set<HTMLElement>();
    for (const h2 of headings) {
      // Anchor on the whole card; if another heading already owns it, anchor on the heading.
      const card = h2.closest<HTMLElement>("section, article");
      const target = card && !claimed.has(card) ? card : h2;
      claimed.add(target);
      if (!target.id) {
        const base = slug(h2.textContent ?? "") || "section";
        let id = base;
        for (let n = 2; document.getElementById(id); n++) id = `${base}-${n}`;
        target.id = id;
      }
      found.push({ id: target.id, label: (h2.textContent ?? "").trim() });
    }
    setSections(found.length >= 3 ? found : []);
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [pathname]);

  if (!sections.length) return null;
  return (
    <nav className="jump-bar no-print" aria-label="On this page">
      <span className="jump-label">Jump to</span>
      {sections.map((section) => (
        <a key={section.id} href={"#" + section.id}>{section.label}</a>
      ))}
    </nav>
  );
}
