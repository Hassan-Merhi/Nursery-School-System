import type { IconName } from "./nav";

export type ExtraIcon = "menu" | "logout" | "sun" | "moon" | "monitor" | "plus" | "arrow";

// Simple line icons (24×24, stroke = currentColor) so they follow the theme.
const PATHS: Record<IconName | ExtraIcon, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V21h14V9.5", "M10 21v-6h4v6"],
  users: ["M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20", "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7", "M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35", "M15.5 4.15a3.5 3.5 0 0 1 0 6.7"],
  receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6", "M9 12h6", "M9 16h3"],
  food: ["M7 3v8a2 2 0 0 0 2 2v8", "M5 3v6", "M9 3v6", "M17 21V3c-2 1-3 4-3 7 0 2 1 3 3 3"],
  box: ["M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z", "M3.5 7.5 12 12l8.5-4.5", "M12 12v9"],
  wallet: ["M4 6h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1z", "M4 6a2 2 0 0 1 2-2h10v2", "M16 13h2"],
  building: ["M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16", "M16 9h2a2 2 0 0 1 2 2v10", "M3 21h18", "M8 7h4", "M8 11h4", "M8 15h4"],
  briefcase: ["M4 7h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1", "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2", "M3 13h18"],
  book: ["M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z", "M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3", "M8 7h8"],
  chart: ["M4 20V4", "M4 20h16", "M8 16v-4", "M12 16V8", "M16 16v-6"],
  trend: ["M3 17l6-6 4 4 8-8", "M15 7h6v6"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8"],
  monitor: ["M3 4h18v12H3z", "M8 20h8", "M12 16v4"],
  plus: ["M12 5v14", "M5 12h14"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
};

export function Icon({ name, size = 20 }: { name: IconName | ExtraIcon; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
    >
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
