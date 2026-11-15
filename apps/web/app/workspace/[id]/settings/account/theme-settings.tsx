"use client";

import { useSyncExternalStore } from "react";
import { themeChangeEvent, themePreferences, themeStorageKey } from "../../../../../lib/theme";
import type { ThemePreference } from "../../../../../lib/theme";

const themeLabels = { system: "System", light: "Light", dark: "Dark" } satisfies Record<ThemePreference, string>;

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(themeChangeEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(themeChangeEvent, listener);
  };
}

function preference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return themePreferences.find((candidate) => candidate === stored) ?? "system";
  } catch {
    return "system";
  }
}

function setPreference(value: ThemePreference) {
  localStorage.setItem(themeStorageKey, value);
  window.dispatchEvent(new Event(themeChangeEvent));
}

export function ThemeSettings() {
  const selected = useSyncExternalStore(subscribe, preference, () => "system");
  return (
    <fieldset className="flex flex-wrap gap-2" aria-label="Color theme">
      {themePreferences.map((value) => (
        <label key={value} className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-[var(--workspace-border)] px-3 text-sm has-checked:border-[var(--workspace-accent)] has-checked:bg-[var(--workspace-accent-soft)]">
          <input type="radio" className="accent-[var(--workspace-accent)]" name="tideline-theme" checked={selected === value} onChange={() => setPreference(value)} />
          {themeLabels[value]}
        </label>
      ))}
    </fieldset>
  );
}
