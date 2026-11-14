"use server";

import { workspaceResponse, workspaceUsageTargetUpdate } from "@tideline/contracts";
import type { WorkspaceUsageTargetUpdate } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { updateWorkspaceUsageTarget } from "../../../lib/workspace";

export type TargetSaveResult = { kind: "idle" | "saved" } | { kind: "error"; message: string };

function usdToCents(amount: FormDataEntryValue | null) {
  if (typeof amount !== "string") return null;
  const value = amount.trim();
  if (!/^(?:\d{1,9}(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) return null;
  const [dollars, cents = ""] = value.split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}

function tokenAmount(amount: FormDataEntryValue | null) {
  if (typeof amount !== "string") return null;
  const value = amount.trim();
  return /^\d{1,13}$/.test(value) ? Number(value) : null;
}

async function saveTarget(id: string, update: WorkspaceUsageTargetUpdate): Promise<TargetSaveResult> {
  if (!workspaceResponse.shape.id.safeParse(id).success) notFound();
  if (!await updateWorkspaceUsageTarget(id, update)) {
    return { kind: "error", message: "Could not save this setting. Try again." };
  }
  revalidatePath(`/workspace/${id}`);
  return { kind: "saved" };
}

export async function saveBudget(id: string, _previous: TargetSaveResult, form: FormData): Promise<TargetSaveResult> {
  if (form.get("intent") === "clear") return saveTarget(id, { kind: "budget", value: null });
  const value = usdToCents(form.get("amount"));
  const update = value === null ? null : workspaceUsageTargetUpdate.safeParse({ kind: "budget", value });
  if (!update?.success) return { kind: "error", message: "Enter a budget from $0.01 to $20,000,000, with up to two decimal places." };
  return saveTarget(id, update.data);
}

export async function saveGoal(id: string, _previous: TargetSaveResult, form: FormData): Promise<TargetSaveResult> {
  if (form.get("intent") === "clear") return saveTarget(id, { kind: "goal", value: null });
  const metric = form.get("metric");
  const amount = form.get("amount");
  const target = metric === "cost" ? usdToCents(amount) : tokenAmount(amount);
  const update = workspaceUsageTargetUpdate.safeParse({
    kind: "goal",
    value: { metric, target, scope: form.get("scope"), period: form.get("period"), direction: form.get("direction") },
  });
  if (!update.success) {
    return { kind: "error", message: "Choose the goal settings and enter a positive whole token count or a USD amount with up to two decimal places." };
  }
  return saveTarget(id, update.data);
}
