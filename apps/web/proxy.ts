import { clerkMiddleware } from "@clerk/nextjs/server";
import { workspaceAddress, workspaceAlias, workspaceResponse } from "@tideline/contracts";
import { NextResponse } from "next/server";
import { fetchTidelineApi } from "./lib/workspace";

export default clerkMiddleware(async (auth, request) => {
  const pathname = request.nextUrl.pathname;
  const [, key, suffix] = /^\/workspace\/([^/]+)(\/.*)?$/.exec(pathname) ?? [];
  if (!key) return;
  const id = workspaceResponse.shape.id.safeParse(key).data;
  if (id ? request.method !== "GET" : !workspaceAlias.safeParse(key).success) return;

  const session = await auth();
  if (!session.userId) return session.redirectToSignIn();
  const token = await session.getToken();
  if (!token) return session.redirectToSignIn();
  const reply = await fetchTidelineApi(`/workspaces/address/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!reply?.ok) return;
  const address = workspaceAddress.safeParse(await reply.json().catch(() => null)).data;
  if (!address) return;

  const destination = request.nextUrl.clone();
  if (request.method === "GET" && address.alias && key !== address.alias) {
    destination.pathname = `/workspace/${address.alias}${suffix ?? ""}`;
    return NextResponse.redirect(destination, { headers: { "Cache-Control": "private, no-store" } });
  }
  if (id) return;
  destination.pathname = `/workspace/${address.id}${suffix ?? ""}`;
  return NextResponse.rewrite(destination);
});

export const config = {
  matcher: [
    "/((?!_next|share/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/__clerk/(.*)",
  ],
};
