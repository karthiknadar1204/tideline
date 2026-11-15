"use server";

import { digestSettingsUpdate } from "@tideline/contracts";
import type { DigestCadence } from "@tideline/contracts";
import { redirect } from "next/navigation";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

function readNumber(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : undefined;
}

export async function updateDigestSchedule(workspaceId: string, cadence: DigestCadence, form: FormData) {
  const workspace = encodeURIComponent(workspaceId);
  const settingsPage = `/workspace/${workspace}/settings/digest`;
  const schedule = form.get("intent") === "disable" ? null : {
    weekday: cadence === "daily" ? 0 : readNumber(form, "weekday"),
    hourUtc: readNumber(form, "hour"),
    recipientIds: form.getAll("recipient"),
  };
  const update = digestSettingsUpdate.safeParse({ schedule });
  if (!update.success) redirect(`${settingsPage}?cadence=${cadence}&status=invalid`);
  const response = await fetchWorkspaceResource(`${workspace}/${cadence}-digest/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update.data),
  });
  const status = response?.ok ? schedule ? "saved" : "disabled" : response?.status === 400 ? "invalid" : "failed";
  redirect(`${settingsPage}?cadence=${cadence}&status=${status}`);
}
