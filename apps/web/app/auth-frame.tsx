import Link from "next/link";
import type { ReactNode } from "react";

export const tidelineAuthAppearance = {
  variables: {
    colorPrimary: "var(--workspace-button)",
    colorPrimaryForeground: "var(--workspace-button-text)",
    colorBackground: "var(--workspace-panel)",
    colorForeground: "var(--workspace-text)",
    colorMutedForeground: "var(--workspace-muted)",
    colorInput: "var(--workspace-bg)",
    colorInputForeground: "var(--workspace-text)",
    borderRadius: "0.75rem",
  },
};

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="tideline-workspace min-h-dvh bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-8">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-[var(--workspace-border)]">
          <Link href="/" className="font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4">Tideline</Link>
          <Link href="/docs/get-started" className="text-sm font-medium text-[var(--workspace-accent)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4">Setup guide</Link>
        </header>
        <main className="grid min-h-[75dvh] place-items-center py-8 sm:py-12">
          {children}
        </main>
      </div>
    </div>
  );
}
