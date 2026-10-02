"use client";

export function PrintButton({ label = "Print receipt" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()}>
      {label}
    </button>
  );
}
