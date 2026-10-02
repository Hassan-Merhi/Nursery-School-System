"use client";

import { useEffect } from "react";

const destructive = /^(delete|remove|reverse|void|cancel|archive|deactivate|end\b|terminate|withdraw)/i;

export function UiInteractionGuard() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("button");
      if (!(button instanceof HTMLButtonElement)) return;
      const form = button.closest("form");
      if (!form || button.type === "button") return;

      const label = (button.textContent ?? "").trim();
      const explicit = button.dataset.confirm || form.dataset.confirm;
      if (!explicit && !destructive.test(label)) return;

      const message = explicit || `Confirm “${label}”? This action may change historical or financial records.`;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
