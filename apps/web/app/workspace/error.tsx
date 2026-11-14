"use client";

export default function WorkspaceError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-8">
      <h1 className="text-2xl font-semibold">Workspace unavailable</h1>
      <p>Check that the Tideline API is running, then try again.</p>
      <button className="self-start rounded-md border border-current px-4 py-2" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
