"use client";

function SunIcon() {
  return (
    <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.2 15.1A8.4 8.4 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z" />
    </svg>
  );
}

export function ThemeToggle() {
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    root.style.colorScheme = next;
    try {
      window.localStorage.setItem("montikids-theme", next);
    } catch {
      // Theme still works for this page even when local storage is unavailable.
    }
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label="Switch light or dark mode"
      title="Switch light or dark mode"
    >
      <SunIcon />
      <MoonIcon />
      <span className="sr-only">Switch light or dark mode</span>
    </button>
  );
}
