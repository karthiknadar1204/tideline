import { z } from "zod";

const blockType = z.object({ type: z.string() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const injectedText = /<(system-reminder|local-command-[a-z-]+|command-[a-z-]+|task-notification|teammate-message|user-prompt-submit-hook|system_warning|available-deferred-tools)(?:\s[^>]*)?>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/giu;
const interruption = /^\[Request (?:interrupted|aborted|cancell?ed) by user(?: for tool use)?\]$/iu;

export function claudeConversationText(role: "user" | "assistant", content: string | unknown[]) {
  if (role === "user" && Array.isArray(content) && content.some((block) => blockType.safeParse(block).data?.type === "tool_result")) return "";
  const parts = typeof content === "string" ? [content] : content.flatMap((block) => {
    const parsed = textBlock.safeParse(block).data;
    return parsed ? [parsed.text] : [];
  });
  return parts.map((part) => part.replace(injectedText, "").trim())
    .filter((part) => part.length > 0 && !interruption.test(part)).join("\n");
}
