import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "mcpgw-theme";
const listeners = new Set<() => void>();

export function initialTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
}

const current = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

function setTheme(t: Theme) {
  localStorage.setItem(KEY, t);
  applyTheme(t);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Theme lives on <html class="dark">; this hook subscribes to it. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, current);
  return { theme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") };
}
