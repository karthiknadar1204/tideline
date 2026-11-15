import { activityName, MAX_SESSION_ACTIVITY_ITEMS } from "@tideline/contracts";
import type { SessionActivity } from "@tideline/contracts";
import { z } from "zod";
import { fileReplacement, hasSensitiveToolPath } from "./session-capture";
import type { SessionCaptureBuilder } from "./session-capture";
import type { createSessionSafety } from "./session-safety";
import { toolTiming } from "./session-turns";

const localId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const toolUse = z.object({ type: z.literal("tool_use"), id: localId, name: activityName, input: z.unknown() });
const toolResult = z.object({ type: z.literal("tool_result"), tool_use_id: localId, is_error: z.boolean().optional(), content: z.unknown() });
const resultMetadata = z.object({ status: z.string().optional(), success: z.boolean().optional(), agentId: localId.optional(),
  stdout: z.string().optional(), stderr: z.string().optional(), interrupted: z.boolean().optional(),
  persistedOutputPath: z.string().optional(),
});
const patchHunk = z.object({
  oldStart: z.int().nonnegative(), oldLines: z.int().nonnegative(),
  newStart: z.int().nonnegative(), newLines: z.int().nonnegative(),
  lines: z.array(z.string()),
});
const fileResult = z.object({
  type: z.string().optional(), filePath: z.string().optional(), structuredPatch: z.array(patchHunk).optional(),
  originalFile: z.string().optional(), content: z.string().optional(),
  oldString: z.string().optional(), newString: z.string().optional(),
});
const fileInput = z.object({
  file_path: z.string(), old_string: z.string().optional(), new_string: z.string().optional(),
  content: z.string().optional(),
});
const fileTools = new Set(["Edit", "MultiEdit", "Write"]);
const shellInput = z.object({ command: z.string() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const skillInput = z.object({ skill: activityName });
const childInput = z.object({ subagent_type: activityName });
const taskNotification = /^<task-notification>\r?\n<task-id>([A-Za-z0-9_-]+)<\/task-id>\r?\n<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>\r?\n(?:<output-file>[^\r\n]*<\/output-file>\r?\n)?<status>([a-z_]+)<\/status>\r?\n[\s\S]*<\/task-notification>\s*$/;
const slashCommand = /^<command-message>([A-Za-z0-9_.:-]+)<\/command-message>\r?\n<command-name>\/\1<\/command-name>(?:\r?\n|$)/;

type Tool = SessionActivity["tools"][number];
type Skill = SessionActivity["skills"][number];
type Child = SessionActivity["children"][number];
type Call = {
  tool: Tool; startedAt: string; skill?: Skill; child?: Child; agentId?: string; file?: z.infer<typeof fileInput>;
  checkout?: ActivityRecord["checkout"]; privateTool?: boolean;
};
type ActivityRecord = {
  line: number;
  timestamp: string;
  role: "user" | "assistant";
  content: string | unknown[];
  metadata: unknown;
  isTaskNotification: boolean;
  attributionSkill: unknown;
  uuid: unknown;
  inProject?: boolean;
  checkout?: { root: string; workingDirectory: string };
  readToolOutput?: (path: string) => Promise<{ output: string; truncated: boolean } | undefined>;
};

function childStatus(raw: string | undefined): Child["status"] {
  switch (raw) {
    case "async_launched":
    case "running": return "running";
    case "completed": return "completed";
    case "failed":
    case "error": return "failed";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "interrupted": return "stopped";
    default: return "unknown";
  }
}

export function createClaudeActivity(safety?: ReturnType<typeof createSessionSafety>, capture?: SessionCaptureBuilder) {
  const calls = new Map<string, Call>();
  const tools: Tool[] = [];
  const skills: Skill[] = [];
  const children: Child[] = [];
  let pendingSlash: { line: number; name: string; uuid: string; hasCompanion: boolean } | undefined;
  let throughLine = 0;
  let truncated = false;

  function append<T>(rows: T[], row: T) {
    if (rows.length < MAX_SESSION_ACTIVITY_ITEMS) rows.push(row);
    else truncated = true;
  }

  async function observe({ line, timestamp, role, content, metadata, isTaskNotification, attributionSkill, uuid, inProject,
    checkout, readToolOutput }: ActivityRecord) {
    if (role === "assistant") {
      if (pendingSlash?.hasCompanion && attributionSkill === pendingSlash.name) {
        append(skills, { line: pendingSlash.line, name: pendingSlash.name, index: 0, status: "invoked" });
        throughLine = line;
      }
      pendingSlash = undefined;
      if (typeof content === "string") return;
      for (const [index, block] of content.entries()) {
        const parsed = toolUse.safeParse(block).data;
        if (!parsed || calls.has(parsed.id)) continue;
        const { id, name, input } = parsed;
        if (safety && name === "Bash") {
          const command = shellInput.safeParse(input).data?.command;
          if (command) safety.command({ id, command, line, inProject: inProject === true });
        }
        const tool: Tool = { line, index, name, status: "called" };
        const call: Call = { tool, startedAt: timestamp };
        if (capture && tools.length < MAX_SESSION_ACTIVITY_ITEMS) {
          call.privateTool = hasSensitiveToolPath(input);
          if (fileTools.has(name)) {
            call.file = fileInput.safeParse(input).data;
            call.checkout = checkout;
          }
          capture.tool(tool, line, call.privateTool ? { truncated: true } : { input });
        }
        append(tools, tool);
        if (name === "Skill") {
          const skill = skillInput.safeParse(input).data?.skill;
          if (skill) {
            call.skill = { line, index, name: skill, status: "requested" };
            append(skills, call.skill);
          }
        }
        if (name === "Agent" || name === "Task") {
          call.child = { line, index, name: childInput.safeParse(input).data?.subagent_type ?? null, status: "started" };
          append(children, call.child);
        }
        calls.set(id, call);
        throughLine = line;
      }
      return;
    }

    if (typeof content === "string") {
      if (isTaskNotification) {
        const match = taskNotification.exec(content);
        const call = match && calls.get(match[2]);
        if (!match || !localId.safeParse(match[1]).success || !call?.child || (call.agentId && call.agentId !== match[1])) return;
        const status = childStatus(match[3]);
        if (status !== "unknown") call.agentId ??= match[1];
        if (status !== "unknown" && status !== "running" && call.child.status !== status) {
          call.child.status = status;
          throughLine = line;
        }
        return;
      }
      const command = activityName.safeParse(slashCommand.exec(content)?.[1]).data;
      const slashId = localId.safeParse(uuid).data;
      pendingSlash = command && slashId ? { line, name: command, uuid: slashId, hasCompanion: false } : undefined;
      return;
    }

    const results = content.flatMap((block, index) => {
      const result = toolResult.safeParse(block).data;
      return result ? [{ result, index }] : [];
    });
    if (!results.length) {
      pendingSlash = undefined;
      return;
    }

    const detail = results.length === 1 ? resultMetadata.safeParse(metadata).data : undefined;
    for (const { result, index } of results) {
      const call = calls.get(result.tool_use_id);
      if (!call || call.tool.status !== "called") continue;
      const failed = result.is_error === true || detail?.success === false;
      if (safety && call.tool.name === "Bash") {
        const output = typeof result.content === "string" ? result.content :
          Array.isArray(result.content) ? result.content.map((item) => textBlock.safeParse(item).data?.text ?? "").join("\n") : "";
        safety.result({ id: result.tool_use_id, line, success: !(failed || detail?.interrupted),
          output: [detail?.stdout ?? output, detail?.stderr].filter(Boolean).join("\n") });
      }
      if (capture && tools.includes(call.tool)) {
        const shellOutput = detail?.stdout === undefined && detail?.stderr === undefined ? undefined :
          [detail.stdout, detail.stderr].filter(Boolean).join("\n");
        if (call.privateTool || hasSensitiveToolPath(metadata) || hasSensitiveToolPath(result.content)) {
          capture.tool(call.tool, line, { truncated: true });
        } else {
          const persisted = detail?.persistedOutputPath ? await readToolOutput?.(detail.persistedOutputPath) : undefined;
          capture.tool(call.tool, line, {
            output: persisted?.output ?? shellOutput ?? result.content,
            truncated: persisted?.truncated ?? Boolean(detail?.persistedOutputPath),
          });
        }
        const callCheckout = call.checkout ?? checkout;
        if (callCheckout && !failed && !detail?.interrupted && fileTools.has(call.tool.name)) {
          const file = results.length === 1 ? fileResult.safeParse(metadata).data : undefined;
          const path = file?.filePath ?? call.file?.file_path;
          if (path) {
            const added = file?.type === "create";
            const diff = () => file?.structuredPatch?.length ? file.structuredPatch.map((hunk) =>
              `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`).join("\n") :
              call.tool.name === "Write" ? (added || file?.originalFile !== undefined
                ? fileReplacement(added ? undefined : file?.originalFile, file?.content ?? call.file?.content, true) : null) :
              fileReplacement(file?.oldString ?? call.file?.old_string, file?.newString ?? call.file?.new_string);
            capture.file({ ...callCheckout, line, index, path, change: added ? "added" : "modified", diff });
          }
        }
      }
      call.tool.status = failed ? "failed" : "returned";
      const timing = toolTiming(call.startedAt, timestamp);
      if (timing) call.tool.timing = timing;
      if (call.skill) call.skill.status = failed ? "failed" : "invoked";
      if (call.child) {
        const status = failed ? "failed" : childStatus(detail?.status);
        if (call.child.status === "started" || call.child.status === "unknown") call.child.status = status;
        call.agentId ??= detail?.agentId;
      }
      throughLine = line;
    }
  }

  function observeSlashCompanion(parentUuid: unknown) {
    if (pendingSlash && parentUuid === pendingSlash.uuid) pendingSlash.hasCompanion = true;
  }

  function snapshot(lastMessageLine: number): SessionActivity {
    return { throughLine: Math.max(throughLine, lastMessageLine), truncated, tools, skills, children };
  }

  function subagentLinks() {
    const recorded = new Set(children);
    return [...calls.values()].flatMap(({ agentId, child }) => agentId && child && recorded.has(child)
      ? [{ agentId, ...child }] : []);
  }

  return { observe, observeSlashCompanion, snapshot, subagentLinks };
}
