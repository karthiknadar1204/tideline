"use server";

import { confirmAccountDeletion } from "@tideline/contracts";
import { requestAccountDeletion } from "./account-request";

export type AccountDeleteResult = { kind: "idle" } | { kind: "done" } | { kind: "error"; message: string };

export async function deleteAccount(_previous: AccountDeleteResult, form: FormData): Promise<AccountDeleteResult> {
  const confirmation = confirmAccountDeletion.safeParse({ confirmation: form.get("confirmation") });
  if (!confirmation.success) return { kind: "error", message: "Type DELETE to confirm account deletion." };
  const response = await requestAccountDeletion({ method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(confirmation.data) });
  if (response?.status === 204) return { kind: "done" };
  if (response?.status === 409) return { kind: "error", message: "Your account still owns a team workspace. Review your owned workspaces." };
  if (response?.status === 503) return { kind: "error", message: "Your Tideline data is deleted. Submit again to finish removing your sign-in." };
  return { kind: "error", message: "Could not complete account deletion. Try again." };
}
