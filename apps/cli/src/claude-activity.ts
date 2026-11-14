import { activityName, MAX_SESSION_ACTIVITY_ITEMS } from "@tideline/contracts";
import type { SessionActivity } from "@tideline/contracts";
import { z } from "zod";
import type { createSessionSafety } from "./session-safety";

const localId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const toolUse = z.object({ type: z.literal("tool_use"), id: localId, name: activityName, input: z.unknown() });
const toolResult = z.object({ type: z.literal("tool_result"), tool_use_id: localId, is_error: z.boolean().optional(), content: z.unknown() });
const resultMetadata = z.object({ status: z.string().optional(), success: z.boolean().optional(), agentId: localId.optional(),
  stdout: z.string().optional(), stderr: z.string().optional(), interrupted: z.boolean().optional() });
const shellInput = z.object({ command: z.string() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const skillInput = z.object({ skill: activityName });
const childInput = z.object({ subagent_type: activityName });
const taskNotification = /^<task-notification>\r?\n<task-id>([A-Za-z0-9_-]+)<\/task-id>\r?\n<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>\r?\n(?:<output-file>[^\r\n]*<\/output-file>\r?\n)?<status>([a-z_]+)<\/status>\r?\n[\s\S]*<\/task-notification>\s*$/;
const slashCommand = /^<command-message>([A-Za-z0-9_.:-]+)<\/command-message>\r?\n<command-name>\/\1<\/command-name>(?:\r?\n|$)/;

type Tool = SessionActivity["tools"][number];
type Skill = SessionActivity["skills"][number];
type Child = SessionActivity["children"][number];
type Call = { tool: Tool; skill?: Skill; child?: Child; agentId?: string };
type ActivityRecord = {
  line: number;
  role: "user" | "assistant";
  content: string | unknown[];
  metadata: unknown;
  isTaskNotification: boolean;
  attributionSkill: unknown;
  uuid: unknown;
  inProject?: boolean;
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

export function createClaudeActivity(safety?: ReturnType<typeof createSessionSafety>) {
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

  function observe({ line, role, content, metadata, isTaskNotification, attributionSkill, uuid, inProject }: ActivityRecord) {
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
        const call: Call = { tool };
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
        if (status !== "unknown" && status !== "running" && call.child.status !== status) {
          call.agentId = match[1];
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

    const results = content.flatMap((block) => {
      const result = toolResult.safeParse(block).data;
      return result ? [result] : [];
    });
    if (!results.length) {
      pendingSlash = undefined;
      return;
    }

    const detail = results.length === 1 ? resultMetadata.safeParse(metadata).data : undefined;
    for (const result of results) {
      const call = calls.get(result.tool_use_id);
      if (!call || call.tool.status !== "called") continue;
      const failed = result.is_error === true || detail?.success === false;
      if (safety && call.tool.name === "Bash") {
        const output = typeof result.content === "string" ? result.content :
          Array.isArray(result.content) ? result.content.map((item) => textBlock.safeParse(item).data?.text ?? "").join("\n") : "";
        safety.result({ id: result.tool_use_id, line, success: !(failed || detail?.interrupted),
          output: [detail?.stdout ?? output, detail?.stderr].filter(Boolean).join("\n") });
      }
      call.tool.status = failed ? "failed" : "returned";
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

  return { observe, observeSlashCompanion, snapshot };
}
