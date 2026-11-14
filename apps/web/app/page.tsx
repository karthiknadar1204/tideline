import { Show } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import { healthResponse } from "@tideline/contracts";

async function isApiOnline() {
  try {
    const origin = process.env.TIDELINE_API_URL ?? "http://127.0.0.1:3001";
    const response = await fetch(new URL("/health", origin), {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });

    return response.ok && healthResponse.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

export default async function Home() {
  const apiOnline = await isApiOnline();

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-5 px-8">
      <h1 className="text-5xl font-semibold tracking-tight">Tideline</h1>
      <p className="text-lg">See what your coding agents did.</p>
      <Suspense>
        <div className="flex flex-wrap items-center gap-4">
          <Show when="signed-out">
            <Link className="rounded-md border border-current px-4 py-2 font-medium" href="/sign-in">Sign in</Link>
            <Link className="underline underline-offset-4" href="/sign-up">Create an account</Link>
          </Show>
          <Show when="signed-in">
            <Link className="rounded-md border border-current px-4 py-2 font-medium" href="/workspaces">Open workspace</Link>
          </Show>
        </div>
      </Suspense>
      <p className="border-t border-current/15 pt-5 font-mono text-sm">
        {apiOnline ? "API online" : "API unavailable"}
      </p>
    </main>
  );
}
