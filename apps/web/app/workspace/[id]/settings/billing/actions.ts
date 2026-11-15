"use server";

import { billingCheckoutRequest, billingRedirect } from "@tideline/contracts";
import { redirect } from "next/navigation";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

export async function openBilling(workspaceId: string, intent: "checkout" | "portal", form: FormData) {
  const workspace = encodeURIComponent(workspaceId);
  const back = `/workspace/${workspace}/settings/billing`;
  const selected = billingCheckoutRequest.safeParse({ priceId: form.get("price") });
  if (intent === "checkout" && !selected.success) redirect(`${back}?status=failed`);
  const response = await fetchWorkspaceResource(`${workspace}/billing/${intent}`, {
    method: "POST",
    ...(intent === "checkout" && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selected.data),
    }),
  });
  const link = billingRedirect.safeParse(response?.ok ? await response.json().catch(() => null) : null);
  if (!link.success) redirect(`${back}?status=${response?.status === 409 ? "manage" : "failed"}`);
  redirect(link.data.url);
}
