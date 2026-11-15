import { randomBytes } from "node:crypto";
import { cliSetupAuthorization, cliSetupClaimed, cliSetupCode } from "@tideline/contracts";
import type { CliSetupTerminalProgress } from "@tideline/contracts";
import { approveInBrowser, postToTideline, readJson } from "./login";

export async function openSetupConnection(apiOrigin: string, code: string) {
  if (!cliSetupCode.safeParse(code).success) throw new Error("Copy a fresh setup command from Tideline.");
  const writer = randomBytes(32).toString("base64url");
  const response = await postToTideline({
    apiOrigin, path: "/v1/cli/setup/claim", body: JSON.stringify({ code, writer }),
  });
  const claim = cliSetupClaimed.safeParse(response?.ok ? await readJson(response) : null);
  if (!claim.success) {
    throw new Error(response?.status === 404
      ? "The setup code expired or was already used. Copy a fresh command from Tideline."
      : "Could not connect to the workspace setup page. Check your connection and try again.");
  }
  const { id, workspaceId } = claim.data;
  return {
    workspaceId,
    async update(progress: CliSetupTerminalProgress) {
      const result = await postToTideline({
        apiOrigin, path: `/v1/cli/setup/${id}/progress`, body: JSON.stringify({ writer, progress }),
      });
      return result?.ok === true;
    },
    async approve(browser: boolean) {
      const accessToken = await approveInBrowser(browser);
      const result = await postToTideline({
        apiOrigin, path: `/v1/cli/setup/${id}/approve`, accessToken,
        body: JSON.stringify({ writer, workspaceId }),
      });
      const approval = cliSetupAuthorization.safeParse(result?.ok ? await readJson(result) : null);
      if (!approval.success || approval.data.workspaceId !== workspaceId || approval.data.id !== id) {
        if (result?.status === 403) throw new Error("Approve with the account that opened workspace setup, then copy a fresh command.");
        throw new Error("Could not confirm this setup with Tideline. Copy a fresh command and try again.");
      }
      return { accessToken, userId: approval.data.userId };
    },
  };
}

export type SetupConnection = Awaited<ReturnType<typeof openSetupConnection>>;
