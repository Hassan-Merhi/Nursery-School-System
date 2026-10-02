"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

type Theme = "system" | "light" | "dark";
const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

// Runs before first paint (see layout.tsx) so the page never flashes the wrong theme.
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {}
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {}
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  }

  const icon = theme === "light" ? "sun" : theme === "dark" ? "moon" : "monitor";
  return (
    <button type="button" className="ghost-button" onClick={cycle} title="Switch light / dark mode">
      <Icon name={icon} size={18} />
      <span>{LABEL[theme]}</span>
    </button>
  );
}
